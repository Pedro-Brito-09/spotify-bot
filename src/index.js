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
import dns from 'node:dns';
import path from 'node:path';
import { getChannelId, setChannelId } from './channels.js';
import { genreLabel, genresEnabled, genresForArtists, prefetchGenres } from './genres.js';
import { handleSong, handleSongAutocomplete, songCommand } from './songCommand.js';
import { knownArtists, saveStats, trackListening } from './stats.js';
import {
  compatibilityCommand,
  handleCompatibility,
  handleProfile,
  handleRanking,
  profileCommand,
  rankingCommand,
} from './statsCommands.js';
import { announceRestartDone, BOT_DIR, pullAndInstall, saveRestartNotice } from './update.js';

// Some hosts have broken IPv6; try IPv4 addresses first so connections don't hang.
dns.setDefaultResultOrder('ipv4first');

// ---------- Config ----------
// TOKEN is accepted too, since that's the name RazzBot's config uses.
const TOKEN = (process.env.DISCORD_TOKEN || process.env.TOKEN || '').trim();
// Optional fallback for servers that haven't used /setchannel yet.
const DEFAULT_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || null;
// Also announce every time the song changes (not only when someone starts listening).
// On by default; set ANNOUNCE_ON_TRACK_CHANGE=false to only announce when someone starts listening.
const ANNOUNCE_ON_TRACK_CHANGE = process.env.ANNOUNCE_ON_TRACK_CHANGE !== 'false';
// How long someone has to stay on a new song before it's announced, so skipping doesn't spam.
const SONG_SETTLE_MS = 10_000;
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

/** "guildId:userId" -> Spotify track id of the last song announced for them */
const lastAnnounced = new Map();
/** "guildId:userId" -> timer for an announcement waiting for the song to settle */
const pendingAnnouncements = new Map();

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

/** "Artist A; Artist B" -> ['Artist A', 'Artist B'] */
const splitArtists = (spotify) =>
  (spotify.state ?? '')
    .split(';')
    .map((a) => a.trim())
    .filter(Boolean);

/**
 * mode: 'start'  -> member just started listening
 *       'change' -> member switched songs
 *       'invite' -> someone used /listenalong
 */
function buildMessage(member, spotify, mode = 'start', invitedBy = null, genres = []) {
  const trackUrl = `https://open.spotify.com/track/${spotify.syncId}`;
  const song = spotify.details ?? 'Música desconhecida';
  const artists = (spotify.state ?? 'Artista desconhecido').replaceAll(';', ',');
  const album = spotify.assets?.largeText;
  const duration = formatDuration(spotify);

  const intros = {
    start: `🎧 <@${member.id}> começou a ouvir Spotify!`,
    change: `🎶 <@${member.id}> está tocando uma nova música no Spotify!`,
    invite:
      invitedBy && invitedBy.id !== member.id
        ? `📣 <@${invitedBy.id}> está chamando todo mundo para ouvir junto com <@${member.id}>!`
        : `📣 <@${member.id}> está chamando todo mundo para ouvir junto!`,
  };
  const intro = intros[mode];

  const embed = new EmbedBuilder()
    .setColor(SPOTIFY_GREEN)
    .setAuthor({ name: member.displayName, iconURL: member.displayAvatarURL() })
    .setTitle(song)
    .setURL(trackUrl)
    .setDescription(
      `${intro}\n\n` +
        `**Quer entrar na sessão?** Clique no perfil de <@${member.id}> e aperte ` +
        `**Ouvir junto** para escutar a mesma música ao mesmo tempo. 🎉\n` +
        `-# Ouvir junto precisa de Spotify Premium e de uma conta do Spotify conectada ao Discord.`,
    )
    .addFields({ name: 'Artista', value: artists, inline: true })
    .setFooter({ text: 'Ouvindo no Spotify' })
    .setTimestamp();

  if (album) embed.addFields({ name: 'Álbum', value: album, inline: true });
  if (duration) embed.addFields({ name: 'Duração', value: duration, inline: true });
  if (genres.length) {
    embed.addFields({ name: genres.length === 1 ? 'Gênero' : 'Gêneros', value: genres.map(genreLabel).join(', '), inline: true });
  }

  const art = albumArtUrl(spotify);
  if (art) embed.setThumbnail(art);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir no Spotify').setURL(trackUrl),
  );

  return {
    embeds: [embed],
    components: [buttons],
    allowedMentions: { parse: [] }, // show the mention without pinging anyone
  };
}

const listenAlongCommand = new SlashCommandBuilder()
  .setName('listenalong')
  .setDescription('Chama todo mundo para ouvir junto o que você (ou outra pessoa) está tocando no Spotify')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) =>
    o.setName('user').setNameLocalizations({ 'pt-BR': 'usuario' }).setDescription('De quem é a música (padrão: você)').setRequired(false),
  );

const setChannelCommand = new SlashCommandBuilder()
  .setName('setchannel')
  .setDescription('Escolhe o canal onde os avisos do Spotify são enviados')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // only people who can manage the server
  .addChannelOption((o) =>
    o
      .setName('channel')
      .setNameLocalizations({ 'pt-BR': 'canal' })
      .setDescription('Onde enviar os avisos')
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
const COMMANDS = [listenAlongCommand, setChannelCommand, profileCommand, rankingCommand, compatibilityCommand, songCommand];

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

  // Start counting for people who were already listening when the bot came online.
  for (const guild of c.guilds.cache.values()) {
    for (const presence of guild.presences.cache.values()) {
      const spotify = getSpotify(presence);
      if (spotify && !presence.user?.bot) trackListening(guild.id, presence.userId, spotify);
    }
  }

  // Look up genres for every artist already in the stats, in the background.
  if (genresEnabled) prefetchGenres(knownArtists());
  else console.log('LASTFM_API_KEY not set: genres are off');

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
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'musica') await handleSongAutocomplete(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'listenalong') return handleListenAlong(interaction);
  if (interaction.commandName === 'setchannel') return handleSetChannel(interaction);
  try {
    if (interaction.commandName === 'perfil') return await handleProfile(interaction);
    if (interaction.commandName === 'ranking') return await handleRanking(interaction);
    if (interaction.commandName === 'compatibilidade') return await handleCompatibility(interaction);
    if (interaction.commandName === 'musica') return await handleSong(interaction);
  } catch (err) {
    console.error(`Failed to handle /${interaction.commandName}:`, err);
    if (interaction.deferred) await interaction.editReply({ content: 'Algo deu errado.' }).catch(() => {});
    else if (!interaction.replied) {
      await interaction.reply({ content: 'Algo deu errado.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

const PERMISSION_NAMES = { ViewChannel: 'Ver canal', SendMessages: 'Enviar mensagens', EmbedLinks: 'Inserir links' };

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
        content: `Não consigo enviar mensagens em <#${channel.id}>. Falta a permissão: **${missing.map((p) => PERMISSION_NAMES[p] ?? p).join(', ')}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    setChannelId(interaction.guildId, channel.id);
    await interaction.reply({
      content: `✅ Os avisos do Spotify agora vão ser enviados em <#${channel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    console.log(`${interaction.guild.name}: announcement channel set to #${channel.name} by ${interaction.user.tag}`);
  } catch (err) {
    console.error('Failed to handle /setchannel:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: 'Algo deu errado.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

client.on(Events.MessageCreate, async (message) => {
  // Stays silent for everyone except the admin, like RazzBot.
  if (message.author.id !== ADMIN_USER_ID) return;
  const content = message.content.trim();
  if (content === '!restart') return handleRestart(message);
  if (content === '!presence' || content.startsWith('!presence ')) return handlePresenceDebug(message);
  if (content === '!clearcache') return handleClearCache(message);
});

/**
 * !clearcache: forget the last announced songs and every cached presence/member, then re-fetch this server's
 * members with fresh presences from Discord. /setchannel choices are settings, so they stay.
 */
async function handleClearCache(message) {
  const remembered = lastAnnounced.size;
  const rawUpdates = lastRawPresence.size;
  lastAnnounced.clear();
  lastRawPresence.clear();

  let presences = 0;
  let members = 0;
  for (const guild of client.guilds.cache.values()) {
    presences += guild.presences.cache.size;
    members += guild.members.cache.size;
    guild.presences.cache.clear();
    // Keep the bot's own member: permission checks (e.g. /setchannel) need it.
    guild.members.cache.sweep((_member, id) => id !== client.user.id);
  }

  let refetched = 'fora de um servidor, nada foi buscado de novo';
  if (message.guild) {
    try {
      const fresh = await message.guild.members.fetch({ withPresences: true, time: 30_000 });
      refetched = `buscados de novo: ${fresh.size} membro(s), ${message.guild.presences.cache.size} com status visível`;
    } catch (err) {
      refetched = `falha ao buscar de novo: ${err.message}`;
    }
  }

  await message.reply(
    `🧹 Cache limpo: ${remembered} última(s) música(s) anunciada(s), ${presences} status, ${members} membro(s), ` +
      `${rawUpdates} atualização(ões) bruta(s).\n${refetched}.`,
  );
}

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
    lastRawUpdate: lastRawPresence.get(user.id) ?? 'nenhuma recebida desde que o bot iniciou',
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
    lines.push('🔄 Reiniciando...');
    await message.reply(lines.join('\n'));
  } catch (err) {
    console.error('Failed to handle !restart:', err);
    await message.reply(`❌ Falha ao reiniciar: ${err.message}`).catch(() => {});
    return;
  } finally {
    clearInterval(typing);
  }
  saveStats();
  await client.destroy();
  // Non-zero on purpose: hosting panels (Pterodactyl) only auto-restart a process that "crashed".
  // systemd's Restart=always brings it back either way.
  process.exit(1);
}

const STATUS_NAMES = { online: 'online', idle: 'ausente', dnd: 'não perturbe', offline: 'offline' };

/** Explain why the bot can't see Spotify, based on what it does see. */
function notListeningHelp(you, user, presence) {
  const who = you ? 'você' : user.username;
  const activities = presence?.activities ?? [];
  const seen = activities.map((a) => (a.type === ActivityType.Custom ? 'um status personalizado' : a.name)).join(', ');
  const sharing =
    '**Compartilhar atividade** precisa estar ligado neste servidor: clique com o botão direito no ícone do servidor → ' +
    '**Configurações de privacidade** → ative **Status de atividade**.';

  if (!presence || presence.status === 'offline') {
    return (
      `Não consigo ver ${who} online, então também não vejo o Spotify. Normalmente é porque:\n` +
      `• ${you ? 'Seu' : 'O'} status está como **Invisível**, ou\n` +
      `• ${sharing}`
    );
  }
  const status = STATUS_NAMES[presence.status] ?? presence.status;
  return (
    `Vejo ${who} como **${status}**${seen ? ` com: ${seen}` : ' sem nenhuma atividade'}, mas sem Spotify. Confira:\n` +
    `• ${sharing}\n` +
    '• O Spotify está conectado em **Configurações → Conexões** com **Exibir Spotify como seu status** ligado.'
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

    await interaction.deferReply();
    const genres = await genresForArtists(splitArtists(spotify), 2_500);
    await interaction.editReply(buildMessage(member, spotify, 'invite', interaction.user, genres));
  } catch (err) {
    console.error('Failed to handle /listenalong:', err);
    if (interaction.deferred) await interaction.editReply({ content: 'Algo deu errado.' }).catch(() => {});
    else if (!interaction.replied) {
      await interaction.reply({ content: 'Algo deu errado.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
  try {
    if (newPresence.user?.bot || newPresence.member?.user.bot) return;
    const newSpotify = getSpotify(newPresence);
    trackListening(newPresence.guild.id, newPresence.userId, newSpotify ?? null);

    const member = newPresence.member;
    if (!member || !newSpotify) return;

    const oldSpotify = getSpotify(oldPresence);
    const startedListening = !oldSpotify;
    const trackChanged = oldSpotify && oldSpotify.syncId !== newSpotify.syncId;

    // Presence updates fire on pause/seek/etc. Only react to real changes.
    if (!startedListening && !(ANNOUNCE_ON_TRACK_CHANGE && trackChanged)) return;

    const key = `${newPresence.guild.id}:${member.id}`;

    // A new song waits SONG_SETTLE_MS before posting, and any newer song replaces the wait.
    // Skipping through several songs only announces the one the person stays on.
    clearTimeout(pendingAnnouncements.get(key));
    pendingAnnouncements.set(
      key,
      setTimeout(
        () => announce(newPresence.guild, member.id, newSpotify.syncId, startedListening ? 'start' : 'change'),
        startedListening ? 0 : SONG_SETTLE_MS,
      ),
    );
  } catch (err) {
    console.error('Failed to handle presence update:', err);
  }
});

/** Post the announcement if the member is still on the same song. */
async function announce(guild, memberId, syncId, mode) {
  const key = `${guild.id}:${memberId}`;
  pendingAnnouncements.delete(key);
  try {
    const spotify = getSpotify(guild.presences.cache.get(memberId));
    if (!spotify || spotify.syncId !== syncId) return; // stopped or skipped while we waited
    // Same song as the last announcement (e.g. paused and resumed): don't post it twice.
    if (lastAnnounced.get(key) === syncId) return;

    const channel = await getAnnounceChannel(guild);
    if (!channel) return; // no channel set for this server

    const member = await guild.members.fetch(memberId);
    lastAnnounced.set(key, syncId);
    const genres = await genresForArtists(splitArtists(spotify));
    await channel.send(buildMessage(member, spotify, mode, null, genres));
    console.log(`Announced ${member.user.tag}: ${spotify.details} - ${spotify.state}`);
  } catch (err) {
    console.error('Failed to announce:', err);
  }
}

// Save stats when the host stops the bot (panel stop button, systemctl stop, Ctrl+C).
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    saveStats();
    process.exit(0);
  });
}

// ---------- Staying connected ----------
// On a flaky network the websocket library can throw "Opening handshake has timed out" outside of
// discord.js's error handling, which would crash the bot on the spot. Log it and give discord.js a
// chance to reconnect by itself; the watchdog below restarts the process if it doesn't.
const NETWORK_ERROR = /handshake has timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|socket hang up/i;
const RECOVER_AFTER_NETWORK_ERROR_MS = 2 * 60_000;
const RECOVER_MS = 5 * 60_000;
let lastNetworkError = 0;

process.on('uncaughtException', (err) => {
  if (NETWORK_ERROR.test(`${err.message} ${err.code ?? ''}`)) {
    console.error(`Network error talking to Discord (${err.message}), waiting for it to reconnect...`);
    lastNetworkError = Date.now();
    return;
  }
  console.error('Crashed:', err);
  saveStats();
  process.exit(1); // the panel / systemd starts it again
});
process.on('unhandledRejection', (err) => console.error('Unhandled error:', err));

// If the bot stays disconnected, restart the whole process (exit code 1 -> the panel starts it again).
let disconnectedSince = null;
setInterval(() => {
  if (client.isReady()) {
    if (disconnectedSince) console.log('Connected to Discord again');
    disconnectedSince = null;
    return;
  }
  disconnectedSince ??= Date.now();
  const limit = Date.now() - lastNetworkError < RECOVER_MS ? RECOVER_AFTER_NETWORK_ERROR_MS : RECOVER_MS;
  if (Date.now() - disconnectedSince > limit) {
    console.error(`Not connected to Discord for ${limit / 60_000} minutes, restarting.`);
    saveStats();
    process.exit(1);
  }
}, 15_000).unref();

client.login(TOKEN).catch((err) => {
  console.error('Could not log in to Discord:', err.message);
  saveStats();
  process.exit(1);
});
