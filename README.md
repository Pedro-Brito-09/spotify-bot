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
   - Optional, for genres: create a free Last.fm API key at <https://www.last.fm/api/account/create>
     (any app name; the callback URL can stay empty) and set `LASTFM_API_KEY`.
4. **Run** and use `/setchannel` in your server to pick the announcement channel:
   ```
   npm install
   npm start
   ```

## How it works

- Listens to `presenceUpdate` events and looks for a Spotify "Listening" activity.
- Announces when a member starts listening and every time they switch songs. Pausing or seeking
  doesn't count.
- A new song is only posted after the member stays on it for 10 seconds, so skipping through
  songs posts just the one they land on.
- There's no cooldown. The only repeat it skips is the same song announced last for that person,
  so pausing and resuming doesn't post it twice.
- Set `ANNOUNCE_ON_TRACK_CHANGE=false` to only post when someone starts listening.
- With `LASTFM_API_KEY` set, announcements and `/listenalong` also show the song's genres.

### Genres

Discord doesn't send genres, so the bot takes them from the artist's tags on Last.fm (up to 3 per
artist, skipping tags like "seen live", nationalities and decades). Each artist is looked up once
and cached in `data/genres.json` for a month. On startup the bot also looks up every artist already
in the stats, so old listening gets genres too. Artists Last.fm doesn't know just have no genre.
Without the key everything else works the same, just without genres.

## Commands

- `/setchannel channel:#channel` picks where the announcements go in this server. Only members
  with **Manage Server** can use it. The choice is saved in `data/channels.json` and survives
  restarts and updates. Until it's set, the bot only announces if `ANNOUNCE_CHANNEL_ID` is set.

- `/listenalong` posts a Listen Along invite for the song you're playing right now, in the channel
  where you use it.
- `/listenalong user:@someone` posts the invite for what someone else is playing.
- If that person isn't listening to Spotify, only you see a short error message.

- `/perfil [usuario]` shows someone's listening profile: total time, songs played, their position
  in the server ranking, favourite artists and genres, most played songs, and what they're playing now.
- `/ranking [categoria]` shows the server's top 10: who listened the most (time), who played the
  most songs, most listened artists, most listened genres, or most played songs.
- `/musica` shows info about the song you're playing: artist, album, length, genres, how many times
  the server played it, its place in the server's most played songs, its top 3 listeners, and who's
  listening to it right now. `busca:` searches the songs the server has played (with suggestions as
  you type) or takes a Spotify track link; `usuario:@someone` shows what someone else is playing.
- `/compatibilidade usuario:@someone [outro:@someone]` shows how well two people's music taste
  matches (0–100%), with the artists and songs they have in common. Without `outro` it compares you
  with `usuario`. The score is half shared artists (weighted by how much of each person's time
  goes to them), 30% shared genres and 20% shared songs, so people who like the same style through
  different artists still match. Without genre data it's 75% artists and 25% songs. Both need at least 5 minutes of listening counted.

### How stats are counted

- Time counts while someone's Spotify activity is visible to the bot, per server.
- A song counts as played after 30 seconds of listening (like Spotify). Pausing and resuming the
  same song counts once; a song on repeat counts every time.
- Stats are saved to `data/stats.json` every 30 seconds and when the bot stops. Updates from GitHub
  don't touch it; a panel **Reinstall Server** deletes it, so back it up first.
- Members whose activity the bot can't see (privacy settings, invisible) aren't counted.

Slash commands are registered in each server when the bot starts or joins, so they show up right away.

## Admin commands

Only Discord user `541010558653169667` can use these; the bot ignores them from anyone else.

- `!clearcache` forgets the last announced songs and every saved member status, then asks Discord for
  everyone's current status again. `/setchannel` choices are kept.
- `!presence [@user]` shows exactly what Discord sends the bot about someone's status (for
  debugging when Spotify isn't detected).
- `!restart` pulls the latest `master` from GitHub, installs dependencies and restarts the bot, then posts
`✅ Back online on <commit>`. Needs the systemd setup in [DEPLOY.md](DEPLOY.md) to come back up.

## Running on a server

See [DEPLOY.md](DEPLOY.md): either a hosting panel like Pterodactyl (main file `index.js`) or a VPS
with systemd like RazzBot. Both pull `master` from GitHub every time the bot starts.

## Limitations

- Bots can't start a Listen Along session for someone; the message tells people to click the member's
  profile and press **Listen Along**. Listen Along needs Spotify Premium for everyone involved.
- Members only show up if they connected Spotify to Discord and have "Display Spotify as your status"
  enabled.
