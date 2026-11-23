# Spotify Listen Along bot

Posts a message in a channel when a server member starts listening to Spotify, showing the song
(title, artist, album, cover art) and inviting others to join with Discord's **Listen Along**.

## Setup

1. **Create the bot** at <https://discord.com/developers/applications> → New Application → **Bot**.
   - Click **Reset Token** and copy the token.
   - Under **Privileged Gateway Intents**, turn on **Presence Intent**, **Server Members Intent** and
     **Message Content Intent**. Without the first two the bot can't see what anyone is listening
     to; the last one lets it read `!restart`.
2. **Invite the bot**: open this link with your Application ID (General Information page) and pick
   your server. It grants View Channels, Send Messages, Embed Links and Read Message History:
   `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=84992`
3. **Configure**: copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`.
4. **Run** and use `/setchannel` in your server to pick the announcement channel:
   ```
   npm install
   npm start
   ```

## How it works

- Listens to `presenceUpdate` events and looks for a Spotify "Listening" activity.
- Announces only when a member goes from *not listening* → *listening* (pausing/seeking doesn't count),
  with a per-user cooldown (`COOLDOWN_MINUTES`, default 1 minute) so it doesn't spam.
- Set `ANNOUNCE_ON_TRACK_CHANGE=true` to also post on every song change.

## Commands

- `/setchannel channel:#channel` picks where the announcements go in this server. Only members
  with **Manage Server** can use it. The choice is saved in `data/channels.json` and survives
  restarts and updates. Until it's set, the bot only announces if `ANNOUNCE_CHANNEL_ID` is set.

- `/listenalong` posts a Listen Along invite for the song you're playing right now, in the channel
  where you use it.
- `/listenalong user:@someone` posts the invite for what someone else is playing.
- If that person isn't listening to Spotify, only you see a short error message.

Slash commands are registered in each server when the bot starts or joins, so they show up right away.

## Admin: `!restart`

Only Discord user `541010558653169667` can use it; the bot ignores it from anyone else.
It pulls the latest `master` from GitHub, installs dependencies and restarts the bot, then posts
`✅ Back online on <commit>`. Needs the systemd setup in [DEPLOY.md](DEPLOY.md) to come back up.

## Running on a server

See [DEPLOY.md](DEPLOY.md): either a hosting panel like Pterodactyl (main file `index.js`) or a VPS
with systemd like RazzBot. Both pull `master` from GitHub every time the bot starts.

## Limitations

- Bots can't start a Listen Along session for someone; the message tells people to click the member's
  profile and press **Listen Along**. Listen Along needs Spotify Premium for everyone involved.
- Members only show up if they connected Spotify to Discord and have "Display Spotify as your status"
  enabled.
