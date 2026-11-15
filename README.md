# Eclipse Addons for Viboplr

A [Viboplr](https://github.com/outcast1000/viboplr) plugin that uses
[Eclipse Music](https://eclipsemusic.app) addons as a **fallback playback source**
and **downloader**.

An Eclipse addon is a small web server that answers a simple protocol (search,
resolve, stream). This plugin speaks that protocol, so an addon you already use
with Eclipse can work in Viboplr too.

- **Fallback playback.** When nothing earlier in your playback order can play a
  track, Viboplr asks your enabled addons, in your order, for the same song (by
  title, artist and length) and plays the first match.
- **Download.** A track that played through an addon can be downloaded from the
  now-playing bar: the same recording, from the same addon, saved as the file the
  addon serves (FLAC, M4A, MP3…).
- **Search.** Each enabled addon gets a row in Cmd+K ("Search “x” on <addon>").
  Results play and download straight from that addon.
- **Your addons, your order.** Add as many as you like, test each one, turn them
  on and off, reorder them, and set the options each addon declares.

## Setup

1. Install the plugin, then open **Extensions → Eclipse Addons → Configuration**.
2. Paste an addon's manifest URL (it ends in `/manifest.json`) and press **Add**.
3. Press **Test**.
4. In **Settings → Providers**, place **Eclipse addons** where you want it in the
   playback order, usually after your library and other sources.

## Good to know

- **Addons are third-party services.** This plugin ships with none and doesn't
  recommend any. When it looks a track up, the addon receives the title, artist
  and length. Only add addons you trust and are allowed to use.
- **Matching is strict.** Live versions, karaoke, remixes, covers, other artists
  and different lengths are refused. A track no addon can match exactly stays
  unplayed rather than playing the wrong song.
- **Your addon URLs stay private.** They often carry a personal token, so they're
  never shown in full or written to logs.
- **Some addons only work inside Eclipse.** An addon that requires Eclipse's
  signed access token refuses other players. The plugin reports this and doesn't
  try to get around it.
- **Encrypted streams aren't played.** Segmented (HLS/DASH) streams play but can't
  be downloaded as one file.

## Development

```
npm test
node scripts/fake-addon.cjs --file ~/Music/song.flac --title "Song" --artist "Artist"
```

The fake addon serves one file you own at
`http://localhost:7311/tok-demo/manifest.json`.

GPL-3.0-or-later.
