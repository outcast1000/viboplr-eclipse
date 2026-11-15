// Parse-check index.js the way the host loads it: a function body that ends in a
// top-level `return`, so `node --check` can't read it directly.
const fs = require("node:fs");
const path = require("node:path");
const code = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
new Function("api", "window", "globalThis", "self", "document", code);
console.log("index.js parses");
