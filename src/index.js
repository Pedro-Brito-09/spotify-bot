import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import path from 'node:path';
import { getChannelId, setChannelId } from './channels.js';
import { announceRestartDone, BOT_DIR, pullAndInstall, saveRestartNotice } from './update.js';

// ---------- Config ----------
// TOKEN is accepted too, since that's the name RazzBot's config uses.
const TOKEN = (process.env.DISCORD_TOKEN || process.env.TOKEN || '').trim();
// Optional fallback for servers that haven't used /setchannel yet.
const DEFAULT_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || null;
// Also announce every time the song changes (not only when someone starts listening).
const ANNOUNCE_ON_TRACK_CHANGE = process.env.ANNOUNCE_ON_TRACK_CHANGE === 'true';
// Minimum time between two "started listening" announcements for the same user.
const COOLDOWN_MS = Number(process.env.COOLDOWN_MINUTES ?? 1) * 60_000;
// The only user allowed to run !restart.
const ADMIN_USER_ID = '541010558653169667';

if (!TOKEN) {
  console.error(
    'Missing DISCORD_TOKEN (or TOKEN). Put it in a .env file next to index.js ' +
      `(looked for ${path.join(BOT_DIR, '.env')}), or set it as an environment variable in your hosting panel.`,
  );
  process.exit(1);
}

const SPOTIFY_GREEN = 0x1db954;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: needed to resolve members
    GatewayIntentBits.GuildPresences, // privileged: needed to see what people are listening to
    GatewayIntentBits.GuildMessages, // for !restart
    GatewayIntentBits.MessageContent, // privileged: needed to read "!restart"
  ],
});

/** "guildId:userId" -> timestamp of last announcement */
const lastAnnounced = new Map();

/** Returns the Spotify activity from a presence, if any. */
function getSpotify(presence) {
  return presence?.activities.find(
    (a) => a.type === ActivityType.Listening && a.name === 'Spotify' && a.syncId,
  );
}

/** "spotify:ab67616d..." -> https://i.scdn.co/image/ab67616d... */
function albumArtUrl(activity) {
  const img = activity.assets?.largeImage;
  return img?.startsWith('spotify:') ? `https://i.scdn.co/image/${img.slice('spotify:'.length)}` : null;
}

function formatDuration(activity) {
  const { start, end } = activity.timestamps ?? {};
  if (!start || !end) return null;
  const totalSec = Math.round((end.getTime() - start.getTime()) / 1000);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

/**
 * mode: 'start'  -> member just started listening
 *       'change' -> member switched songs
 *       'invite' -> someone used /listenalong
 */
function buildMessage(member, spotify, mode = 'start', invitedBy = null) {
  const trackUrl = `https://open.spotify.com/track/${spotify.syncId}`;
  const song = spotify.details ?? 'Unknown song';
  const artists = (spotify.state ?? 'Unknown artist').replaceAll(';', ',');
  const album = spotify.assets?.largeText;
  const duration = formatDuration(spotify);

  const intros = {
    start: `🎧 <@${member.id}> just started listening to Spotify!`,
    change: `🎶 <@${member.id}> is now playing a new song on Spotify!`,
    invite:
      invitedBy && invitedBy.id !== member.id
        ? `📣 <@${invitedBy.id}> is inviting everyone to listen along with <@${member.id}>!`
        : `📣 <@${member.id}> is inviting everyone to listen along!`,
  };
  const intro = intros[mode];

  const embed = new EmbedBuilder()
    .setColor(SPOTIFY_GREEN)
    .setAuthor({ name: member.displayName, iconURL: member.displayAvatarURL() })
    .setTitle(song)
    .setURL(trackUrl)
    .setDescription(
      `${intro}\n\n` +
        `**Want to join the session?** Click on <@${member.id}>'s profile and press ` +
        `**Listen Along** to hear the same music in sync. 🎉\n` +
        `-# Listen Along requires Spotify Premium and a Spotify account connected to Discord.`,
    )
    .addFields({ name: 'Artist', value: artists, inline: true })
    .setFooter({ text: 'Listening on Spotify' })
    .setTimestamp();

  if (album) embed.addFields({ name: 'Album', value: album, inline: true });
  if (duration) embed.addFields({ name: 'Duration', value: duration, inline: true });

  const art = albumArtUrl(spotify);
  if (art) embed.setThumbnail(art);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open in Spotify').setURL(trackUrl),
  );

  return {
    embeds: [embed],
    components: [buttons],
    allowedMentions: { parse: [] }, // show the mention without pinging anyone
  };
}

const listenAlongCommand = new SlashCommandBuilder()
  .setName('listenalong')
  .setDescription('Invite everyone to Listen Along with what you (or someone else) are playing on Spotify')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) =>
    o.setName('user').setDescription('Whose music to share (defaults to you)').setRequired(false),
  );

const setChannelCommand = new SlashCommandBuilder()
  .setName('setchannel')
  .setDescription('Choose the channel where Spotify listening announcements are posted')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // only people who can manage the server
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setDescription('Where to post the announcements')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true),
  );

/** The announcement channel for a server: the one set with /setchannel, else ANNOUNCE_CHANNEL_ID. */
async function getAnnounceChannel(guild) {
  const id = getChannelId(guild.id) ?? DEFAULT_CHANNEL_ID;
  if (!id) return null;
  const channel = await guild.channels.fetch(id).catch(() => null);
  // guild.channels only finds channels in this server, so the env fallback can't leak across servers.
  return channel?.isTextBased() ? channel : null;
}

// Only slash commands go here; !restart is a prefix command handled in MessageCreate.
// Registering this list also removes any old /restart left over from earlier versions.
const COMMANDS = [listenAlongCommand, setChannelCommand];

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) {
    const channel = await getAnnounceChannel(guild);
    console.log(
      channel
        ? `${guild.name}: announcing in #${channel.name}`
        : `${guild.name}: no announcement channel yet, use /setchannel`,
    );
    // 0 here means presences aren't arriving: Presence Intent is off in the Developer Portal.
    console.log(`${guild.name}: can see ${guild.presences.cache.size} member presence(s)`);
  }

  await announceRestartDone(c);

  // Register the slash commands in every server the bot is in (server commands appear instantly).
  for (const guild of c.guilds.cache.values()) {
    await guild.commands
      .set(COMMANDS)
      .catch((err) => console.error(`Could not register commands in ${guild.name}:`, err.message));
  }
});

// Register the commands when the bot joins a new server too.
client.on(Events.GuildCreate, (guild) => {
  guild.commands.set(COMMANDS).catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'listenalong') return handleListenAlong(interaction);
  if (interaction.commandName === 'setchannel') return handleSetChannel(interaction);
});

async function handleSetChannel(interaction) {
  try {
    const channel = interaction.options.getChannel('channel', true);
    const missing = channel
      .permissionsFor(interaction.guild.members.me)
      ?.missing([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]);
    if (missing?.length) {
      await interaction.reply({
        content: `I can't post in <#${channel.id}>. I'm missing: **${missing.join(', ')}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    setChannelId(interaction.guildId, channel.id);
    await interaction.reply({
      content: `✅ Spotify announcements will now be posted in <#${channel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    console.log(`${interaction.guild.name}: announcement channel set to #${channel.name} by ${interaction.user.tag}`);
  } catch (err) {
    console.error('Failed to handle /setchannel:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

client.on(Events.MessageCreate, async (message) => {
  // Stays silent for everyone except the admin, like RazzBot.
  if (message.author.id !== ADMIN_USER_ID) return;
  const content = message.content.trim();
  if (content === '!restart') return handleRestart(message);
  if (content === '!presence' || content.startsWith('!presence ')) return handlePresenceDebug(message);
});

/** userId -> the last raw PRESENCE_UPDATE Discord sent, exactly as received (for !presence). */
const lastRawPresence = new Map();
client.on(Events.Raw, (packet) => {
  if (packet.t !== 'PRESENCE_UPDATE' || !packet.d?.user?.id) return;
  lastRawPresence.set(packet.d.user.id, {
    receivedAt: new Date().toISOString(),
    guild: packet.d.guild_id,
    status: packet.d.status,
    client_status: packet.d.client_status,
    activities: (packet.d.activities ?? []).map((a) => ({ type: a.type, name: a.name, details: a.details, sync_id: a.sync_id })),
  });
});

const summarize = (presence) =>
  presence
    ? {
        status: presence.status,
        clientStatus: presence.clientStatus,
        activities: presence.activities.map((a) => ({ type: a.type, name: a.name, details: a.details, syncId: a.syncId })),
      }
    : null;

/** !presence [@user]: show exactly what Discord tells the bot about someone's status. */
async function handlePresenceDebug(message) {
  if (!message.guild) return;
  const user = message.mentions.users.first() ?? message.author;
  const fetched = await message.guild.members
    .fetch({ user: [user.id], withPresences: true, time: 5_000 })
    .catch((err) => ({ error: err.message }));
  const report = {
    user: user.tag,
    intents: client.options.intents.toArray(),
    cached: summarize(message.guild.presences.cache.get(user.id)),
    fetchedNow: fetched.error ? fetched : summarize(fetched.get(user.id)?.presence),
    lastRawUpdate: lastRawPresence.get(user.id) ?? 'none received since the bot started',
  };
  const json = JSON.stringify(report, null, 2);
  await message.reply(`\`\`\`json\n${json.slice(0, 1900)}\n\`\`\``);
}

/** !restart: pull master, install dependencies, exit. The host (systemd or panel) starts it again. */
async function handleRestart(message) {
  // Typing indicator lasts ~10s, so keep it going while git/npm run.
  message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8_000);
  try {
    const { ok, lines } = await pullAndInstall();
    if (!ok) {
      await message.reply(lines.join('\n'));
      return;
    }
    saveRestartNotice(message.channelId);
    lines.push('🔄 Restarting...');
    await message.reply(lines.join('\n'));
  } catch (err) {
    console.error('Failed to handle !restart:', err);
    await message.reply(`❌ Restart failed: ${err.message}`).catch(() => {});
    return;
  } finally {
    clearInterval(typing);
  }
  await client.destroy();
  // Non-zero on purpose: hosting panels (Pterodactyl) only auto-restart a process that "crashed".
  // systemd's Restart=always brings it back either way.
  process.exit(1);
}

/** Explain why the bot can't see Spotify, based on what it does see. */
function notListeningHelp(you, user, presence) {
  const who = you ? 'you' : user.username;
  const activities = presence?.activities ?? [];
  const seen = activities.map((a) => (a.type === ActivityType.Custom ? 'a custom status' : a.name)).join(', ');

  if (!presence || presence.status === 'offline') {
    return (
      `I can't see ${who} online at all, so I can't see Spotify either. Usually this means:
` +
      `• ${you ? 'Your' : 'Their'} status is set to **Invisible**, or
` +
      `• **Share my activity** is off for this server: right-click the server icon → **Privacy Settings** → turn on **Activity Status**.`
    );
  }
  return (
    `I can see ${who} as **${presence.status}**${seen ? ` with: ${seen}` : ' with no activity'}, but no Spotify. Check that:
` +
    `• **Share my activity** is on for this server: right-click the server icon → **Privacy Settings** → **Activity Status**.
` +
    `• Spotify is connected in **Settings → Connections** with **Display Spotify as your status** on.`
  );
}

async function handleListenAlong(interaction) {
  try {
    const user = interaction.options.getUser('user') ?? interaction.user;
    let member = await interaction.guild.members.fetch(user.id).catch(() => null);
    let presence = interaction.guild.presences.cache.get(user.id);

    // The cached presence can be missing or stale (e.g. right after the bot starts), so ask Discord.
    if (!getSpotify(presence)) {
      const fetched = await interaction.guild.members
        .fetch({ user: [user.id], withPresences: true, time: 5_000 })
        .catch(() => null);
      const fresh = fetched?.get(user.id);
      if (fresh) member = fresh;
      presence = fresh?.presence ?? interaction.guild.presences.cache.get(user.id) ?? presence;
    }
    const spotify = getSpotify(presence);

    if (!member || !spotify) {
      const you = user.id === interaction.user.id;
      await interaction.reply({ content: notListeningHelp(you, user, presence), flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply(buildMessage(member, spotify, 'invite', interaction.user));
  } catch (err) {
    console.error('Failed to handle /listenalong:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
  try {
    const member = newPresence.member;
    if (!member || member.user.bot) return;

    const newSpotify = getSpotify(newPresence);
    if (!newSpotify) return;

    const oldSpotify = getSpotify(oldPresence);
    const startedListening = !oldSpotify;
    const trackChanged = oldSpotify && oldSpotify.syncId !== newSpotify.syncId;

    // Presence updates fire on pause/seek/etc. Only react to real changes.
    if (!startedListening && !(ANNOUNCE_ON_TRACK_CHANGE && trackChanged)) return;

    const channel = await getAnnounceChannel(newPresence.guild);
    if (!channel) return; // no channel set for this server

    const cooldownKey = `${newPresence.guild.id}:${member.id}`;
    if (startedListening) {
      const last = lastAnnounced.get(cooldownKey) ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return;
    }
    lastAnnounced.set(cooldownKey, Date.now());

    await channel.send(buildMessage(member, newSpotify, startedListening ? 'start' : 'change'));
    console.log(`Announced ${member.user.tag}: ${newSpotify.details} - ${newSpotify.state}`);
  } catch (err) {
    console.error('Failed to handle presence update:', err);
  }
});

client.login(TOKEN);
