// A fake plugin API plus scripted Eclipse addons: enough of ViboplrPluginAPI for
// activate() and the handlers. Requests are recorded so tests can assert on
// what was asked.

function response(status, body, headers) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: Object.assign({ "content-type": typeof body === "string" ? "text/plain" : "application/json" }, headers || {}),
    getSetCookie() { return []; },
    async json() { return JSON.parse(text); },
    async text() { return text; },
  };
}

// opts.route(url: URL) → { status, body, headers? } | body | undefined (404)
// opts.stored: initial value of the "addons" storage key
function makeHost(opts = {}) {
  const requests = [];
  const logs = [];
  const notifications = [];
  const views = {};
  const actions = {};
  const store = {};
  if (opts.stored !== undefined) store.addons = JSON.parse(JSON.stringify(opts.stored));
  const handlers = { stream: {}, download: {}, qualities: {}, uri: {}, downloadUri: {}, search: {} };
  const providers = new Map(); // id → descriptor (registered, not unregistered)

  const api = {
    appVersion: "1.0.122",
    log: (level, message) => logs.push({ level, message }),
    network: {
      async fetch(url, init) {
        const u = new URL(url);
        requests.push({ url: u, init });
        if (opts.fail && opts.fail(u)) throw new Error("connection refused");
        const out = opts.route ? opts.route(u) : undefined;
        if (out === undefined) return response(404, "not found");
        if (out && typeof out.status === "number" && "body" in out) return response(out.status, out.body, out.headers);
        return response(200, out);
      },
    },
    storage: {
      async get(key) { return key in store ? JSON.parse(JSON.stringify(store[key])) : null; },
      async set(key, value) { store[key] = JSON.parse(JSON.stringify(value)); },
      async delete(key) { delete store[key]; },
    },
    playback: {
      onStreamResolve(id, handler) { handlers.stream[id] = handler; return () => {}; },
      onResolveStreamByUri(scheme, handler) { handlers.uri[scheme] = handler; return () => {}; },
    },
    downloads: {
      onResolveByMetadata(id, handler) { handlers.download[id] = handler; return () => {}; },
      onResolveByUri(id, handler) { handlers.downloadUri[id] = handler; return () => {}; },
      onGetQualities(id, handler) { handlers.qualities[id] = handler; return () => {}; },
    },
    search: {
      onQuery(id, handler) { handlers.search[id] = handler; return () => {}; },
      registerProvider(d) { providers.set(d.id, d); return () => providers.delete(d.id); },
      unregisterProvider(id) { providers.delete(id); },
    },
    ui: {
      setViewData(viewId, data) { views[viewId] = data; },
      showNotification(message, options) { notifications.push({ message, kind: options && options.kind }); },
      onAction(id, handler) { actions[id] = handler; },
    },
  };

  return { api, requests, logs, notifications, views, actions, store, handlers, providers };
}

// Walk a view tree and collect every node (for assertions on the settings page).
function nodes(view) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    out.push(n);
    (n.children || []).forEach(walk);
    if (n.control) walk(n.control);
    if (n.child) walk(n.child);
  })(view);
  return out;
}

// Let pending promise chains (activate's load + render) settle.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

module.exports = { makeHost, response, nodes, settle };
