// Entry point. Hosting panels (Pterodactyl and similar) run `node index.js` from the repo root.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env if there is one. On a panel or under systemd the variables usually come from the
// environment instead, and anything already set there wins over the file.
const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Imported after .env is loaded, because the bot reads its config as soon as it loads.
await import('./src/index.js');
