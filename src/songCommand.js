// /musica: info about a song (title, artist, album, length, genres) plus how much this server
// listened to it. Defaults to what you're playing; `busca` searches songs the server has played.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { genreLabel, genresForArtists } from './genres.js';
import { getNowPlaying, getTrackStats, searchTracks } from './stats.js';
import { formatTime } from './statsCommands.js';

const SPOTIFY_GREEN = 0x1db954;
const MEDALS = ['🥇', '🥈', '🥉'];
const SPOTIFY_TRACK_LINK = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/;

export const songCommand = new SlashCommandBuilder()
  .setName('musica')
  .setDescription('Mostra as informações de uma música e quanto o servidor ouviu ela')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o
      .setName('busca')
      .setDescription('Nome, artista ou link do Spotify (padrão: o que você está ouvindo)')
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addUserOption((o) =>
    o.setName('usuario').setDescription('Mostrar a música que essa pessoa está ouvindo agora').setRequired(false),
  );

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function formatLength(ms) {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** Suggestions while typing `busca`: songs this server has listened to. */
export async function handleSongAutocomplete(interaction) {
  const query = interaction.options.getFocused();
  const choices = searchTracks(interaction.guildId, query, 25).map((t) => ({
    name: `${t.title} — ${(t.artists ?? []).join(', ')}`.slice(0, 100),
    value: t.id,
  }));
  await interaction.respond(choices).catch(() => {});
}

/** Turn what was typed in `busca` (a picked suggestion, a Spotify link or free text) into a track ID. */
function resolveQuery(guildId, query) {
  const link = query.match(SPOTIFY_TRACK_LINK);
  if (link) return link[1];
  if (/^[A-Za-z0-9]{22}$/.test(query) && getTrackStats(guildId, query).track) return query; // picked suggestion
  return searchTracks(guildId, query, 1)[0]?.id ?? null;
}

export async function handleSong(interaction) {
  const guildId = interaction.guildId;
  const query = interaction.options.getString('busca')?.trim();
  const user = interaction.options.getUser('usuario');

  let syncId;
  let live = null;
  if (query) {
    syncId = resolveQuery(guildId, query);
    if (!syncId) {
      await interaction.reply({
        content: `Não achei nenhuma música com "${query.slice(0, 100)}" entre as que o servidor já ouviu.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    const who = user ?? interaction.user;
    live = getNowPlaying(guildId, who.id);
    if (!live) {
      await interaction.reply({
        content:
          (who.id === interaction.user.id
            ? 'Você não está ouvindo nada no Spotify agora (ou seu status não está visível).'
            : `${who.username} não está ouvindo nada no Spotify agora.`) +
          ' Use `busca` para procurar uma música que o servidor já ouviu.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    syncId = live.syncId;
  }

  const stats = getTrackStats(guildId, syncId);
  // A playing song has the freshest details; otherwise use what was saved when it was played.
  const info = live ?? stats.track;
  if (!info) {
    await interaction.reply({
      content: 'Ainda não conheço essa música: ninguém do servidor ouviu ela enquanto eu estava online.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const artists = info.artists ?? [];
  const genres = await genresForArtists(artists, 2_500);
  const trackUrl = `https://open.spotify.com/track/${syncId}`;

  const embed = new EmbedBuilder()
    .setColor(SPOTIFY_GREEN)
    .setTitle(info.title ?? 'Música desconhecida')
    .setURL(trackUrl)
    .addFields({ name: artists.length > 1 ? 'Artistas' : 'Artista', value: artists.join(', ') || '?', inline: true });
  if (info.album) embed.addFields({ name: 'Álbum', value: info.album, inline: true });
  const length = info.length ?? stats.track?.length;
  if (length) embed.addFields({ name: 'Duração', value: formatLength(length), inline: true });
  if (genres.length) {
    embed.addFields({ name: genres.length === 1 ? 'Gênero' : 'Gêneros', value: genres.map(genreLabel).join(', '), inline: true });
  }
  if (info.image) embed.setThumbnail(info.image);

  const t = stats.track;
  if (t?.ms > 0) {
    let summary = t.plays
      ? `Tocada ${plural(t.plays, 'vez', 'vezes')} · ${formatTime(t.ms)} ouvidos`
      : `${formatTime(t.ms)} ouvidos`;
    if (stats.rank) summary += `\n#${stats.rank} entre as mais tocadas do servidor`;
    embed.addFields({ name: '📊 No servidor', value: summary });
  } else {
    embed.addFields({ name: '📊 No servidor', value: 'Primeira vez que essa música aparece por aqui! ✨' });
  }
  if (stats.listeners.length) {
    embed.addFields({
      name: '🏆 Quem mais ouviu',
      value: stats.listeners
        .slice(0, 3)
        .map((l, i) => `${MEDALS[i]} <@${l.id}> · ${plural(l.plays, 'vez', 'vezes')} · ${formatTime(l.ms)}`)
        .join('\n'),
    });
  }
  if (stats.listeningNow.length) {
    embed.addFields({
      name: '🎧 Ouvindo agora',
      value: stats.listeningNow.map((id) => `<@${id}>`).join(', ').slice(0, 1024),
    });
  }

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir no Spotify').setURL(trackUrl),
  );
  await interaction.editReply({ embeds: [embed], components: [buttons], allowedMentions: { parse: [] } });
}
