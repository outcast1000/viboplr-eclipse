// Viboplr plugin "eclipse" (Eclipse Addons).
//
// A client for the Eclipse Music addon protocol (https://eclipsemusic.app/docs):
// an addon is an HTTPS server answering /manifest.json, /search, /resolve and
// /stream/{id}. The user pastes the manifest URLs of addons they choose; this
// plugin asks them, in the user's order, for a track the rest of Viboplr's
// playback chain could not play, and hands the winning stream to the host.
//
// Contract with the host (worker runtime: no fetch, only api.network.fetch):
// - playback.onStreamResolve("eclipse")   fallback playback by metadata
// - downloads.onResolveByMetadata("eclipse") download of the track that addon is
//   playing (the host only asks for a track this resolver won)
// - settingsPanel "eclipse-settings"      the addon list
//
// Rules (see CLAUDE.md): never log or show an addon URL (they carry tokens),
// match strictly (a wrong song is worse than none), never decrypt anything,
// and never imitate the Eclipse app to an addon that only answers it.

var VIEW = "eclipse-settings";
var RESOLVER = "eclipse";
var STORE_KEY = "addons";

var MANIFEST_TIMEOUT_MS = 10000;
var SEARCH_TIMEOUT_MS = 10000;
var STREAM_TIMEOUT_MS = 10000;
var DURATION_TOLERANCE_SECS = 7;
var MAX_RETRY_AFTER_SECS = 10;
var STREAM_RETRIES = 2;
var STREAM_REUSE_MS = 10 * 60 * 1000;
var MATCH_CACHE_MAX = 300;
var TEST_QUERY = "love";

// A candidate whose title says one of these is another version of the song,
// unless the track asked for says it too.
var OTHER_VERSION_WORDS = [
  "live", "karaoke", "instrumental", "acoustic", "cover", "remix", "demo",
  "sped up", "slowed", "nightcore", "tribute", "8d", "reverb", "a cappella",
  "acapella", "unplugged", "rehearsal",
];

// Version suffixes that name the same recording (dropped on both sides).
var SAME_RECORDING = "remaster|remastered|single version|radio edit|album version|mono|stereo|explicit|clean|bonus track|deluxe|anniversary|edition|original mix|from";

var api = null;
var addons = [];
var loaded = false;
var matches = new Map();
var registeredActions = new Set();
var ui = {
  draft: "",
  addStatus: null,
  adding: false,
  busy: {},
  confirmRemove: null,
};
var saveTimer = null;

// ---------------------------------------------------------------------------
// Small helpers

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function message(e) {
  if (!e) return "unknown error";
  return String(e.message || e);
}

function log(level, text) {
  try { api.log(level, text); } catch (e) { /* logging must never break a resolve */ } // eslint-disable-line no-empty
}

function uid() {
  return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function addonName(addon) {
  return (addon.manifest && addon.manifest.name) || "Unnamed addon";
}

function addonError(addon, text, kind) {
  var e = new Error(addonName(addon) + " " + text);
  e.kind = kind || "error";
  return e;
}

function resources(addon) {
  var list = addon.manifest && Array.isArray(addon.manifest.resources)
    ? addon.manifest.resources
    : ["search", "stream"];
  var out = {};
  list.forEach(function (r) { out[String(r)] = true; });
  return out;
}

// ---------------------------------------------------------------------------
// Addon URLs

function isLocalHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

// Accepts what an author hands out: the manifest URL, or its base. Returns the
// manifest URL, or throws a reason the user can act on.
function normalizeManifestUrl(input) {
  var text = String(input || "").trim();
  if (!text) throw new Error("Paste the addon's manifest URL first.");
  var m = /^(https?):\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i.exec(text);
  if (!m) throw new Error("That isn't a web address. It should start with https://");
  var scheme = m[1].toLowerCase();
  var host = m[2].toLowerCase().replace(/^[^@]*@/, "");
  var hostName = host.replace(/:\d+$/, "");
  if (scheme !== "https" && !isLocalHost(hostName)) {
    throw new Error("Addons must use https:// (plain http:// only works for one on this computer).");
  }
  var path = m[3] || "";
  path = path.replace(/\/+$/, "");
  if (!/\/manifest\.json$/i.test(path)) path += "/manifest.json";
  return scheme + "://" + host + path;
}

function baseUrl(addon) {
  return addon.url.replace(/\/manifest\.json$/i, "");
}

// What the settings panel shows instead of the URL: its host, and an ellipsis
// for any path (where a personal token usually sits).
function maskUrl(url) {
  var m = /^(https?:\/\/[^\/]+)(\/.*)?$/i.exec(url || "");
  if (!m) return "";
  var path = (m[2] || "").replace(/\/manifest\.json$/i, "");
  return m[1] + (path ? "/…" : "") + "/manifest.json";
}

function settingValues(addon) {
  var out = {};
  var decl = addon.manifest && Array.isArray(addon.manifest.settings) ? addon.manifest.settings : [];
  decl.forEach(function (s) {
    if (!s || !s.key) return;
    var v = addon.values && Object.prototype.hasOwnProperty.call(addon.values, s.key)
      ? addon.values[s.key]
      : s.default;
    if (v === undefined || v === null) return;
    out[s.key] = v;
  });
  return out;
}

function buildUrl(addon, path, params) {
  var query = [];
  var settings = settingValues(addon);
  var all = {};
  Object.keys(settings).forEach(function (k) { all[k] = settings[k]; });
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== "") all[k] = params[k];
  });
  Object.keys(all).forEach(function (k) {
    query.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(all[k])));
  });
  return baseUrl(addon) + path + (query.length ? "?" + query.join("&") : "");
}

// ---------------------------------------------------------------------------
// HTTP

async function getJson(addon, url, timeoutMs) {
  var resp;
  try {
    resp = await api.network.fetch(url, {
      headers: { Accept: "application/json" },
      timeoutMs: timeoutMs,
    });
  } catch (e) {
    throw addonError(addon, "didn't answer (" + message(e) + ").", "unreachable");
  }
  var status = resp.status;
  if (status === 401 || status === 403) {
    throw addonError(
      addon,
      "refused the request (HTTP " + status + "). It probably only answers the Eclipse app itself, so it can't be used here.",
      "access",
    );
  }
  if (status === 404) return { status: status, body: null };
  if (status === 503) {
    var ra = parseInt((resp.headers && resp.headers["retry-after"]) || "", 10);
    return { status: status, body: null, retryAfter: isNaN(ra) ? null : ra };
  }
  if (status < 200 || status >= 300) {
    throw addonError(addon, "answered HTTP " + status + ".", "http");
  }
  var body;
  try {
    body = await resp.json();
  } catch (e) {
    throw addonError(addon, "sent an answer that isn't JSON.", "format");
  }
  return { status: status, body: body };
}

function validateManifest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("That address doesn't serve an addon manifest.");
  }
  if (!body.name || typeof body.name !== "string") {
    throw new Error("The manifest has no name, so it isn't an Eclipse addon.");
  }
  var res = Array.isArray(body.resources) ? body.resources.map(String) : [];
  if (body.contentType && body.contentType !== "music") {
    throw new Error(body.name + " serves " + body.contentType + "s, not music.");
  }
  if (res.indexOf("search") < 0 && res.indexOf("resolve") < 0) {
    throw new Error(body.name + " can't search or resolve tracks, so it can't find songs by name.");
  }
  if (res.indexOf("stream") < 0) {
    throw new Error(body.name + " doesn't serve streams.");
  }
  return {
    id: typeof body.id === "string" ? body.id : "",
    name: body.name.slice(0, 80),
    version: typeof body.version === "string" ? body.version.slice(0, 40) : "",
    description: typeof body.description === "string" ? body.description.slice(0, 300) : "",
    resources: res,
    settings: Array.isArray(body.settings) ? body.settings.filter(function (s) {
      return s && typeof s.key === "string" && typeof s.label === "string";
    }) : [],
  };
}

async function fetchManifest(addon) {
  var r = await getJson(addon, addon.url, MANIFEST_TIMEOUT_MS);
  if (r.status === 404) throw new Error("Nothing at that address (HTTP 404). Check the URL.");
  if (r.status === 503) throw new Error("The addon is temporarily unavailable (HTTP 503).");
  return validateManifest(r.body);
}

// ---------------------------------------------------------------------------
// Matching

function fold(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function words(s) {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function coreTitle(title) {
  var t = fold(title);
  t = t.replace(/\s*[\(\[]\s*(feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]/g, "");
  t = t.replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/, "");
  t = t.replace(new RegExp("\\s*[\\(\\[][^\\)\\]]*(" + SAME_RECORDING + ")[^\\)\\]]*[\\)\\]]", "g"), "");
  t = t.replace(new RegExp("\\s+-\\s+[^-]*(" + SAME_RECORDING + ")[^-]*$"), "");
  return words(t);
}

function coreArtist(artist) {
  return words(artist).replace(/^the /, "");
}

function containsPhrase(haystack, needle) {
  return (" " + haystack + " ").indexOf(" " + needle + " ") >= 0;
}

function versionWords(title) {
  var w = " " + words(title) + " ";
  return OTHER_VERSION_WORDS.filter(function (v) { return w.indexOf(" " + v + " ") >= 0; });
}

function candidateSecs(c) {
  if (typeof c.duration === "number" && c.duration > 0) return c.duration;
  if (typeof c.durationMs === "number" && c.durationMs > 0) return c.durationMs / 1000;
  return null;
}

// Why `c` is not the track asked for, or null when it is.
function mismatch(c, q) {
  if (!c || c.id === undefined || c.id === null || !c.title) return "incomplete result";
  var asked = versionWords(q.title);
  var extra = versionWords(c.title).filter(function (v) { return asked.indexOf(v) < 0; });
  if (extra.length) return "another version (" + extra.join(", ") + ")";
  if (coreTitle(c.title) !== coreTitle(q.title)) return "another title";
  if (q.artist) {
    var ca = coreArtist(c.artist);
    var qa = coreArtist(q.artist);
    if (!ca) return "no artist";
    if (ca !== qa && !containsPhrase(ca, qa) && !containsPhrase(qa, ca)) return "another artist";
  }
  var cs = candidateSecs(c);
  if (q.durationSecs && cs && Math.abs(cs - q.durationSecs) > DURATION_TOLERANCE_SECS) {
    return "another length";
  }
  return null;
}

function pickTrack(tracks, q) {
  var best = null;
  var bestDiff = Infinity;
  (tracks || []).forEach(function (c) {
    if (mismatch(c, q)) return;
    var cs = candidateSecs(c);
    var diff = q.durationSecs && cs ? Math.abs(cs - q.durationSecs) : DURATION_TOLERANCE_SECS;
    if (diff < bestDiff) { best = c; bestDiff = diff; }
  });
  return best;
}

function songKey(q) {
  return coreArtist(q.artist) + "\u0000" + coreTitle(q.title);
}

function makeQuery(title, artistName, albumName, durationSecs) {
  var t = String(title || "").trim();
  if (!t) return null;
  return {
    title: t,
    artist: artistName ? String(artistName).trim() : "",
    album: albumName ? String(albumName).trim() : "",
    durationSecs: typeof durationSecs === "number" && durationSecs > 0 ? durationSecs : null,
  };
}

// ---------------------------------------------------------------------------
// Asking one addon

function asTrack(c) {
  return {
    id: String(c.id),
    title: c.title,
    artist: c.artist || "",
    album: c.album || "",
    artworkURL: typeof c.artworkURL === "string" ? c.artworkURL : null,
    streamURL: typeof c.streamURL === "string" ? c.streamURL : null,
    format: typeof c.format === "string" ? c.format : null,
  };
}

async function findOnAddon(addon, q) {
  var res = resources(addon);
  if (res.resolve) {
    var r = await getJson(addon, buildUrl(addon, "/resolve", {
      title: q.title,
      artist: q.artist,
      durationMs: q.durationSecs ? Math.round(q.durationSecs * 1000) : null,
    }), SEARCH_TIMEOUT_MS);
    var item = r.body && r.body.item;
    if (item && item.id !== undefined && item.id !== null) {
      // An exact answer by the protocol; one that names another song is still refused.
      var named = item.title ? item : { id: item.id, title: q.title, artist: item.artist || q.artist };
      if (!mismatch(named, q)) return asTrack(named);
      log("warn", addonName(addon) + ": resolve answered a different track (" + mismatch(named, q) + "), ignored");
    }
  }
  if (res.search) {
    var s = await getJson(addon, buildUrl(addon, "/search", {
      q: q.artist ? q.artist + " " + q.title : q.title,
    }), SEARCH_TIMEOUT_MS);
    var tracks = s.body && Array.isArray(s.body.tracks) ? s.body.tracks : [];
    var pick = pickTrack(tracks, q);
    if (pick) return asTrack(pick);
  }
  return null;
}

async function streamFor(addon, track) {
  if (track.streamURL && /^https?:\/\//i.test(track.streamURL)) {
    return { url: track.streamURL, format: track.format, manifest: "none" };
  }
  for (var attempt = 0; ; attempt++) {
    var r = await getJson(addon, buildUrl(addon, "/stream/" + encodeURIComponent(track.id), {}), STREAM_TIMEOUT_MS);
    if (r.status === 503) {
      var wait = r.retryAfter;
      if (attempt < STREAM_RETRIES && wait !== null && wait <= MAX_RETRY_AFTER_SECS) {
        await sleep(Math.max(1, wait) * 1000);
        continue;
      }
      throw addonError(addon, "isn't ready with this track yet.", "busy");
    }
    if (!r.body) return null;
    var s = r.body;
    if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) {
      throw addonError(addon, "sent no playable address.", "format");
    }
    // Viboplr never decrypts: an encrypted stream is not a stream we can use.
    if (s.encrypted === true) {
      throw addonError(addon, "sent an encrypted stream, which Viboplr doesn't play.", "encrypted");
    }
    return s;
  }
}

// ---------------------------------------------------------------------------
// Stream description

var EXT_BY_KIND = {
  flac: "flac", mp3: "mp3", aac: "m4a", "he-aac": "m4a", m4a: "m4a", alac: "m4a",
  mp4: "m4a", fmp4: "m4a", ogg: "ogg", vorbis: "ogg", opus: "opus", wav: "wav",
};

function extFor(s) {
  var keys = [s.container, s.format, s.codec];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i] && String(keys[i]).toLowerCase();
    if (k && EXT_BY_KIND[k]) return EXT_BY_KIND[k];
  }
  var m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec((s.url || "").replace(/^https?:\/\/[^\/]+/i, ""));
  if (m && EXT_BY_KIND[m[1].toLowerCase()]) return EXT_BY_KIND[m[1].toLowerCase()];
  return null;
}

function qualityLabel(s) {
  var parts = [];
  var kind = s.codec || s.format || s.container;
  if (kind) parts.push(String(kind).toUpperCase());
  if (s.bitDepth) parts.push(s.bitDepth + "-bit");
  if (s.sampleRate) parts.push((s.sampleRate / 1000).toString().replace(/\.0$/, "") + " kHz");
  if (!s.bitDepth && s.quality) parts.push(String(s.quality));
  return parts.join(" · ");
}

function resolverLabel(addon) {
  return "Eclipse · " + addonName(addon);
}

// ---------------------------------------------------------------------------
// Match cache: what each song resolved to, so a download fetches the same
// recording from the same addon that played it.

function remember(key, addon, track, stream) {
  matches.delete(key);
  matches.set(key, { addonUid: addon.uid, track: track, stream: stream, at: Date.now() });
  while (matches.size > MATCH_CACHE_MAX) matches.delete(matches.keys().next().value);
}

function streamStillGood(entry) {
  if (!entry || !entry.stream) return false;
  var s = entry.stream;
  if (typeof s.expiresAt === "number" && s.expiresAt * 1000 < Date.now() + 60000) return false;
  return Date.now() - entry.at < STREAM_REUSE_MS;
}

function enabledAddons() {
  return addons.filter(function (a) { return a.enabled && a.manifest; });
}

function addonByUid(id) {
  for (var i = 0; i < addons.length; i++) if (addons[i].uid === id) return addons[i];
  return null;
}

function noteResult(addon, ok, text) {
  addon.lastUse = { ok: ok, message: text, at: Date.now() };
}

// ---------------------------------------------------------------------------
// Playback

async function resolvePlayback(title, artistName, albumName, durationSecs, opts) {
  await ensureLoaded();
  var q = makeQuery(title, artistName, albumName, durationSecs);
  if (!q) return null;
  var list = enabledAddons();
  if (!list.length) return null;
  var fresh = !!(opts && opts.fresh);
  var key = songKey(q);
  var cached = matches.get(key);

  if (cached && !fresh && streamStillGood(cached)) {
    var owner = addonByUid(cached.addonUid);
    if (owner && owner.enabled) {
      return { url: cached.stream.url, label: resolverLabel(owner) };
    }
  }

  for (var i = 0; i < list.length; i++) {
    var addon = list[i];
    try {
      var track = cached && cached.addonUid === addon.uid ? cached.track : await findOnAddon(addon, q);
      if (!track) continue;
      var stream = await streamFor(addon, track);
      if (!stream) continue;
      remember(key, addon, track, stream);
      noteResult(addon, true, "Played “" + q.title + "”");
      return { url: stream.url, label: resolverLabel(addon) };
    } catch (e) {
      noteResult(addon, false, message(e));
      log("warn", "Eclipse playback lookup failed: " + message(e));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// eclipse:// tracks (search results): "eclipse://<addon uid>/<encoded track id>"

var SCHEME = "eclipse";
var URI_TRACKS_MAX = 500;
var uriTracks = new Map(); // uri → { track, stream, at }

function trackUri(addon, trackId) {
  return SCHEME + "://" + addon.uid + "/" + encodeURIComponent(String(trackId));
}

// Accepts the id the host passes (the part after "eclipse://") or a full URI.
function parseTrackUri(value) {
  var rest = String(value || "").replace(/^eclipse:\/\//i, "");
  var slash = rest.indexOf("/");
  if (slash <= 0) return null;
  var trackId;
  try { trackId = decodeURIComponent(rest.slice(slash + 1)); } catch (e) { return null; }
  if (!trackId) return null;
  return { addonUid: rest.slice(0, slash), trackId: trackId, uri: SCHEME + "://" + rest };
}

function rememberUriTrack(uri, track) {
  var prev = uriTracks.get(uri);
  uriTracks.delete(uri);
  uriTracks.set(uri, { track: track, stream: prev ? prev.stream : null, at: prev ? prev.at : 0 });
  while (uriTracks.size > URI_TRACKS_MAX) uriTracks.delete(uriTracks.keys().next().value);
}

function addonForUri(parsed) {
  var addon = parsed ? addonByUid(parsed.addonUid) : null;
  if (!addon || !addon.manifest) {
    throw new Error("This track came from an Eclipse addon that is no longer in your list.");
  }
  if (!addon.enabled) throw new Error(addonName(addon) + " is turned off in the Eclipse addons settings.");
  return addon;
}

async function streamForUri(value, fresh) {
  await ensureLoaded();
  var parsed = parseTrackUri(value);
  if (!parsed) throw new Error("Not an Eclipse track address.");
  var addon = addonForUri(parsed);
  var known = uriTracks.get(parsed.uri);
  if (known && !fresh && known.stream && streamStillGood({ stream: known.stream, at: known.at })) {
    return { addon: addon, track: known.track, stream: known.stream };
  }
  var track = known ? known.track : { id: parsed.trackId };
  // A fresh ask never reuses the search result's own streamURL: that is the address that failed.
  var stream = await streamFor(addon, fresh ? { id: track.id } : track);
  if (!stream) throw new Error(addonName(addon) + " no longer has this track.");
  rememberUriTrack(parsed.uri, track);
  var entry = uriTracks.get(parsed.uri);
  entry.stream = stream;
  entry.at = Date.now();
  return { addon: addon, track: track, stream: stream };
}

async function resolveUriPlayback(id, quality, opts) {
  try {
    var got = await streamForUri(id, !!(opts && opts.fresh));
    noteResult(got.addon, true, "Played a search result");
    return got.stream.url;
  } catch (e) {
    log("warn", "Eclipse: " + message(e));
    throw e;
  }
}

async function resolveUriDownload(uri) {
  var got = await streamForUri(uri, false);
  return downloadResult(got.addon, got.track, got.stream, {
    title: got.track.title || "",
    artist: got.track.artist || "",
    album: got.track.album || "",
  });
}

// ---------------------------------------------------------------------------
// Cmd+K search: one provider per enabled addon that can search, registered at
// runtime so a provider is only offered while it can answer.

var searchProviders = new Map(); // provider id → name registered

function providerId(addon) {
  return "addon-" + addon.uid;
}

function canSearch() {
  return !!(api && api.search && typeof api.search.registerProvider === "function" && typeof api.search.onQuery === "function");
}

function syncSearchProviders() {
  if (!canSearch()) return;
  var wanted = new Map();
  enabledAddons().forEach(function (a) {
    if (resources(a).search) wanted.set(providerId(a), a);
  });
  searchProviders.forEach(function (name, id) {
    var a = wanted.get(id);
    if (!a || addonName(a) !== name) {
      try { api.search.unregisterProvider(id); } catch (e) { log("error", "Eclipse: removing a search provider failed: " + message(e)); }
      searchProviders.delete(id);
    }
  });
  wanted.forEach(function (a, id) {
    if (searchProviders.has(id)) return;
    try {
      api.search.onQuery(id, function (query, limit) { return searchAddon(a.uid, query, limit); });
      api.search.registerProvider({ id: id, name: addonName(a) });
      searchProviders.set(id, addonName(a));
    } catch (e) {
      log("error", "Eclipse: adding a search provider failed: " + message(e));
    }
  });
}

async function searchAddon(addonUid, query, limit) {
  await ensureLoaded();
  var addon = addonByUid(addonUid);
  if (!addon || !addon.enabled || !addon.manifest) {
    return { status: "error", message: "That Eclipse addon is no longer enabled." };
  }
  var q = String(query || "").trim();
  if (!q) return { status: "empty" };
  try {
    var r = await getJson(addon, buildUrl(addon, "/search", { q: q }), SEARCH_TIMEOUT_MS);
    var raw = r.body && Array.isArray(r.body.tracks) ? r.body.tracks : [];
    var max = typeof limit === "number" && limit > 0 ? limit : 20;
    var tracks = [];
    for (var i = 0; i < raw.length && tracks.length < max; i++) {
      var c = raw[i];
      if (!c || c.id === undefined || c.id === null || !c.title) continue;
      var t = asTrack(c);
      var uri = trackUri(addon, t.id);
      rememberUriTrack(uri, t);
      var secs = candidateSecs(c);
      tracks.push({
        path: uri,
        title: String(t.title),
        artist_name: t.artist || null,
        album_title: t.album || null,
        duration_secs: secs ? Math.round(secs) : null,
        image_url: t.artworkURL && /^https:\/\//i.test(t.artworkURL) ? t.artworkURL : null,
        kind: "audio",
      });
    }
    noteResult(addon, true, "Searched “" + q + "”");
    return tracks.length ? { status: "ok", tracks: tracks } : { status: "empty" };
  } catch (e) {
    noteResult(addon, false, message(e));
    return { status: "error", message: message(e) };
  }
}

// ---------------------------------------------------------------------------
// Downloads

function downloadResult(addon, track, stream, names) {
  if (stream.manifest && stream.manifest !== "none") {
    throw new Error(addonName(addon) + " streams this track in segments (" + String(stream.manifest).toUpperCase() + "), which can't be saved as one file.");
  }
  return {
    url: stream.url,
    ext: extFor(stream),
    quality: qualityLabel(stream) || null,
    metadata: {
      title: names.title || track.title || undefined,
      artist: names.artist || undefined,
      album: names.album || undefined,
      coverUrl: track.artworkURL || undefined,
    },
  };
}

async function resolveDownload(title, artistName, albumName, durationSecs) {
  await ensureLoaded();
  var q = makeQuery(title, artistName, albumName, durationSecs);
  if (!q) throw new Error("This track has no title to look up.");
  var key = songKey(q);
  var entry = matches.get(key);
  var addon = entry ? addonByUid(entry.addonUid) : null;

  if (entry && !addon) {
    throw new Error("The addon that played this track is no longer in your list.");
  }
  if (!entry) {
    // The plugin restarted since the track started: find it again, in the same order playback uses.
    var list = enabledAddons();
    if (!list.length) throw new Error("No Eclipse addon is enabled.");
    for (var i = 0; i < list.length && !entry; i++) {
      var t = await findOnAddon(list[i], q);
      if (t) { addon = list[i]; entry = { track: t }; }
    }
    if (!entry) throw new Error("None of your Eclipse addons has this track.");
  }

  var stream = await streamFor(addon, entry.track);
  if (!stream) throw new Error(addonName(addon) + " no longer has this track.");
  var result = downloadResult(addon, entry.track, stream, q);
  remember(key, addon, entry.track, stream);
  return result;
}

// ---------------------------------------------------------------------------
// Storage

async function ensureLoaded() {
  if (loaded) return;
  var stored = null;
  try {
    stored = await api.storage.get(STORE_KEY);
  } catch (e) {
    log("error", "Eclipse: reading the addon list failed: " + message(e));
  }
  addons = Array.isArray(stored) ? stored.filter(function (a) {
    return a && typeof a.url === "string" && typeof a.uid === "string";
  }).map(function (a) {
    return {
      uid: a.uid,
      url: a.url,
      enabled: a.enabled !== false,
      manifest: a.manifest || null,
      values: a.values && typeof a.values === "object" ? a.values : {},
      lastTest: a.lastTest || null,
    };
  }) : [];
  loaded = true;
}

function persistable() {
  return addons.map(function (a) {
    return { uid: a.uid, url: a.url, enabled: a.enabled, manifest: a.manifest, values: a.values, lastTest: a.lastTest };
  });
}

async function save() {
  syncSearchProviders();
  try {
    await api.storage.set(STORE_KEY, persistable());
  } catch (e) {
    log("error", "Eclipse: saving the addon list failed: " + message(e));
    notify("Couldn't save your Eclipse addons: " + message(e), "error");
  }
}

function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () { saveTimer = null; save(); }, 500);
}

function notify(text, kind) {
  try { api.ui.showNotification(text, { kind: kind || "info" }); } catch (e) { log("error", "Eclipse: notification failed: " + message(e)); }
}

// ---------------------------------------------------------------------------
// Settings actions

async function addAddon() {
  if (ui.adding) return;
  var url;
  try {
    url = normalizeManifestUrl(ui.draft);
  } catch (e) {
    ui.addStatus = { ok: false, message: message(e) };
    render();
    return;
  }
  for (var i = 0; i < addons.length; i++) {
    if (addons[i].url === url) {
      ui.addStatus = { ok: false, message: "That addon is already in your list (" + addonName(addons[i]) + ")." };
      render();
      return;
    }
  }
  ui.adding = true;
  ui.addStatus = { ok: true, message: "Reading the manifest…" };
  render();
  var addon = { uid: uid(), url: url, enabled: true, manifest: null, values: {}, lastTest: null };
  try {
    addon.manifest = await fetchManifest(addon);
    addons.push(addon);
    ui.draft = "";
    ui.addStatus = { ok: true, message: "Added " + addon.manifest.name + ". Test it, then place “Eclipse addons” in Settings → Providers." };
    await save();
  } catch (e) {
    ui.addStatus = { ok: false, message: message(e) };
  }
  ui.adding = false;
  render();
}

async function testAddon(addon) {
  if (ui.busy[addon.uid]) return;
  ui.busy[addon.uid] = true;
  render();
  var started = Date.now();
  var result;
  try {
    addon.manifest = await fetchManifest(addon);
    var res = resources(addon);
    if (res.search) {
      var s = await getJson(addon, buildUrl(addon, "/search", { q: TEST_QUERY }), SEARCH_TIMEOUT_MS);
      var n = s.body && Array.isArray(s.body.tracks) ? s.body.tracks.length : 0;
      result = { ok: true, message: "Working: search answered " + n + " track" + (n === 1 ? "" : "s") + " in " + (Date.now() - started) + " ms." };
    } else {
      result = { ok: true, message: "Manifest read (resolve only, nothing to search)." };
    }
  } catch (e) {
    result = { ok: false, message: message(e) };
  }
  result.at = Date.now();
  addon.lastTest = result;
  ui.busy[addon.uid] = false;
  notify(result.message, result.ok ? "success" : "error");
  await save();
  render();
}

function move(addon, delta) {
  var i = addons.indexOf(addon);
  var j = i + delta;
  if (i < 0 || j < 0 || j >= addons.length) return;
  addons.splice(i, 1);
  addons.splice(j, 0, addon);
  save();
  render();
}

function forgetMatches(addon) {
  matches.forEach(function (v, k) { if (v.addonUid === addon.uid) matches.delete(k); });
  uriTracks.forEach(function (v, k) {
    var p = parseTrackUri(k);
    if (p && p.addonUid === addon.uid) v.stream = null;
  });
}

function removeAddon(addon) {
  var i = addons.indexOf(addon);
  if (i >= 0) addons.splice(i, 1);
  forgetMatches(addon);
  ui.confirmRemove = null;
  save();
  render();
}

function settingDecl(addon, key) {
  var decl = addon.manifest && addon.manifest.settings || [];
  for (var i = 0; i < decl.length; i++) if (decl[i].key === key) return decl[i];
  return null;
}

function setValue(addon, key, raw, redraw) {
  var decl = settingDecl(addon, key);
  if (!decl) return;
  var v = raw;
  if (decl.type === "toggle") v = !!raw;
  if (decl.type === "number") {
    var n = Number(raw);
    v = raw === "" || isNaN(n) ? decl.default : n;
  }
  if (decl.type === "text" && typeof decl.maxLength === "number") v = String(raw || "").slice(0, decl.maxLength);
  addon.values[key] = v;
  forgetMatches(addon);
  if (redraw) { save(); render(); } else { saveSoon(); }
}

// Actions are named "eclipse:<verb>[:<uid>[:<key>]]" so one dispatcher serves
// every addon row; each name is registered with the host once.
function act(name) {
  if (!registeredActions.has(name)) {
    registeredActions.add(name);
    api.ui.onAction(name, function (data) {
      var done = dispatch(name, data);
      if (done && typeof done.then === "function") {
        done.then(null, function (e) { log("error", "Eclipse: " + name.split(":")[1] + " failed: " + message(e)); });
      }
      return done;
    });
  }
  return name;
}

function dispatch(name, data) {
  var parts = name.split(":");
  var verb = parts[1];
  var addon = parts[2] ? addonByUid(parts[2]) : null;
  var value = data && typeof data === "object" && "value" in data ? data.value : data;
  switch (verb) {
    case "draft": ui.draft = String(value || ""); return;
    case "add": return addAddon();
    case "test": return addon ? testAddon(addon) : undefined;
    case "enable":
      if (addon) { addon.enabled = !!value; if (!addon.enabled) forgetMatches(addon); save(); render(); }
      return;
    case "up": if (addon) move(addon, -1); return;
    case "down": if (addon) move(addon, 1); return;
    case "remove": if (addon) { ui.confirmRemove = addon.uid; render(); } return;
    case "remove-yes": if (addon) removeAddon(addon); return;
    case "remove-no": ui.confirmRemove = null; render(); return;
    case "set": if (addon) setValue(addon, parts.slice(3).join(":"), value, false); return;
    case "pick": if (addon) setValue(addon, parts.slice(3).join(":"), value, true); return;
    default: return;
  }
}

// ---------------------------------------------------------------------------
// Settings view

function when(ts) {
  if (!ts) return "";
  var mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  var hours = Math.round(mins / 60);
  if (hours < 48) return hours + " h ago";
  return Math.round(hours / 24) + " days ago";
}

function settingNode(addon, s) {
  var current = settingValues(addon)[s.key];
  var base = "eclipse:";
  if (s.type === "select" && Array.isArray(s.options)) {
    return {
      type: "select",
      label: s.label,
      description: s.help || undefined,
      action: act(base + "pick:" + addon.uid + ":" + s.key),
      value: String(current === undefined ? "" : current),
      options: s.options.filter(function (o) { return o && o.value !== undefined; }).map(function (o) {
        return { value: String(o.value), label: String(o.label || o.value) };
      }),
    };
  }
  if (s.type === "toggle") {
    return {
      type: "toggle",
      label: s.label,
      description: s.help || undefined,
      action: act(base + "pick:" + addon.uid + ":" + s.key),
      checked: current === true || current === "true",
    };
  }
  return {
    type: "settings-row",
    label: s.label,
    description: s.help || undefined,
    control: {
      type: "text-input",
      action: act(base + "set:" + addon.uid + ":" + s.key),
      value: current === undefined ? "" : String(current),
      placeholder: s.placeholder || undefined,
    },
  };
}

function statusLine(addon) {
  var bits = [maskUrl(addon.url)];
  var res = addon.manifest ? addon.manifest.resources.join(", ") : "";
  if (res) bits.push(res);
  var t = addon.lastTest;
  if (t) bits.push((t.ok ? "✓ " : "✗ ") + t.message + " (" + when(t.at) + ")");
  if (addon.lastUse && !addon.lastUse.ok) bits.push("Last lookup failed: " + addon.lastUse.message);
  return bits.join(" · ");
}

function addonNode(addon, index) {
  var children = [
    { type: "text", content: statusLine(addon) },
    {
      type: "toggle",
      label: "Use this addon",
      action: act("eclipse:enable:" + addon.uid),
      checked: addon.enabled,
    },
    {
      type: "toolbar",
      buttons: [
        { label: ui.busy[addon.uid] ? "Testing…" : "Test", action: act("eclipse:test:" + addon.uid), disabled: !!ui.busy[addon.uid] },
        { label: "Move up", action: act("eclipse:up:" + addon.uid), disabled: index === 0 },
        { label: "Move down", action: act("eclipse:down:" + addon.uid), disabled: index === addons.length - 1 },
        { label: "Remove", action: act("eclipse:remove:" + addon.uid) },
      ],
    },
  ];
  if (ui.confirmRemove === addon.uid) {
    children.push({
      type: "confirm",
      title: "Remove " + addonName(addon) + "?",
      message: "Its address and settings are forgotten. You'll need the URL again to add it back.",
      confirmLabel: "Remove",
      confirmVariant: "danger",
      confirmAction: act("eclipse:remove-yes:" + addon.uid),
      cancelAction: act("eclipse:remove-no"),
    });
  }
  var decl = addon.manifest && addon.manifest.settings || [];
  decl.forEach(function (s) { children.push(settingNode(addon, s)); });
  var title = (index + 1) + ". " + addonName(addon) + (addon.manifest && addon.manifest.version ? " " + addon.manifest.version : "");
  return { type: "section", title: title, children: children };
}

function view() {
  var children = [
    {
      type: "text",
      content: "Eclipse addons are small servers run by third parties. When nothing else can play a track, Viboplr sends its title, artist and length to your enabled addons, in this order, and plays the first match. Only add addons you trust and are allowed to use.",
    },
  ];
  if (!addons.length) {
    children.push({ type: "text", content: "No addons yet. Paste one below." });
  }
  addons.forEach(function (a, i) { children.push(addonNode(a, i)); });
  children.push({
    type: "section",
    title: "Add an addon",
    children: [
      {
        type: "settings-row",
        label: "Manifest URL",
        description: "The address the addon's author gave you, ending in /manifest.json. It's stored privately and never shown in full.",
        control: {
          type: "text-input",
          action: act("eclipse:draft"),
          value: ui.draft,
          placeholder: "https://…/manifest.json",
          password: true,
        },
      },
      {
        type: "toolbar",
        buttons: [{ label: ui.adding ? "Adding…" : "Add", action: act("eclipse:add"), variant: "accent", disabled: ui.adding }],
        status: ui.addStatus ? ui.addStatus.message : undefined,
        statusVariant: ui.addStatus ? (ui.addStatus.ok ? "default" : "error") : undefined,
      },
    ],
  });
  children.push({
    type: "text",
    content: "Then place “Eclipse addons” in Settings → Providers. A track played through an addon can be downloaded from the now-playing bar.",
  });
  return { type: "layout", direction: "vertical", children: children };
}

function render() {
  if (!api) return;
  try {
    api.ui.setViewData(VIEW, view());
  } catch (e) {
    log("error", "Eclipse: drawing settings failed: " + message(e));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle

function activate(pluginApi) {
  api = pluginApi;
  api.playback.onStreamResolve(RESOLVER, resolvePlayback);
  api.downloads.onGetQualities(RESOLVER, function () {
    return [{ value: "original", label: "As the addon serves it" }];
  });
  api.downloads.onResolveByMetadata(RESOLVER, function (title, artistName, albumName, durationSecs) {
    return resolveDownload(title, artistName, albumName, durationSecs);
  });
  if (typeof api.playback.onResolveStreamByUri === "function") {
    api.playback.onResolveStreamByUri(SCHEME, resolveUriPlayback);
  }
  if (typeof api.downloads.onResolveByUri === "function") {
    api.downloads.onResolveByUri(RESOLVER, function (uri) { return resolveUriDownload(uri); });
  }
  ensureLoaded().then(function () { syncSearchProviders(); render(); }, function (e) {
    log("error", "Eclipse: loading failed: " + message(e));
  });
}

function deactivate() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; save(); }
  // The host drops our providers on unload; forget them so an enable registers again.
  searchProviders.clear();
  matches.clear();
  uriTracks.clear();
}

return {
  activate: activate,
  deactivate: deactivate,
  _testHooks: {
    normalizeManifestUrl: normalizeManifestUrl,
    maskUrl: maskUrl,
    coreTitle: coreTitle,
    mismatch: mismatch,
    pickTrack: pickTrack,
    extFor: extFor,
    qualityLabel: qualityLabel,
    dispatch: dispatch,
    parseTrackUri: parseTrackUri,
    state: function () { return { addons: addons, ui: ui, matches: matches, searchProviders: searchProviders }; },
    reset: function () {
      api = null; addons = []; loaded = false; matches = new Map();
      uriTracks = new Map(); searchProviders = new Map();
      registeredActions = new Set();
      ui = { draft: "", addStatus: null, adding: false, busy: {}, confirmRemove: null };
    },
  },
};
