// Music genres per artist, from Last.fm's artist tags (Discord doesn't send genres).
// Needs LASTFM_API_KEY (free: https://www.last.fm/api/account/create). Without it, genres are just off.
// Each artist is looked up once and cached in data/genres.json (gitignored).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BOT_DIR } from './update.js';

const API_KEY = (process.env.LASTFM_API_KEY || '').trim();
export const genresEnabled = Boolean(API_KEY);

const FILE = path.join(BOT_DIR, 'data', 'genres.json');
const FOUND_TTL_MS = 30 * 24 * 60 * 60_000; // re-check known artists monthly
const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60_000; // artists Last.fm doesn't know (yet)
const ERROR_BACKOFF_MS = 10 * 60_000; // network/API errors: try again later
const REQUEST_GAP_MS = 250; // Last.fm allows ~5 requests per second
const MAX_GENRES = 3;
const MIN_TAG_COUNT = 15; // Last.fm tag weights go 0-100; low ones are noise

/** artist key -> { genres: [...], at } */
let cache = {};
try {
  cache = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') console.error(`Could not read ${FILE}, starting empty:`, err.message);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(path.dirname(FILE), { recursive: true });
      writeFileSync(`${FILE}.tmp`, JSON.stringify(cache));
      renameSync(`${FILE}.tmp`, FILE);
    } catch (err) {
      console.error('Could not save genres:', err);
    }
  }, 5_000);
  saveTimer.unref?.();
}

const artistKey = (name) => name.trim().toLowerCase();

// Tags that aren't genres: opinions, "seen live", nationalities, decades...
const NOT_GENRES = new Set(
  [
    'seen live', 'favorites', 'favourites', 'favorite', 'favourite', 'my favorite', 'love', 'awesome',
    'beautiful', 'cool', 'albums i own', 'under 2000 listeners', 'spotify', 'all', 'male vocalists',
    'female vocalists', 'male vocalist', 'female vocalist', 'vocalists', 'brazilian', 'brazil', 'brasil',
    'brasileiro', 'brasileira', 'american', 'usa', 'british', 'uk', 'english', 'canadian', 'korean',
    'japanese', 'french', 'german', 'swedish', 'australian', 'portuguese', 'spanish', 'argentina',
    'mexican', 'colombian', 'puerto rico', 'italian', 'irish', 'scottish', 'norwegian', 'nigerian',
  ],
);

/** "Hip-Hop" / "hiphop" / "hip_hop" -> "hip hop" */
function normalizeTag(tag) {
  const t = tag.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { hiphop: 'hip hop', rnb: 'r&b', 'r and b': 'r&b', 'k pop': 'kpop', 'j pop': 'jpop' }[t] ?? t;
}

const LABELS = { mpb: 'MPB', edm: 'EDM', 'r&b': 'R&B', kpop: 'K-pop', jpop: 'J-pop', 'hip hop': 'Hip-hop', idm: 'IDM' };
/** "funk carioca" -> "Funk carioca", "mpb" -> "MPB" */
export const genreLabel = (key) => LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);

function pickGenres(artist, tags) {
  const self = normalizeTag(artist);
  const out = [];
  for (const tag of tags) {
    if (Number(tag.count) < MIN_TAG_COUNT) continue;
    const g = normalizeTag(tag.name ?? '');
    if (!g || g === self || NOT_GENRES.has(g) || /^\d{2,4}s?$/.test(g) || g.length > 30) continue;
    if (!out.includes(g)) out.push(g);
    if (out.length === MAX_GENRES) break;
  }
  return out;
}

// ---------- Requests (one at a time, spaced out) ----------

let queue = Promise.resolve();
const inFlight = new Map();
const failedAt = new Map();

async function requestTags(artist) {
  const url = new URL('https://ws.audioscrobbler.com/2.0/');
  url.search = new URLSearchParams({
    method: 'artist.gettoptags',
    artist,
    autocorrect: '1',
    api_key: API_KEY,
    format: 'json',
  }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const body = await res.json().catch(() => null);
  if (body?.error === 6) return []; // artist not found
  if (!res.ok || !body?.toptags) throw new Error(`Last.fm: ${body?.message ?? res.status}`);
  const tags = body.toptags.tag;
  return Array.isArray(tags) ? tags : tags ? [tags] : [];
}

/** Genres we already know for an artist, or null if we haven't looked them up yet. */
export function getCachedGenres(artist) {
  return cache[artistKey(artist)]?.genres ?? null;
}

/** Look up an artist's genres (cached). Resolves to [] when unknown or genres are off. */
export function fetchGenres(artist) {
  if (!genresEnabled || !artist?.trim()) return Promise.resolve([]);
  const key = artistKey(artist);
  const hit = cache[key];
  const ttl = hit?.genres.length ? FOUND_TTL_MS : NOT_FOUND_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.genres);
  if (Date.now() - (failedAt.get(key) ?? 0) < ERROR_BACKOFF_MS) return Promise.resolve(hit?.genres ?? []);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (queue = queue
    .then(() => requestTags(artist))
    .then((tags) => {
      const genres = pickGenres(artist, tags);
      cache[key] = { genres, at: Date.now() };
      scheduleSave();
      return genres;
    })
    .catch((err) => {
      failedAt.set(key, Date.now());
      console.error(`Could not get genres for "${artist}":`, err.message);
      return hit?.genres ?? [];
    })
    .finally(() => inFlight.delete(key))
    .then((genres) => new Promise((r) => setTimeout(() => r(genres), REQUEST_GAP_MS))));
  inFlight.set(key, job);
  return job;
}

/** Look up many artists in the background (e.g. everyone already in the stats). */
export function prefetchGenres(artists) {
  for (const a of artists) fetchGenres(a);
}

/**
 * Genres of a song's artists, for announcements: waits at most timeoutMs for Last.fm, then
 * uses whatever is cached. Returns up to MAX_GENRES genre keys, main artist first.
 */
export async function genresForArtists(artists, timeoutMs = 3_000) {
  if (!genresEnabled || !artists.length) return [];
  await Promise.race([
    Promise.all(artists.map(fetchGenres)),
    new Promise((r) => setTimeout(r, timeoutMs).unref?.()),
  ]);
  const out = [];
  for (const a of artists) for (const g of getCachedGenres(a) ?? []) if (!out.includes(g)) out.push(g);
  return out.slice(0, MAX_GENRES);
}
