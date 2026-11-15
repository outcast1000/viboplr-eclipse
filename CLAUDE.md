# CLAUDE.md

Viboplr plugin `eclipse` ("Eclipse Addons"). Plugin = `index.js` (a function body
returning `{ activate, deactivate, _testHooks }`) + `manifest.json`. Worker runtime
(`"runtime": "worker"`): no `fetch`, only `api.network.fetch`.

A client for the Eclipse Music addon protocol (https://eclipsemusic.app/docs).
The user pastes manifest URLs of addons they choose; the plugin asks them, in the
user's order, for tracks the rest of the playback chain can't play.

## Host surface

| Host API | Id | What |
|---|---|---|
| `playback.onStreamResolve` | `eclipse` | Fallback playback by metadata → `{ url, label }` or `null` (chain moves on) |
| `downloads.onResolveByMetadata` | `eclipse` | The host asks only for a track this resolver is playing (`decideDownload`) |
| `downloads.onGetQualities` | `eclipse` | One option: the file as the addon serves it |
| settings panel | `eclipse-settings` | Addon list: add, test, enable, reorder, remove, each addon's own settings |
| `search.registerProvider` + `onQuery` | `addon-<uid>` | Cmd+K, one provider per enabled addon with `search`; registered at runtime and re-synced on every `save()` |
| `playback.onResolveStreamByUri` | scheme `eclipse` | Plays `eclipse://<addon uid>/<encoded track id>` (search results) |
| `downloads.onResolveByUri` | `eclipse` | Downloads an `eclipse://` track from the addon it names |

The addon uid in an `eclipse://` URI is local to the profile (it never carries
the addon URL). A removed or disabled addon's URIs fail with a reason.

## Rules

- **Never show or log an addon URL.** Personal addon URLs carry a token in the
  path. The view uses `maskUrl`; logs and errors name the addon by its manifest
  `name`. The add field is a password input.
- **Strict matching — a wrong song is worse than none.** `mismatch()` decides:
  version words the request doesn't have (live, karaoke, remix…) refuse, the core
  title must be equal after dropping same-recording suffixes (remaster, radio edit,
  feat.), the artist must match as a whole phrase, and the length must be within
  `DURATION_TOLERANCE_SECS`. A `/resolve` answer is exact by protocol, but one that
  names another song is still refused.
- **Download what played.** The match cache (`matches`, keyed by folded artist +
  title) records the addon and track id playback used; the download fetches a fresh
  `/stream` for that same id. Only after a plugin restart does it search again, in
  the same order.
- **Never decrypt, never imitate Eclipse.** An `encrypted: true` stream is refused.
  An addon answering 401/403 (it requires Eclipse's signed `X-Eclipse-Access`
  token) is reported as unusable here; do not add that header or anything like it.
- **Segmented streams play but don't download.** mpv plays HLS/DASH; a download
  needs one file, so `manifest !== "none"` throws a reason.
- Settings declared by an addon's manifest are sent as query parameters on every
  request (defaults until the user changes them), as Eclipse does.
- Every request has a `timeoutMs`. 503 + `Retry-After` ≤ 10s is retried twice.

## Commands

```
npm test                  # node --test, no dependencies
npm run check             # parse index.js the way the host loads it
node scripts/fake-addon.cjs --file <audio> --title "<t>" --artist "<a>" [--secs N] [--resolve]
                          # a one-track addon on http://localhost:7311/tok-demo/manifest.json
```

`test/harness/sandbox.js` loads `index.js` the way the worker does and shadows the
globals the worker deletes; `test/harness/host.js` is a fake plugin API whose
`network.fetch` is routed to scripted addons in the tests.

## Releasing

Edit the version in `manifest.json` (or `scripts/bump.sh patch`), add a CHANGELOG
section, commit, `git tag vX.Y.Z`, push main + tag. CI tests, signs with the
plugin-signing key (`TAURI_SIGNING_PRIVATE_KEY` secret) and publishes
`eclipse.zip` + `update.json`. Never `gh release create` by hand.
