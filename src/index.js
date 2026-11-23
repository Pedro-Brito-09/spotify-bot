import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { announceRestartDone, pullAndInstall, saveRestartNotice } from './update.js';

// ---------- Config ----------
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
// Also announce every time the song changes (not only when someone starts listening).
const ANNOUNCE_ON_TRACK_CHANGE = process.env.ANNOUNCE_ON_TRACK_CHANGE === 'true';
// Minimum time between two "started listening" announcements for the same user.
const COOLDOWN_MS = Number(process.env.COOLDOWN_MINUTES ?? 1) * 60_000;
// The only user allowed to run !restart.
const ADMIN_USER_ID = '541010558653169667';

if (!TOKEN || !CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN or ANNOUNCE_CHANNEL_ID. Copy .env.example to .env and fill it in.');
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

/** userId -> timestamp of last announcement */
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

// Only slash commands go here; !restart is a prefix command handled in MessageCreate.
// Registering this list also removes any old /restart left over from earlier versions.
const COMMANDS = [listenAlongCommand];

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  const channel = await c.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`ANNOUNCE_CHANNEL_ID ${CHANNEL_ID} is not a text channel the bot can see.`);
  } else {
    console.log(`Announcing in #${channel.name} (${channel.guild?.name})`);
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
});

client.on(Events.MessageCreate, async (message) => {
  // Stays silent for everyone except the admin, like RazzBot.
  if (message.author.id !== ADMIN_USER_ID) return;
  if (message.content.trim() !== '!restart') return;
  await handleRestart(message);
});

/** !restart: pull master, install dependencies, exit. systemd's Restart=always brings the bot back. */
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
  process.exit(0);
}

async function handleListenAlong(interaction) {
  try {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const spotify = getSpotify(interaction.guild.presences.cache.get(user.id));

    if (!member || !spotify) {
      const who = user.id === interaction.user.id ? "You're" : `${user.username} is`;
      await interaction.reply({
        content:
          `${who} not listening to Spotify right now (or Spotify isn't shown on the profile). ` +
          'Make sure Spotify is connected in Discord → Settings → Connections with "Display on profile" enabled.',
        flags: MessageFlags.Ephemeral,
      });
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

    const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    // Only announce members of the server that owns the announcement channel.
    if (!channel?.isTextBased() || channel.guildId !== newPresence.guild.id) return;

    if (startedListening) {
      const last = lastAnnounced.get(member.id) ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return;
    }
    lastAnnounced.set(member.id, Date.now());

    await channel.send(buildMessage(member, newSpotify, startedListening ? 'start' : 'change'));
    console.log(`Announced ${member.user.tag}: ${newSpotify.details} - ${newSpotify.state}`);
  } catch (err) {
    console.error('Failed to handle presence update:', err);
  }
});

client.login(TOKEN);
