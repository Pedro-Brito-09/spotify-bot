// Self-update + restart, same flow as RazzBot's !restart:
// pull master -> install dependencies -> exit, and systemd's Restart=always brings the bot back.
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRANCH = process.env.UPDATE_BRANCH || 'master';
// Written just before !restart exits, read on startup to say we're back.
const RESTART_NOTICE_PATH = path.join(BOT_DIR, '.restart_notice.json');

/** Run a command in the bot's folder -> { code, output }. Never throws. */
function run(cmd, args, timeoutMs = 60_000, { shell = false } = {}) {
  return new Promise((resolve) => {
    execFile(
      // With a shell, pass one command string (Node deprecates shell + separate args).
      shell ? [cmd, ...args].join(' ') : cmd,
      shell ? [] : args,
      {
        cwd: BOT_DIR,
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        shell,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (err?.killed) return resolve({ code: null, output: `timed out after ${timeoutMs / 1000}s` });
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: output || err?.message || '' });
      },
    );
  });
}

export const git = (...args) => run('git', args);

export function installDependencies() {
  // npm is npm.cmd on Windows, which only runs through a shell. The args are fixed, so that's safe.
  return run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], 600_000, { shell: process.platform === 'win32' });
}

/** Pull the latest commit and install dependencies. Returns the lines to show in Discord. */
export async function pullAndInstall() {
  const { output: before } = await git('rev-parse', '--short', 'HEAD');
  const pull = await git('pull', '--ff-only', 'origin', BRANCH);
  if (pull.code !== 0) {
    return { ok: false, lines: [`❌ \`git pull\` falhou, não vou reiniciar.\n\`\`\`\n${pull.output.slice(-1800)}\n\`\`\``] };
  }
  const { output: after } = await git('rev-parse', '--short', 'HEAD');

  const lines = [];
  if (before === after) {
    lines.push(`Já está atualizado em \`${after}\`.`);
  } else {
    const { output: log } = await git('log', '--format=- %h %s', `${before}..${after}`);
    lines.push(`Atualizado de \`${before}\` para \`${after}\`:`, log.slice(-1500));
    const { output: changed } = await git('diff', '--name-only', `${before}..${after}`);
    if (changed.split('\n').some((f) => f === 'package.json' || f === 'package-lock.json')) {
      lines.push('📦 As dependências mudaram.');
    }
  }

  // Every time, not only when package files changed: the boot-time updater may have pulled already.
  const install = await installDependencies();
  if (install.code !== 0) {
    lines.push(`❌ \`npm ci\` falhou, não vou reiniciar.\n\`\`\`\n${install.output.slice(-1500)}\n\`\`\``);
    return { ok: false, lines };
  }
  return { ok: true, lines };
}

export function saveRestartNotice(channelId) {
  try {
    writeFileSync(RESTART_NOTICE_PATH, JSON.stringify({ channelId }));
  } catch (err) {
    console.error('Could not save restart notice:', err);
  }
}

/** Tell the channel that ran !restart that the new process is up. */
export async function announceRestartDone(client) {
  let channelId;
  try {
    channelId = JSON.parse(readFileSync(RESTART_NOTICE_PATH, 'utf8')).channelId;
  } catch {
    return; // no pending notice
  } finally {
    rmSync(RESTART_NOTICE_PATH, { force: true });
  }
  const { output: commit } = await git('rev-parse', '--short', 'HEAD');
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(`✅ De volta online em \`${commit}\`.`);
  } catch (err) {
    console.error('Could not announce restart:', err);
  }
}
