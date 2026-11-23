// Announcement channel per server, set with /setchannel and saved to data/channels.json
// (gitignored, so `git pull` on startup never touches it).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BOT_DIR } from './update.js';

const FILE = path.join(BOT_DIR, 'data', 'channels.json');

/** guildId -> channelId */
let channels = {};
try {
  channels = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') console.error(`Could not read ${FILE}, starting empty:`, err.message);
}

export function getChannelId(guildId) {
  return channels[guildId] ?? null;
}

/** channelId null = turn announcements off for that server. */
export function setChannelId(guildId, channelId) {
  if (channelId) channels[guildId] = channelId;
  else delete channels[guildId];
  mkdirSync(path.dirname(FILE), { recursive: true });
  // Write to a temp file and rename, so a crash mid-write can't leave a broken file.
  writeFileSync(`${FILE}.tmp`, JSON.stringify(channels, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}
