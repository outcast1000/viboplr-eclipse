// v0.2: Cmd+K search providers and eclipse:// tracks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox");
const { makeHost, settle } = require("./harness/host");

const MANIFEST_URL = "https://addon.example/tok123/manifest.json";

function manifest(extra) {
  return Object.assign({ id: "com.example.addon", name: "Example", version: "1.2.0", resources: ["search", "stream"], settings: [
    { key: "quality", type: "select", label: "Quality", default: "lossless", options: [{ value: "lossless", label: "Lossless" }, { value: "high", label: "High" }] },
  ] }, extra || {});
}

function stored(extra) {
  return [Object.assign({ uid: "a1", url: MANIFEST_URL, enabled: true, manifest: manifest(), values: {} }, extra || {})];
}

const SONG = { id: "t1", title: "Glass River", artist: "The Paper Kites", album: "Lanterns", duration: 214, artworkURL: "https://img.example/c.jpg" };
const STREAM = { url: "https://cdn.example/t1.flac", format: "flac", codec: "flac", container: "flac", sampleRate: 96000, bitDepth: 24, manifest: "none" };

function addon(opts = {}) {
  return (u) => {
    if (u.hostname !== "addon.example") return undefined;
    const p = u.pathname.replace(/^\/tok123/, "");
    if (p === "/manifest.json") return manifest();
    if (p === "/search") return { tracks: opts.tracks || [SONG] };
    if (p.startsWith("/stream/")) return STREAM;
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

test("search: one provider per enabled addon that can search, kept in step with the list", async () => {
  const list = stored().concat([
    { uid: "a2", url: "https://second.example/manifest.json", enabled: false, manifest: manifest({ name: "Second" }), values: {} },
    { uid: "a3", url: "https://third.example/manifest.json", enabled: true, manifest: manifest({ name: "Resolver only", resources: ["resolve", "stream"] }), values: {} },
  ]);
  const { host } = await setup(addon(), { stored: list });
  assert.deepEqual([...host.providers.keys()], ["addon-a1"]);
  assert.equal(host.providers.get("addon-a1").name, "Example");

  host.actions["eclipse:enable:a2"]({ value: true });
  await settle();
  assert.deepEqual([...host.providers.keys()].sort(), ["addon-a1", "addon-a2"]);

  host.actions["eclipse:enable:a1"]({ value: false });
  await settle();
  assert.deepEqual([...host.providers.keys()], ["addon-a2"]);
});

test("search: results are eclipse:// tracks with names, length and https art", async () => {
  const { host } = await setup(addon({ tracks: [SONG, { id: "x", title: "" }] }), { stored: stored({ values: { quality: "high" } }) });
  const out = await host.handlers.search["addon-a1"]("glass river", 6);
  assert.equal(out.status, "ok");
  assert.deepEqual(out.tracks, [{
    path: "eclipse://a1/t1",
    title: "Glass River",
    artist_name: "The Paper Kites",
    album_title: "Lanterns",
    duration_secs: 214,
    image_url: "https://img.example/c.jpg",
    kind: "audio",
  }]);
  const req = host.requests.find((r) => r.url.pathname.endsWith("/search"));
  assert.equal(req.url.searchParams.get("q"), "glass river");
  assert.equal(req.url.searchParams.get("quality"), "high");
});

test("search: nothing → empty; a failing addon → error with its reason, not a throw", async () => {
  const { host: h1 } = await setup(addon({ tracks: [] }), { stored: stored() });
  assert.deepEqual(await h1.handlers.search["addon-a1"]("x", 6), { status: "empty" });
  const { host: h2 } = await setup(() => ({ status: 500, body: {} }), { stored: stored() });
  const err = await h2.handlers.search["addon-a1"]("x", 6);
  assert.equal(err.status, "error");
  assert.match(err.message, /Example answered HTTP 500/);
});

test("eclipse:// playback streams that addon's track; fresh asks again", async () => {
  const { host } = await setup(addon(), { stored: stored() });
  assert.equal(await host.handlers.uri.eclipse("a1/t1"), STREAM.url);
  const n = host.requests.length;
  assert.equal(await host.handlers.uri.eclipse("a1/t1"), STREAM.url);
  assert.equal(host.requests.length, n, "reused within its lifetime");
  await host.handlers.uri.eclipse("a1/t1", null, { fresh: true });
  assert.equal(host.requests.length, n + 1);
});

test("eclipse:// track ids are encoded, and a search result's own streamURL is used", async () => {
  const odd = Object.assign({}, SONG, { id: "a/b c", streamURL: "https://cdn.example/direct.mp3", format: "mp3" });
  const { host, plugin } = await setup(addon({ tracks: [odd] }), { stored: stored() });
  const out = await host.handlers.search["addon-a1"]("glass", 6);
  assert.equal(out.tracks[0].path, "eclipse://a1/a%2Fb%20c");
  assert.deepEqual(plugin._testHooks.parseTrackUri(out.tracks[0].path), { addonUid: "a1", trackId: "a/b c", uri: "eclipse://a1/a%2Fb%20c" });
  assert.equal(await host.handlers.uri.eclipse("a1/a%2Fb%20c"), "https://cdn.example/direct.mp3");
  assert.ok(!host.requests.some((r) => r.url.pathname.includes("/stream/")));
});

test("eclipse:// from a removed or disabled addon says so", async () => {
  const { host } = await setup(addon(), { stored: stored({ enabled: false }) });
  await assert.rejects(host.handlers.uri.eclipse("a1/t1"), /turned off/);
  await assert.rejects(host.handlers.uri.eclipse("gone/t1"), /no longer in your list/);
});

test("eclipse:// download: same addon, same track, named from the result", async () => {
  const { host } = await setup(addon(), { stored: stored() });
  await host.handlers.search["addon-a1"]("glass river", 6);
  const out = await host.handlers.downloadUri.eclipse("eclipse://a1/t1", "original");
  assert.equal(out.url, STREAM.url);
  assert.equal(out.ext, "flac");
  assert.deepEqual(out.metadata, { title: "Glass River", artist: "The Paper Kites", album: "Lanterns", coverUrl: "https://img.example/c.jpg" });
});

test("deactivate forgets providers so a re-enable registers them again", async () => {
  const { host, plugin } = await setup(addon(), { stored: stored() });
  assert.equal(host.providers.size, 1);
  plugin.deactivate();
  assert.equal(plugin._testHooks.state().searchProviders.size, 0);
});
