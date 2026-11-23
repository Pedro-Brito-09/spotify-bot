# Spotify Listen Along bot

Posts a message in a channel when a server member starts listening to Spotify, showing the song
(title, artist, album, cover art) and inviting others to join with Discord's **Listen Along**.

## Setup

1. **Create the bot** at <https://discord.com/developers/applications> → New Application → **Bot**.
   - Click **Reset Token** and copy the token.
   - Under **Privileged Gateway Intents**, turn on **Presence Intent** and **Server Members Intent**.
     Without these the bot can't see what anyone is listening to.
2. **Invite the bot**: OAuth2 → URL Generator → scopes `bot`; permissions **View Channels**,
   **Send Messages**, **Embed Links**. Open the generated URL and pick your server.
3. **Configure**: copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `ANNOUNCE_CHANNEL_ID`
   (enable Developer Mode in Discord → right-click the channel → Copy Channel ID).
4. **Run**:
   ```
   npm install
   npm start
   ```

## How it works

- Listens to `presenceUpdate` events and looks for a Spotify "Listening" activity.
- Announces only when a member goes from *not listening* → *listening* (pausing/seeking doesn't count),
  with a per-user cooldown (`COOLDOWN_MINUTES`, default 1 minute) so it doesn't spam.
- Set `ANNOUNCE_ON_TRACK_CHANGE=true` to also post on every song change.

## Command

- `/listenalong` posts a Listen Along invite for the song you're playing right now, in the channel
  where you use it.
- `/listenalong user:@someone` posts the invite for what someone else is playing.
- If that person isn't listening to Spotify, only you see a short error message.

- `/restart` (bot admin only) pulls the latest `master` from GitHub, installs dependencies and
  restarts the bot, then posts `✅ Back online on <commit>`. Needs the systemd setup in
  [DEPLOY.md](DEPLOY.md) to come back up.

Commands are registered in each server when the bot starts or joins, so they show up right away.

## Running on a server

See [DEPLOY.md](DEPLOY.md). Like RazzBot, it runs under systemd and pulls `master` from GitHub every
time it starts.

## Limitations

- Bots can't start a Listen Along session for someone; the message tells people to click the member's
  profile and press **Listen Along**. Listen Along needs Spotify Premium for everyone involved.
- Members only show up if they connected Spotify to Discord and have "Display Spotify as your status"
  enabled.
