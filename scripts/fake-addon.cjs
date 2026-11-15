#!/usr/bin/env node
// A minimal Eclipse addon for trying the plugin by hand, built from the protocol
// at https://eclipsemusic.app/docs. It serves ONE audio file you own, under the
// title and artist you give it, behind a fake token path:
//
//   node scripts/fake-addon.cjs --file ~/Music/song.flac --title "Song" --artist "Artist" [--secs 214] [--port 7311] [--resolve]
//
// Then add http://localhost:7311/tok-demo/manifest.json in Viboplr
// (Extensions → Eclipse Addons → Configuration). Plain http is accepted for
// localhost only. --resolve also advertises /resolve.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const file = arg("file");
const title = arg("title");
const artist = arg("artist");
if (!file || !title || !artist) {
  console.error("usage: node scripts/fake-addon.cjs --file <audio file> --title <title> --artist <artist> [--secs N] [--port 7311] [--resolve]");
  process.exit(1);
}
const abs = path.resolve(String(file).replace(/^~(?=$|\/|\\)/, require("node:os").homedir()));
if (!fs.existsSync(abs)) {
  console.error("no such file: " + abs);
  process.exit(1);
}
const port = Number(arg("port", 7311));
const secs = arg("secs") ? Number(arg("secs")) : undefined;
const withResolve = arg("resolve", false) === true;
const ext = path.extname(abs).slice(1).toLowerCase();
const TYPES = { flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav" };
const TOKEN = "/tok-demo";
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const track = { id: "demo-1", title, artist, duration: secs, format: ext };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function serveFile(req, res) {
  const size = fs.statSync(abs).size;
  const type = TYPES[ext] || "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    fs.createReadStream(abs).pipe(res);
  }
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  console.log(req.method, u.pathname, u.search);
  if (!u.pathname.startsWith(TOKEN + "/")) return json(res, 403, { notice: { message: "wrong token" } });
  const p = u.pathname.slice(TOKEN.length);
  if (p === "/manifest.json") {
    return json(res, 200, {
      id: "dev.viboplr.fake-addon",
      name: "Fake addon",
      version: "0.0.1",
      resources: withResolve ? ["search", "stream", "resolve"] : ["search", "stream"],
      settings: [{ key: "quality", type: "select", label: "Quality", default: "original", options: [{ value: "original", label: "Original" }] }],
    });
  }
  if (p === "/search") {
    const q = fold(u.searchParams.get("q"));
    const hit = q.includes(fold(title));
    return json(res, 200, { tracks: hit ? [track] : [] });
  }
  if (p === "/resolve" && withResolve) {
    const ok = fold(u.searchParams.get("title")) === fold(title) && fold(u.searchParams.get("artist")) === fold(artist);
    return json(res, 200, { item: ok ? { id: track.id, type: "track", title, artist } : null });
  }
  if (p === "/stream/" + track.id) {
    return json(res, 200, { url: `http://localhost:${port}${TOKEN}/file.${ext}`, format: ext, codec: ext, container: ext, manifest: "none" });
  }
  if (p === "/file." + ext) return serveFile(req, res);
  return json(res, 404, { error: "not found" });
}).listen(port, () => {
  console.log(`Fake addon on http://localhost:${port}${TOKEN}/manifest.json serving "${title}" by ${artist}`);
});
