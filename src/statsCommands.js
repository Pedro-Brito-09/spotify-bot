// /perfil and /ranking: show the listening stats collected by stats.js.
import { EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getProfile, getRanking } from './stats.js';

const SPOTIFY_GREEN = 0x1db954;
const MEDALS = ['🥇', '🥈', '🥉'];

/** 5_400_000 -> "1h 30min" */
export function formatTime(ms) {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (h === 0) return totalMin === 0 ? 'menos de 1min' : `${min}min`;
  return min ? `${h}h ${min}min` : `${h}h`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const trackLabel = (t) => `**${t.title}** — ${(t.artists ?? []).join(', ') || '?'}`;
const position = (i) => MEDALS[i] ?? `\`${i + 1}.\``;

export const profileCommand = new SlashCommandBuilder()
  .setName('perfil')
  .setDescription('Mostra quanto alguém ouviu no Spotify, os artistas e as músicas favoritas')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('usuario').setDescription('De quem é o perfil (padrão: você)').setRequired(false));

export const rankingCommand = new SlashCommandBuilder()
  .setName('ranking')
  .setDescription('Ranking do servidor: quem mais ouviu, artistas e músicas mais tocadas')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o
      .setName('categoria')
      .setDescription('O que ranquear (padrão: tempo ouvido)')
      .setRequired(false)
      .addChoices(
        { name: 'Quem mais ouviu (tempo)', value: 'tempo' },
        { name: 'Quem mais tocou músicas', value: 'musicas' },
        { name: 'Artistas mais ouvidos', value: 'artistas' },
        { name: 'Músicas mais tocadas', value: 'faixas' },
      ),
  );

export async function handleProfile(interaction) {
  const user = interaction.options.getUser('usuario') ?? interaction.user;
  const you = user.id === interaction.user.id;
  const p = getProfile(interaction.guildId, user.id);

  if (!p || p.ms === 0) {
    await interaction.reply({
      content: you
        ? 'Ainda não tenho nada seu. Ouça alguma coisa no Spotify com o status visível e volte depois! 🎧'
        : `Ainda não tenho nada de ${user.username}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const embed = new EmbedBuilder()
    .setColor(SPOTIFY_GREEN)
    .setAuthor({ name: `Perfil de ${member?.displayName ?? user.username}`, iconURL: user.displayAvatarURL() })
    .addFields(
      { name: '⏱️ Tempo ouvido', value: formatTime(p.ms), inline: true },
      { name: '🎵 Músicas tocadas', value: String(p.plays), inline: true },
      { name: '🏆 Ranking', value: `#${p.rank} de ${p.rankedUsers}`, inline: true },
    )
    .setFooter({ text: 'Contando desde' })
    .setTimestamp(p.firstSeen);

  if (p.topArtists.length) {
    embed.addFields({
      name: '🎤 Artistas favoritos',
      value: p.topArtists.map((a, i) => `${position(i)} ${a.name} · ${formatTime(a.ms)}`).join('\n'),
    });
  }
  if (p.topTracks.length) {
    embed.addFields({
      name: '💿 Músicas mais tocadas',
      value: p.topTracks
        .map((t, i) => `${position(i)} ${trackLabel(t)} · ${plural(t.plays, 'vez', 'vezes')}`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  if (p.nowPlaying) {
    embed.addFields({ name: '🎧 Ouvindo agora', value: trackLabel(p.nowPlaying) });
    if (p.nowPlaying.image) embed.setThumbnail(p.nowPlaying.image);
  } else if (p.topTracks[0]?.image) {
    embed.setThumbnail(p.topTracks[0].image);
  }

  await interaction.reply({ embeds: [embed] });
}

const RANKING_TITLES = {
  tempo: '⏱️ Quem mais ouviu',
  musicas: '🎵 Quem mais tocou músicas',
  artistas: '🎤 Artistas mais ouvidos',
  faixas: '💿 Músicas mais tocadas',
};

export async function handleRanking(interaction) {
  const kind = interaction.options.getString('categoria') ?? 'tempo';
  const rows = getRanking(interaction.guildId, kind, 10);

  if (!rows.length) {
    await interaction.reply({
      content: 'Ainda não tenho dados suficientes. Escutem um pouco de Spotify e voltem depois! 🎧',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const line = {
    tempo: (r) => `<@${r.id}> · ${formatTime(r.ms)}`,
    musicas: (r) => `<@${r.id}> · ${plural(r.plays, 'música', 'músicas')}`,
    artistas: (r) => `${r.name} · ${formatTime(r.ms)}`,
    faixas: (r) => `${trackLabel(r)} · ${plural(r.plays, 'vez', 'vezes')}`,
  }[kind];

  const embed = new EmbedBuilder()
    .setColor(SPOTIFY_GREEN)
    .setTitle(`${RANKING_TITLES[kind]} em ${interaction.guild.name}`)
    .setDescription(rows.map((r, i) => `${position(i)} ${line(r)}`).join('\n').slice(0, 4000))
    .setFooter({ text: 'Use /perfil para ver o seu' });
  if (kind === 'faixas' && rows[0].image) embed.setThumbnail(rows[0].image);

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } }); // no pings
}
