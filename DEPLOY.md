# Deploying the Spotify bot

Two options: a **hosting panel** (Pterodactyl and similar: paths like `/home/container`) or your
own **Linux VPS with systemd** (same setup as RazzBot).

## Hosting panel (Pterodactyl)

Use a Node.js egg/server, Node **20.12 or newer**. In the server's **Startup** tab:

| Setting | Value |
|---|---|
| Git Repo Address | `https://github.com/Pedro-Brito-09/spotify-bot.git` |
| Install Branch | `master` |
| Auto Update | `1` (on): pulls `master` every time the server starts |
| Main file / Bot JS file | `index.js` |
| Git Username / Access Token | only if the repo is private |

Then create a `.env` file in `/home/container` with the **File Manager** (same contents as
`.env.example`, at least `DISCORD_TOKEN`). The bot reads it itself. Then pick the announcement
channel in Discord with `/setchannel`; it's saved in `data/channels.json`, which updates don't touch
(a **Reinstall Server** does wipe it).

If the files were there before you set the Git address, run **Settings → Reinstall Server** so the
panel clones the repo (back up your `.env` first).

`!restart` pulls, runs `npm ci`, and exits with code 1 so the panel's crash detection starts it
again. If the bot stays offline after `!restart`, start it from the panel; the code it pulled is
already installed.

---

## Linux VPS with systemd

Same setup as RazzBot: runs under systemd as an unprivileged `spotifybot` user, restarts on
crash and on reboot, and **pulls `master` from GitHub every time it starts**.

Target: Ubuntu 24.04. Needs **Node.js 20+** (Ubuntu's own `nodejs` package is too old).

## 1. Packages

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node --version   # v22.x
```

## 2. Service user + code

```bash
sudo useradd --system --home /opt/spotify-bot --shell /usr/sbin/nologin spotifybot
sudo mkdir -p /opt/spotify-bot
sudo chown spotifybot:spotifybot /opt/spotify-bot
sudo -u spotifybot git clone https://github.com/Pedro-Brito-09/spotify-bot.git /opt/spotify-bot
sudo -u spotifybot env npm_config_cache=/opt/spotify-bot/.npm npm ci --omit=dev --prefix /opt/spotify-bot
```

If the repo is private, the `spotifybot` user needs read access (a deploy key or a token in the
remote URL), otherwise the boot-time pull fails and the bot keeps running old code.

## 3. Secrets

```bash
sudo tee /etc/spotify-bot.env >/dev/null <<'EOF'
DISCORD_TOKEN=your_discord_bot_token_here
ANNOUNCE_ON_TRACK_CHANGE=true
COOLDOWN_MINUTES=1
EOF
sudo chown root:spotifybot /etc/spotify-bot.env
sudo chmod 640 /etc/spotify-bot.env
```

No quotes around values: systemd's `EnvironmentFile` does not strip them.

## 4. systemd

```bash
sudo cp /opt/spotify-bot/spotify-bot-update.service /etc/systemd/system/
sudo cp /opt/spotify-bot/spotify-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now spotify-bot
```

Every start of `spotify-bot.service`, including after a reboot, first runs
`spotify-bot-update.service`: `git pull --ff-only origin master` and then `npm ci`. If the update
fails (GitHub or network down), systemd logs it and starts the version already installed.

Check it:

```bash
systemctl status spotify-bot
journalctl -u spotify-bot -f
```

You want `Logged in as ...` in the log.

## Updating

Push to `master`, then either:

- **From Discord:** `!restart`. It pulls `master`, runs `npm ci`, and exits; systemd brings it back
  and the bot posts `✅ Back online on <commit>` in the same channel. If the pull or install fails,
  the bot keeps running the old code and posts the error. Only user `541010558653169667` can run it;
  the bot ignores it from anyone else.
- **From SSH:** `sudo systemctl restart spotify-bot` (runs the updater first).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Used disallowed intents` | Presence, Server Members or Message Content Intent is off in the Developer Portal |
| `An invalid token was provided` | `DISCORD_TOKEN` is wrong or has quotes around it |
| `!restart` says `git pull` failed | Local changes in `/opt/spotify-bot`, or no access to a private repo |
| `!restart` does nothing | Message Content Intent is off, or the bot can't see that channel |
| `!restart` exits but the bot doesn't come back | It isn't running under systemd (e.g. `npm start` by hand) |
