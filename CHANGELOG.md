# Changelog

## v0.2.0
- Search your addons from Cmd+K: each enabled addon that can search gets its own “Search “x” on <addon>” row. Results play and download straight from that addon.
- Search results are `eclipse://` tracks, so a queue entry keeps pointing at the same recording on the same addon.

## v0.1.0
- First release: Eclipse addons you add yourself as a fallback playback source and downloader.
- Addon list in Extensions → Eclipse Addons → Configuration: add by manifest URL, test, enable, reorder, remove, and each addon's own settings.
- Strict matching by title, artist and length; `/resolve` used first when an addon offers it.
- Downloads fetch the same recording from the addon that played it.
