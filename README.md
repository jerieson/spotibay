# Spotibay

**Listen to music together, in sync.**

Spotibay is a small web app for listening parties. Open a room, share the link, and everyone hears the same song at the same moment, whether they are in the same room or on the other side of the world.

## What you can do

- **Jump straight in.** No sign-up and no email. You get a random name and avatar, and you can change both.
- **Start a room.** Public rooms show up on the home page. Private rooms are invite-only and can have a password.
- **Build the queue together.** Paste a YouTube link or search for a song (suggestions with album art appear as you type), vote tracks up or down, and vote to skip.
- **Take turns.** Fair mode rotates between everyone who added songs, and the host can make friends DJs.
- **Chat and react.** Talk in the room chat and send emoji reactions that float over the player.
- **Keep your music.** Save playlists and liked songs, look back at what you listened to, import a YouTube playlist, and share playlists with a link.

## Your account

There is no password. Instead you get a **recovery code**, which lets you use the same account on another browser or device. Keep it somewhere safe: without it, an account can't be recovered. Making a new code signs you out everywhere else.

## How playback works

Music plays through YouTube's official embedded player, right in each listener's browser. Spotibay never streams or stores audio; it only keeps everyone's players in time.

A few things to know:

- Some videos can't be played outside YouTube, so they are skipped.
- Listeners without YouTube Premium may see ads, and they catch up when the ad ends.
- Phones usually pause YouTube when the screen locks or the browser goes to the background.
- Song search is lightly rate limited, and pasting a link always works.

## YouTube quota

YouTube's API allows 10,000 units a day, and each typed search costs 100. To stretch that:

- A suggested song someone has already added is free for everyone after.
- New suggested songs are looked up on [MusicBrainz](https://musicbrainz.org) by their ISRC first, which costs no search. Only some songs have their YouTube upload listed there.
- With an `ODESLI_API_KEY` (ask developers@song.link), [Odesli](https://odesli.co) is asked too, which knows far more songs. Strongly recommended: every song it matches saves a 100-unit search.
- Autoplay uses free matches first and may spend only a few searches a day on songs nobody has matched yet (admin setting `search.autoplaySearchesPerDay`, default 15).
- When the day's quota runs out, songs already in Spotibay keep working, and search says when it comes back (midnight Pacific Time).
- For more headroom, ask Google for a higher limit with the [YouTube API quota extension form](https://support.google.com/youtube/contact/yt_api_form). Don't spread the load over several API keys: YouTube's developer policies forbid it.

## About

Spotibay is a personal, self-hosted project.

## Credits

- Reaction emoji: [Noto Emoji Animation](https://googlefonts.github.io/noto-emoji-animation/) by Google, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Resized for the web.
- Song info: [Deezer](https://www.deezer.com). Top songs chart: [Apple Music](https://music.apple.com). Song links: [MusicBrainz](https://musicbrainz.org) and [Odesli](https://odesli.co). Similar songs: [Last.fm](https://www.last.fm). GIFs and stickers: [KLIPY](https://klipy.com).
