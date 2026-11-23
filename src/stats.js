// Listening stats per server: time listened and plays, per member, artist and track.
// Saved to data/stats.json (gitignored, so `git pull` on startup never touches it).
//
// How time is counted: while someone has a Spotify activity, the time between two presence
// updates is credited to them. A "play" is counted when they finish (or leave) a track after
// listening to it for at least MIN_PLAY_MS, like Spotify does.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BOT_DIR } from './update.js';

const FILE = path.join(BOT_DIR, 'data', 'stats.json');
const MIN_PLAY_MS = 30_000;
const SAVE_EVERY_MS = 30_000;
// Without a known track length, never credit more than this between two updates.
const MAX_GAP_MS = 15 * 60_000;

let data = { version: 1, guilds: {} };
try {
  data = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') console.error(`Could not read ${FILE}, starting empty:`, err.message);
}
let dirty = false;

export function saveStats() {
  if (!dirty) return;
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(`${FILE}.tmp`, JSON.stringify(data));
    renameSync(`${FILE}.tmp`, FILE);
    dirty = false;
  } catch (err) {
    console.error('Could not save stats:', err);
  }
}
setInterval(saveStats, SAVE_EVERY_MS).unref();

function guildData(guildId) {
  return (data.guilds[guildId] ??= { users: {}, tracks: {}, artists: {} });
}

function userData(guildId, userId) {
  const g = guildData(guildId);
  return (g.users[userId] ??= { ms: 0, plays: 0, firstSeen: Date.now(), lastSeen: Date.now(), artists: {}, tracks: {} });
}

const artistsOf = (artistString) =>
  (artistString ?? '')
    .split(';')
    .map((a) => a.trim())
    .filter(Boolean);

function trackLength(spotify) {
  const { start, end } = spotify.timestamps ?? {};
  return start && end ? end.getTime() - start.getTime() : null;
}

// ---------- Live sessions ----------

/** "guildId:userId" -> what they're playing right now */
const sessions = new Map();
/** "guildId:userId" -> the play they stopped, so resuming after a pause continues it */
const stopped = new Map();
const RESUME_WINDOW_MS = 30 * 60_000;

function newSession(spotify, now) {
  const art = spotify.assets?.largeImage;
  return {
    syncId: spotify.syncId,
    title: spotify.details ?? '?',
    artists: artistsOf(spotify.state),
    album: spotify.assets?.largeText ?? null,
    image: art?.startsWith('spotify:') ? `https://i.scdn.co/image/${art.slice('spotify:'.length)}` : null,
    length: trackLength(spotify),
    trackStart: spotify.timestamps?.start?.getTime() ?? null,
    lastTick: now,
    playMs: 0, // listened during this play
    counted: false, // play already counted
  };
}

/** Credit the time since the last tick to the member, track and artists. */
function credit(guildId, userId, session, now) {
  let ms = Math.max(0, now - session.lastTick);
  session.lastTick = now;
  // Cap so a missed "stopped" update can't credit hours of silence.
  const limit = session.length ? Math.max(0, session.length + 5_000 - session.playMs) : MAX_GAP_MS;
  ms = Math.min(ms, limit);
  if (ms === 0) return;

  const g = guildData(guildId);
  const u = userData(guildId, userId);
  const t = (g.tracks[session.syncId] ??= { title: session.title, artists: session.artists, ms: 0, plays: 0 });
  Object.assign(t, { title: session.title, artists: session.artists, album: session.album, image: session.image });

  session.playMs += ms;
  u.ms += ms;
  u.lastSeen = now;
  t.ms += ms;
  (u.tracks[session.syncId] ??= { ms: 0, plays: 0 }).ms += ms;
  for (const a of session.artists) {
    (u.artists[a] ??= { ms: 0, plays: 0 }).ms += ms;
    (g.artists[a] ??= { ms: 0, plays: 0 }).ms += ms;
  }

  if (!session.counted && session.playMs >= MIN_PLAY_MS) {
    session.counted = true;
    u.plays += 1;
    t.plays += 1;
    u.tracks[session.syncId].plays += 1;
    for (const a of session.artists) {
      u.artists[a].plays += 1;
      g.artists[a].plays += 1;
    }
  }
  dirty = true;
}

/**
 * Call on every presence update (and at startup) with the member's current Spotify activity,
 * or null when they're not listening.
 */
export function trackListening(guildId, userId, spotify, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const session = sessions.get(key);
  if (session) credit(guildId, userId, session, now);

  if (!spotify) {
    // Discord drops the Spotify activity while paused. Keep the play around in case they resume.
    if (session) stopped.set(key, { session, at: now });
    sessions.delete(key);
    return;
  }

  const start = spotify.timestamps?.start?.getTime() ?? null;
  // Same track restarted from the top (on repeat): the start time jumps forward by about a song.
  const replay =
    session &&
    session.syncId === spotify.syncId &&
    start &&
    session.trackStart &&
    session.length &&
    start - session.trackStart >= session.length - 5_000;

  if (!session) {
    // Resumed the song they paused (not finished yet)? Continue that play instead of counting a new one.
    const prev = stopped.get(key);
    stopped.delete(key);
    const resumable =
      prev &&
      prev.session.syncId === spotify.syncId &&
      now - prev.at < RESUME_WINDOW_MS &&
      (!prev.session.length || prev.session.playMs < prev.session.length - 10_000);
    if (resumable) {
      sessions.set(key, Object.assign(prev.session, { lastTick: now, trackStart: start ?? prev.session.trackStart }));
    } else {
      sessions.set(key, newSession(spotify, now));
    }
  } else if (session.syncId !== spotify.syncId || replay) {
    sessions.set(key, newSession(spotify, now));
  } else {
    session.trackStart = start ?? session.trackStart; // seek/pause moves the start time
  }
}

/** Credit everyone's in-progress listening, so profiles and rankings are up to date. */
function settleAll(now = Date.now()) {
  for (const [key, session] of sessions) {
    const [guildId, userId] = key.split(':');
    credit(guildId, userId, session, now);
  }
}

// ---------- Queries ----------

const top = (obj, by, n) =>
  Object.entries(obj)
    .filter(([, s]) => s[by] > 0) // e.g. skipped songs never make "most played"
    .sort(([, a], [, b]) => b[by] - a[by] || b.ms - a.ms)
    .slice(0, n);

export function getProfile(guildId, userId) {
  settleAll();
  const g = data.guilds[guildId];
  const u = g?.users[userId];
  if (!u) return null;
  const byTime = Object.entries(g.users).sort(([, a], [, b]) => b.ms - a.ms);
  return {
    ms: u.ms,
    plays: u.plays,
    firstSeen: u.firstSeen,
    rank: byTime.findIndex(([id]) => id === userId) + 1,
    rankedUsers: byTime.length,
    topArtists: top(u.artists, 'ms', 5).map(([name, s]) => ({ name, ...s })),
    topTracks: top(u.tracks, 'plays', 5).map(([id, s]) => ({ id, ...g.tracks[id], ms: s.ms, plays: s.plays })),
    nowPlaying: sessions.get(`${guildId}:${userId}`) ?? null,
  };
}

/** kind: 'tempo' | 'musicas' (members) or 'artistas' | 'faixas' (server-wide). */
export function getRanking(guildId, kind, n = 10) {
  settleAll();
  const g = data.guilds[guildId];
  if (!g) return [];
  if (kind === 'tempo') return top(g.users, 'ms', n).map(([id, s]) => ({ id, ...s }));
  if (kind === 'musicas') return top(g.users, 'plays', n).map(([id, s]) => ({ id, ...s }));
  if (kind === 'artistas') return top(g.artists, 'ms', n).map(([name, s]) => ({ name, ...s }));
  if (kind === 'faixas') return top(g.tracks, 'plays', n).map(([id, s]) => ({ id, ...s }));
  return [];
}

