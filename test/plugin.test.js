const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox");
const { makeHost, nodes, settle } = require("./harness/host");

const BASE = "https://addon.example/tok123";
const MANIFEST_URL = BASE + "/manifest.json";

function manifest(extra) {
  return Object.assign({
    id: "com.example.addon",
    name: "Example",
    version: "1.2.0",
    resources: ["search", "stream"],
    settings: [
      { key: "quality", type: "select", label: "Quality", default: "lossless", options: [{ value: "lossless", label: "Lossless" }, { value: "high", label: "High" }] },
    ],
  }, extra || {});
}

function stored(extra) {
  return [Object.assign({ uid: "a1", url: MANIFEST_URL, enabled: true, manifest: manifest(), values: {} }, extra || {})];
}

const SONG = { id: "t1", title: "Glass River", artist: "The Paper Kites", album: "Lanterns", duration: 214, artworkURL: "https://img.example/c.jpg" };
const STREAM = { url: "https://cdn.example/t1.flac", format: "flac", codec: "flac", container: "flac", sampleRate: 96000, bitDepth: 24, manifest: "none" };

// A scripted addon at BASE. `tracks` answers /search; `stream` answers /stream/{id}.
function addon(opts = {}) {
  return (u) => {
    if (u.hostname !== "addon.example") return undefined;
    const p = u.pathname.replace(/^\/tok123/, "");
    if (p === "/manifest.json") return opts.manifest || manifest();
    if (p === "/search") return opts.search ? opts.search(u) : { tracks: opts.tracks || [SONG] };
    if (p === "/resolve") return opts.resolve ? opts.resolve(u) : { item: null };
    if (p.startsWith("/stream/")) return opts.stream ? opts.stream(u) : STREAM;
    return undefined;
  };
}

async function setup(route, hostOpts = {}) {
  const plugin = loadPlugin();
  const host = makeHost(Object.assign({ route }, hostOpts));
  plugin.activate(host.api);
  await settle();
  return { plugin, host };
}

function play(host, title, artist, album, secs, opts) {
  return host.handlers.stream.eclipse(title, artist, album ?? null, secs ?? null, opts);
}

// --- registration --------------------------------------------------------

test("registers the stream resolver, the download provider and draws the settings page", async () => {
  const { host } = await setup(addon(), { stored: stored() });
  assert.equal(typeof host.handlers.stream.eclipse, "function");
  assert.equal(typeof host.handlers.download.eclipse, "function");
  assert.deepEqual(host.handlers.qualities.eclipse().map((q) => q.value), ["original"]);
  assert.ok(host.views["eclipse-settings"], "settings view drawn");
});

// --- URL handling --------------------------------------------------------

test("manifest URL: accepts a base or the manifest, refuses http off this computer and non-URLs", async () => {
  const { plugin } = await setup(addon());
  const n = plugin._testHooks.normalizeManifestUrl;
  assert.equal(n("https://addon.example/tok123"), MANIFEST_URL);
  assert.equal(n("https://addon.example/tok123/"), MANIFEST_URL);
  assert.equal(n("  https://addon.example/tok123/manifest.json "), MANIFEST_URL);
  assert.equal(n("http://localhost:7000"), "http://localhost:7000/manifest.json");
  assert.throws(() => n("http://addon.example/x"), /https/);
  assert.throws(() => n("addon.example"), /web address/);
  assert.throws(() => n(""), /Paste/);
});

test("the URL is never shown in full: the token part is masked on the settings page", async () => {
  const { plugin, host } = await setup(addon(), { stored: stored() });
  assert.equal(plugin._testHooks.maskUrl(MANIFEST_URL), "https://addon.example/…/manifest.json");
  const text = JSON.stringify(host.views["eclipse-settings"]);
  assert.ok(!text.includes("tok123"), "token not in the view");
  assert.ok(text.includes("https://addon.example/…/manifest.json"));
});

// --- matching ------------------------------------------------------------

test("titles: version suffixes naming the same recording are ignored on both sides", async () => {
  const { plugin } = await setup(addon());
  const c = plugin._testHooks.coreTitle;
  assert.equal(c("Glass River - Remastered 2011"), c("Glass River"));
  assert.equal(c("Glass River (2019 Remaster)"), c("Glass River"));
  assert.equal(c("Glass River (feat. Someone)"), c("Glass River"));
  assert.equal(c("Glåss Rïver"), c("Glass River"));
  assert.notEqual(c("Glass River Part II"), c("Glass River"));
});

test("matching refuses another artist, another version, and another length", async () => {
  const { plugin } = await setup(addon());
  const m = plugin._testHooks.mismatch;
  const q = { title: "Glass River", artist: "The Paper Kites", durationSecs: 214 };
  assert.equal(m(SONG, q), null);
  assert.equal(m(Object.assign({}, SONG, { artist: "Paper Kites, Guest" }), q), null);
  assert.equal(m(Object.assign({}, SONG, { artist: "Other Band" }), q), "another artist");
  assert.match(m(Object.assign({}, SONG, { title: "Glass River (Live)" }), q), /another version/);
  assert.match(m(Object.assign({}, SONG, { title: "Glass River - Karaoke Version" }), q), /another version/);
  assert.equal(m(Object.assign({}, SONG, { duration: 260 }), q), "another length");
  // A live version asked for is fine.
  assert.equal(m(Object.assign({}, SONG, { title: "Glass River (Live)" }), Object.assign({}, q, { title: "Glass River (Live)" })), null);
});

test("pickTrack takes the closest length among matches", async () => {
  const { plugin } = await setup(addon());
  const q = { title: "Glass River", artist: "The Paper Kites", durationSecs: 214 };
  const far = Object.assign({}, SONG, { id: "far", duration: 219 });
  const near = Object.assign({}, SONG, { id: "near", duration: 213 });
  assert.equal(plugin._testHooks.pickTrack([far, near], q).id, "near");
});

// --- playback ------------------------------------------------------------

test("playback: searches, matches, streams; settings ride along as query parameters", async () => {
  const { host } = await setup(addon(), { stored: stored({ values: { quality: "high" } }) });
  const out = await play(host, "Glass River", "The Paper Kites", "Lanterns", 214);
  assert.deepEqual(out, { url: STREAM.url, label: "Eclipse · Example" });
  const search = host.requests.find((r) => r.url.pathname.endsWith("/search"));
  assert.equal(search.url.searchParams.get("q"), "The Paper Kites Glass River");
  assert.equal(search.url.searchParams.get("quality"), "high");
  const stream = host.requests.find((r) => r.url.pathname.endsWith("/stream/t1"));
  assert.ok(stream, "stream asked for the matched id");
  for (const r of host.requests) assert.equal(typeof r.init.timeoutMs, "number");
});

test("playback: no match → null, so the host's chain moves on", async () => {
  const { host } = await setup(addon({ tracks: [Object.assign({}, SONG, { artist: "Someone Else" })] }), { stored: stored() });
  assert.equal(await play(host, "Glass River", "The Paper Kites", null, 214), null);
  assert.ok(!host.requests.some((r) => r.url.pathname.includes("/stream/")));
});

test("playback: nothing enabled → null without a single request", async () => {
  const { host } = await setup(addon(), { stored: stored({ enabled: false }) });
  assert.equal(await play(host, "Glass River", "The Paper Kites"), null);
  assert.equal(host.requests.length, 0);
});

test("playback: addons are asked in order; a failing one is skipped and noted", async () => {
  const two = stored().concat([{ uid: "a2", url: "https://second.example/manifest.json", enabled: true, manifest: manifest({ name: "Second" }), values: {} }]);
  const route = (u) => {
    if (u.hostname === "addon.example") return { status: 500, body: { error: "boom" } };
    if (u.hostname === "second.example") {
      if (u.pathname === "/search") return { tracks: [SONG] };
      if (u.pathname.startsWith("/stream/")) return Object.assign({}, STREAM, { url: "https://cdn.example/second.flac" });
    }
    return undefined;
  };
  const { host } = await setup(route, { stored: two });
  const out = await play(host, "Glass River", "The Paper Kites", null, 214);
  assert.deepEqual(out, { url: "https://cdn.example/second.flac", label: "Eclipse · Second" });
  assert.ok(host.logs.some((l) => l.level === "warn" && /Example answered HTTP 500/.test(l.message)));
  assert.ok(!host.logs.some((l) => l.message.includes("tok123")), "URL never logged");
});

test("playback: /resolve is used first when the addon has it, and its id is streamed", async () => {
  let resolveAsked = null;
  const route = addon({
    manifest: manifest({ resources: ["search", "stream", "resolve"] }),
    resolve: (u) => { resolveAsked = u; return { item: { id: "r9", type: "track", title: "Glass River", artist: "The Paper Kites" } }; },
    search: () => { throw new Error("search should not be asked"); },
  });
  const { host } = await setup(route, { stored: stored({ manifest: manifest({ resources: ["search", "stream", "resolve"] }) }) });
  const out = await play(host, "Glass River", "The Paper Kites", null, 214);
  assert.equal(out.url, STREAM.url);
  assert.equal(resolveAsked.searchParams.get("title"), "Glass River");
  assert.equal(resolveAsked.searchParams.get("durationMs"), "214000");
  assert.ok(host.requests.some((r) => r.url.pathname.endsWith("/stream/r9")));
});

test("playback: a resolve answer naming another song is ignored and search decides", async () => {
  const res = ["search", "stream", "resolve"];
  const route = addon({
    manifest: manifest({ resources: res }),
    resolve: () => ({ item: { id: "wrong", title: "Another Song", artist: "The Paper Kites" } }),
  });
  const { host } = await setup(route, { stored: stored({ manifest: manifest({ resources: res }) }) });
  const out = await play(host, "Glass River", "The Paper Kites", null, 214);
  assert.equal(out.url, STREAM.url);
  assert.ok(host.requests.some((r) => r.url.pathname.endsWith("/stream/t1")));
  assert.ok(!host.requests.some((r) => r.url.pathname.endsWith("/stream/wrong")));
});

test("playback: an encrypted stream is refused, never played", async () => {
  const { host } = await setup(addon({ stream: () => Object.assign({}, STREAM, { encrypted: true }) }), { stored: stored() });
  assert.equal(await play(host, "Glass River", "The Paper Kites", null, 214), null);
  assert.ok(host.logs.some((l) => /encrypted/.test(l.message)));
});

test("playback: an addon that only answers the Eclipse app (403) is reported, not worked around", async () => {
  const { host } = await setup(() => ({ status: 403, body: { error: "missing X-Eclipse-Access" } }), { stored: stored() });
  assert.equal(await play(host, "Glass River", "The Paper Kites"), null);
  assert.ok(host.logs.some((l) => /only answers the Eclipse app/.test(l.message)));
  for (const r of host.requests) assert.equal(r.init.headers["X-Eclipse-Access"], undefined);
});

test("playback: the same song again reuses its stream; fresh asks the addon again", async () => {
  const { host } = await setup(addon(), { stored: stored() });
  await play(host, "Glass River", "The Paper Kites", null, 214);
  const before = host.requests.length;
  await play(host, "Glass River", "The Paper Kites", null, 214);
  assert.equal(host.requests.length, before, "no new requests");
  await play(host, "Glass River", "The Paper Kites", null, 214, { fresh: true });
  const after = host.requests.slice(before).map((r) => r.url.pathname);
  assert.deepEqual(after, ["/tok123/stream/t1"], "fresh re-streams the same match without searching again");
});

test("playback: 503 with a short Retry-After is retried", async () => {
  let calls = 0;
  const route = addon({ stream: () => (++calls === 1 ? { status: 503, body: {}, headers: { "retry-after": "0" } } : STREAM) });
  const { host } = await setup(route, { stored: stored() });
  const out = await play(host, "Glass River", "The Paper Kites", null, 214);
  assert.equal(out.url, STREAM.url);
  assert.equal(calls, 2);
});

test("playback: a track's own streamURL skips /stream", async () => {
  const route = addon({ tracks: [Object.assign({}, SONG, { streamURL: "https://cdn.example/direct.mp3", format: "mp3" })] });
  const { host } = await setup(route, { stored: stored() });
  const out = await play(host, "Glass River", "The Paper Kites", null, 214);
  assert.equal(out.url, "https://cdn.example/direct.mp3");
  assert.ok(!host.requests.some((r) => r.url.pathname.includes("/stream/")));
});

// --- downloads -----------------------------------------------------------

test("download: fetches the recording that played, from the addon that played it", async () => {
  const { host } = await setup(addon(), { stored: stored() });
  await play(host, "Glass River", "The Paper Kites", "Lanterns", 214);
  const searchesBefore = host.requests.filter((r) => r.url.pathname.endsWith("/search")).length;
  const out = await host.handlers.download.eclipse("Glass River", "The Paper Kites", "Lanterns", 214, "original");
  assert.equal(out.url, STREAM.url);
  assert.equal(out.ext, "flac");
  assert.equal(out.quality, "FLAC · 24-bit · 96 kHz");
  assert.deepEqual(out.metadata, { title: "Glass River", artist: "The Paper Kites", album: "Lanterns", coverUrl: "https://img.example/c.jpg" });
  const searchesAfter = host.requests.filter((r) => r.url.pathname.endsWith("/search")).length;
  assert.equal(searchesAfter, searchesBefore, "no new search: the played match is reused");
});

test("download: a segmented (HLS/DASH) stream is refused with a reason", async () => {
  const { host } = await setup(addon({ stream: () => Object.assign({}, STREAM, { manifest: "hls" }) }), { stored: stored() });
  await assert.rejects(
    host.handlers.download.eclipse("Glass River", "The Paper Kites", null, 214, "original"),
    /segments \(HLS\)/,
  );
});

test("download: nothing found → a user-facing error, not null", async () => {
  const { host } = await setup(addon({ tracks: [] }), { stored: stored() });
  await assert.rejects(host.handlers.download.eclipse("Glass River", "The Paper Kites", null, 214, "original"), /None of your Eclipse addons/);
});

test("extFor and qualityLabel read the addon's own description", async () => {
  const { plugin } = await setup(addon());
  const { extFor, qualityLabel } = plugin._testHooks;
  assert.equal(extFor({ url: "https://x/y", codec: "aac", container: "mp4" }), "m4a");
  assert.equal(extFor({ url: "https://x/song.mp3?sig=1" }), "mp3");
  assert.equal(extFor({ url: "https://x/stream" }), null);
  assert.equal(qualityLabel({ format: "mp3", quality: "320kbps" }), "MP3 · 320kbps");
});

// --- settings ------------------------------------------------------------

test("settings: add validates the manifest, saves, and draws the addon with its own settings", async () => {
  const { host } = await setup(addon());
  host.actions["eclipse:draft"]({ value: "https://addon.example/tok123" });
  await host.actions["eclipse:add"]();
  await settle();
  assert.equal(host.store.addons.length, 1);
  assert.equal(host.store.addons[0].url, MANIFEST_URL);
  assert.equal(host.store.addons[0].manifest.name, "Example");
  const all = nodes(host.views["eclipse-settings"]);
  assert.ok(all.some((n) => n.type === "section" && n.title === "1. Example 1.2.0"));
  assert.ok(all.some((n) => n.type === "select" && n.label === "Quality" && n.value === "lossless"));
});

test("settings: a manifest that can't find songs is refused with a reason", async () => {
  const { host } = await setup(addon({ manifest: manifest({ resources: ["catalog", "stream"] }) }));
  host.actions["eclipse:draft"]({ value: MANIFEST_URL });
  await host.actions["eclipse:add"]();
  await settle();
  assert.equal(host.store.addons, undefined);
  const bar = nodes(host.views["eclipse-settings"]).find((n) => n.type === "toolbar" && n.statusVariant === "error");
  assert.match(bar.status, /can't search or resolve/);
});

test("settings: test reports working, enable toggles, move reorders, remove asks first", async () => {
  const two = stored().concat([{ uid: "a2", url: "https://second.example/manifest.json", enabled: true, manifest: manifest({ name: "Second" }), values: {} }]);
  const { host, plugin } = await setup(addon(), { stored: two });
  await host.actions["eclipse:test:a1"]();
  await settle();
  assert.match(host.store.addons[0].lastTest.message, /Working: search answered 1 track/);
  assert.equal(host.notifications.at(-1).kind, "success");

  host.actions["eclipse:enable:a1"]({ value: false });
  await settle();
  assert.equal(host.store.addons[0].enabled, false);

  host.actions["eclipse:down:a1"]();
  await settle();
  assert.deepEqual(host.store.addons.map((a) => a.uid), ["a2", "a1"]);

  host.actions["eclipse:remove:a1"]();
  assert.ok(nodes(host.views["eclipse-settings"]).some((n) => n.type === "confirm"));
  assert.equal(plugin._testHooks.state().addons.length, 2, "nothing removed before confirming");
  host.actions["eclipse:remove-yes:a1"]();
  await settle();
  assert.deepEqual(host.store.addons.map((a) => a.uid), ["a2"]);
});

test("settings: a select setting saves at once and changes the next request", async () => {
  const { host } = await setup(addon(), { stored: stored() });
  host.actions["eclipse:pick:a1:quality"]({ value: "high" });
  await settle();
  assert.equal(host.store.addons[0].values.quality, "high");
  await play(host, "Glass River", "The Paper Kites", null, 214);
  const search = host.requests.find((r) => r.url.pathname.endsWith("/search"));
  assert.equal(search.url.searchParams.get("quality"), "high");
});
