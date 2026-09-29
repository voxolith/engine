// Headless checks for the service worker plugin and its registration.  bun tools/verify-pwa.ts
//
// The plugin's generate step on a fake bundle (dev exclusion, precache modes, cache names per
// app and build, the build id), then the emitted sw.js itself, run against in-memory `caches`
// and `fetch` (install, activate, every fetch strategy online and offline, scope), then
// registration against a fake navigator.

import type { Plugin, ResolvedConfig } from "vite";
import { serviceWorker, type ServiceWorkerOptions } from "../src/pwa/vite";
import { registerWith } from "../src/pwa/register";

const HERE = new URL(".", import.meta.url).pathname;

let failed = 0, checks = 0;
const ok = (c: boolean, m: string, d = "") => {
  checks++;
  if (c) console.log(`  ✓ ${m}`);
  else { failed++; console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); }
};
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

// A fake Vite output bundle: two pages, a shared chunk, CSS, a lazy chunk, a worker, a map.
type Item = { type: "chunk"; fileName: string; code: string; isEntry: boolean; facadeModuleId: string | null; imports: string[]; dynamicImports: string[]; viteMetadata: { importedCss: Set<string>; importedAssets: Set<string> } }
  | { type: "asset"; fileName: string; source: string | Uint8Array };
const chunk = (fileName: string, code: string, o: Partial<Extract<Item, { type: "chunk" }>> = {}, css: string[] = []): Item =>
  ({ type: "chunk", fileName, code, isEntry: false, facadeModuleId: null, imports: [], dynamicImports: [], viteMetadata: { importedCss: new Set(css), importedAssets: new Set() }, ...o });
const asset = (fileName: string, source: string | Uint8Array): Item => ({ type: "asset", fileName, source });
const fakeBundle = (lazyCode = "lazy()") => {
  const items: Item[] = [
    asset("index.html", "<script src=/examples/assets/index-a.js>"),
    asset("world/index.html", "<script src=/examples/assets/world-d.js>"),
    chunk("assets/index-a.js", "main()", { isEntry: true, facadeModuleId: "/app/index.html", imports: ["assets/shared-b.js"], dynamicImports: ["assets/lazy-e.js"] }, ["assets/index-c.css"]),
    chunk("assets/shared-b.js", "shared()"),
    asset("assets/index-c.css", "body{}"),
    chunk("assets/world-d.js", "world()", { isEntry: true, facadeModuleId: "/app/world/index.html", imports: ["assets/shared-b.js"] }),
    chunk("assets/lazy-e.js", lazyCode),
    asset("assets/gen.worker-f.js", new Uint8Array([1, 2, 3])),
    asset("assets/index-a.js.map", "{}"),
    asset(".vite/manifest.json", "{}"),
  ];
  return Object.fromEntries(items.map((i) => [i.fileName, i]));
};
const fakeConfig = (o: Partial<{ base: string; publicDir: string }> = {}) =>
  ({ root: "/app", base: "/examples/", publicDir: "/nonexistent-public", build: { assetsDir: "assets" }, ...o }) as unknown as ResolvedConfig;

// Run the plugin's hooks as Vite would, and return what it emitted.
function build(opts: ServiceWorkerOptions, bundle = fakeBundle(), config = fakeConfig()) {
  const plugin = serviceWorker(opts) as unknown as { apply: Plugin["apply"]; configResolved(c: ResolvedConfig): void; generateBundle: { order: string; handler: (this: unknown, o: unknown, b: unknown) => void } };
  plugin.configResolved(config);
  const emitted: { fileName: string; source: string }[] = [];
  const warnings: string[] = [];
  const ctx = {
    emitFile: (f: { fileName: string; source: string }) => { emitted.push(f); return f.fileName; },
    warn: (m: string) => { warnings.push(m); },
    error: (m: string) => { throw new Error(m); },
  };
  plugin.generateBundle.handler.call(ctx, {}, bundle);
  const src = emitted[0]?.source ?? "";
  const cfg = JSON.parse(/^const C = (.*);$/m.exec(src)?.[1] ?? "null");
  return { plugin, emitted, warnings, src, cfg };
}

console.log("plugin:");
{
  const r = build({ name: "examples", runtime: [{ match: "models/" }, { match: /\.vox$/, strategy: "cache-first" }] });
  ok(r.plugin.apply === "build", "applies to `vite build` only, so dev servers never get a worker");
  ok(r.emitted.length === 1 && r.emitted[0].fileName === "sw.js", "emits sw.js at the root of the build (the app's base, the widest scope Pages allows)");
  ok(r.cfg.name === "examples" && /^[0-9a-z]+$/.test(r.cfg.build) && r.cfg.assets === "assets/" && r.cfg.file === "sw.js", "  with the app's name, a base-36 build id, the assets dir and its own file name", JSON.stringify(r.cfg));
  const all = [...r.cfg.precache].sort().join();
  ok(all === "assets/gen.worker-f.js,assets/index-a.js,assets/index-c.css,assets/lazy-e.js,assets/shared-b.js,assets/world-d.js,index.html,world/index.html",
    "precache \"all\" (default): every page, chunk, style and worker; no maps, no .vite/", all);
  ok(!r.src.includes("/examples/"), "  no base baked in: the worker takes its scope from its registration");
  ok(JSON.stringify(r.cfg.runtime) === JSON.stringify([{ prefix: "models/", strategy: "stale-while-revalidate" }, { source: "\\.vox$", flags: "", strategy: "cache-first" }]),
    "runtime rules: prefix or RegExp, stale-while-revalidate by default", JSON.stringify(r.cfg.runtime));
  const entry = build({ name: "examples", precache: "entry" }).cfg.precache.sort().join();
  ok(entry === "assets/index-a.js,assets/index-c.css,assets/shared-b.js,index.html", "precache \"entry\": the root page, its chunk, static imports and CSS only", entry);
  const none = build({ name: "examples", precache: false, include: ["manifest.webmanifest", "./favicon.svg"] }).cfg.precache.join();
  ok(none === "index.html,manifest.webmanifest,favicon.svg", "precache false: the root page, plus `include`", none);
  ok(build({ name: "examples" }).cfg.build === r.cfg.build, "the build id is stable for the same files");
  ok(build({ name: "examples" }, fakeBundle("lazy2()")).cfg.build !== r.cfg.build, "  and changes with any file's content");
  ok(build({ name: "viewer" }).cfg.name === "viewer" && build({ name: "viewer" }).src !== r.src, "cache names are per app");
  ok(throws(() => serviceWorker({ name: "my app" })) && throws(() => serviceWorker({ name: "" })) && throws(() => serviceWorker({ name: "x", fileName: "assets/sw.js" })),
    "rejects a name that is not letters/digits/dashes, and a worker below the root");
  ok(build({ name: "x" }, fakeBundle(), fakeConfig({ base: "./" })).warnings.length === 1, "warns on a relative base");
  ok(throws(() => build({ name: "x" }, { ...fakeBundle(), "sw.js": asset("sw.js", "") })), "fails when the bundle already has sw.js");
  ok(throws(() => build({ name: "x" }, fakeBundle(), fakeConfig({ publicDir: HERE }))) === false && throws(() => build({ name: "x", fileName: "verify-pwa.ts" }, fakeBundle(), fakeConfig({ publicDir: HERE }))),
    "fails when the public dir has a file of that name (demolition-shot's old public/sw.js)");
}

// ---- the worker, in memory -----------------------------------------------------------------

const ORIGIN = "https://voxolith.github.io";
const SCOPE = `${ORIGIN}/examples/`;
type Req = { url: string; method: string; mode: string; headers: Headers };
const req = (path: string, o: Partial<Req> = {}): Req => ({ url: new URL(path, ORIGIN).href, method: "GET", mode: "cors", headers: new Headers(), ...o });

function fakeCaches() {
  const store = new Map<string, Map<string, Response>>();
  const key = (k: string | { url: string }) => (typeof k === "string" ? k : k.url);
  const open = async (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const c = store.get(name)!;
    return {
      match: async (k: string | { url: string }) => c.get(key(k))?.clone(),
      put: async (k: string | { url: string }, res: Response) => { await res.clone().arrayBuffer(); c.set(key(k), res); },
    };
  };
  return {
    store,
    api: {
      open,
      keys: async () => [...store.keys()],
      delete: async (name: string) => store.delete(name),
      match: async () => { throw new Error("the worker must not search every cache (other apps share them)"); },
    },
  };
}

function fakeNetwork() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const net = { offline: false, down: false, files, calls };
  const fetch = async (r: string | { url: string }) => {
    const url = typeof r === "string" ? r : r.url;
    calls.push(url);
    if (net.offline) throw new TypeError("offline");
    if (net.down) return new Response("unavailable", { status: 503 });
    const u = new URL(url);
    // Like Pages: a directory serves its index.html.
    const body = files.get(u.origin + u.pathname + (u.pathname.endsWith("/") ? "index.html" : ""));
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
  };
  return { net, fetch };
}

function startWorker(src: string, caches: unknown, fetch: unknown) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    registration: { scope: SCOPE },
    location: { href: `${SCOPE}sw.js`, origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
    skipWaiting: async () => { self.skipped = true; },
    clients: { claim: async () => { self.claimed = true; } },
    skipped: false,
    claimed: false,
  };
  new Function("self", "caches", "fetch", "Request", src)(self, caches, fetch, class { url: string; constructor(u: string) { this.url = u; } });
  const lifecycle = async (type: string) => {
    const waits: Promise<unknown>[] = [];
    handlers[type]({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  // A fetch event: resolves the response the worker gave (null when it let the page handle it).
  const request = async (r: Req): Promise<{ res: Response | null; text?: string }> => {
    let answer: Promise<Response> | null = null;
    const waits: Promise<unknown>[] = [];
    handlers.fetch({ request: r, respondWith: (p: Promise<Response>) => { answer = p; }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    if (!answer) return { res: null };
    const res = await (answer as Promise<Response>).catch(() => null);
    await Promise.all(waits);
    return { res, text: res ? await res.clone().text() : undefined };
  };
  return { self, lifecycle, request };
}

console.log("sw.js:");
{
  const { src, cfg } = build({ name: "examples", runtime: [{ match: "models/" }, { match: /\.bin$/, strategy: "network-first" }] });
  const caches = fakeCaches();
  const { net, fetch } = fakeNetwork();
  for (const f of cfg.precache) net.files.set(`${SCOPE}${f}`, `body of ${f}`);
  net.files.set(`${SCOPE}models/cat.vox`, "cat v1");
  net.files.set(`${SCOPE}favicon.svg`, "<svg>");
  net.files.set(`${SCOPE}data/x.bin`, "bin v1");
  for (const old of ["examples-oldbuild1", "examples-runtime-cache", "viewer-abc123", "examples-shot-x", "demolition-shot-k2j3"]) caches.store.set(old, new Map());
  ok(!throws(() => new Function(src)), "sw.js parses");
  const w = startWorker(src, caches.api, fetch);
  const CACHE = `examples-${cfg.build}`;

  await w.lifecycle("install");
  const built = caches.store.get(CACHE);
  ok(!!built && built.size === cfg.precache.length && [...built.keys()].every((k) => k.startsWith(SCOPE)), `install precaches every listed file into ${CACHE}, under the scope`, String(built?.size));
  ok(w.self.skipped, "  and skips waiting");

  await w.lifecycle("activate");
  const names = [...caches.store.keys()].sort().join();
  ok(names === [CACHE, "demolition-shot-k2j3", "examples-runtime-cache", "examples-shot-x", "viewer-abc123"].sort().join(),
    "activate deletes this app's older builds only (not its runtime cache, not other apps, not a longer name)", names);
  ok(w.self.claimed, "  and claims the open pages");

  net.calls.length = 0;
  let r = await w.request(req("/examples/assets/index-a.js"));
  ok(r.text === "body of assets/index-a.js" && net.calls.length === 0, "hashed assets: cache first, no network");
  r = await w.request(req("/examples/assets/new-z.js"));
  ok(r.res?.status === 404, "  an asset not in the cache goes to the network");

  net.files.set(`${SCOPE}world/index.html`, "world v2");
  r = await w.request(req("/examples/world/?vpm=100", { mode: "navigate" }));
  ok(r.text === "world v2", "navigations: network first (a new deploy shows at once)");
  net.offline = true;
  r = await w.request(req("/examples/world/?vpm=50", { mode: "navigate" }));
  ok(r.text === "world v2", "  offline: the cached page, whatever the query, directory = index.html");
  r = await w.request(req("/examples/index.html", { mode: "navigate" }));
  ok(r.text === "body of index.html", "  a page precached but never opened loads offline");
  net.offline = false;
  net.down = true;
  r = await w.request(req("/examples/world/", { mode: "navigate" }));
  const r404 = await w.request(req("/examples/nowhere/", { mode: "navigate" }));
  net.down = false;
  ok(r.text === "world v2" && r404.res?.status === 503, "  a server error (5xx): the cached page if there is one, else the error");
  net.offline = true;
  r = await w.request(req("/examples/nowhere/", { mode: "navigate" }));
  ok(r.res === null, "  an uncached page offline is a network error, not another page");
  net.offline = false;

  r = await w.request(req("/examples/models/cat.vox"));
  ok(r.text === "cat v1" && !!caches.store.get("examples-runtime-cache")?.has(`${SCOPE}models/cat.vox`), "runtime rule: fetched data goes to the runtime cache");
  net.files.set(`${SCOPE}models/cat.vox`, "cat v2");
  r = await w.request(req("/examples/models/cat.vox"));
  const after = await w.request(req("/examples/models/cat.vox"));
  ok(r.text === "cat v1" && after.text === "cat v2", "  stale-while-revalidate: the cached copy, refreshed behind it");
  net.offline = true;
  r = await w.request(req("/examples/models/cat.vox"));
  ok(r.text === "cat v2", "  offline: served from the runtime cache");
  net.offline = false;
  r = await w.request(req("/examples/data/x.bin"));
  net.files.set(`${SCOPE}data/x.bin`, "bin v2");
  const fresh = await w.request(req("/examples/data/x.bin"));
  net.offline = true;
  const stale = await w.request(req("/examples/data/x.bin"));
  net.offline = false;
  ok(r.text === "bin v1" && fresh.text === "bin v2" && stale.text === "bin v2", "  network-first rule (RegExp): network when online, cache offline");

  r = await w.request(req("/examples/favicon.svg"));
  net.offline = true;
  const icon = await w.request(req("/examples/favicon.svg"));
  net.offline = false;
  ok(r.text === "<svg>" && icon.text === "<svg>" && caches.store.get(CACHE)!.has(`${SCOPE}favicon.svg`), "anything else in scope: stale-while-revalidate in the build's cache");

  ok((await w.request(req("/viewer/assets/x.js"))).res === null, "out of scope (another app on the origin): not handled");
  ok((await w.request(req("https://cdn.example.com/examples/a.js"))).res === null, "  another origin: not handled");
  ok((await w.request(req("/examples/assets/index-a.js", { method: "POST" }))).res === null, "  non-GET: not handled");
  ok((await w.request(req("/examples/sw.js"))).res === null, "  the worker's own file: not handled");
  const ranged = req("/examples/models/cat.vox");
  ranged.headers.set("range", "bytes=0-1");
  ok((await w.request(ranged)).res === null, "  range requests: not handled");

  net.files.delete(`${SCOPE}assets/lazy-e.js`);
  const c2 = fakeCaches();
  const w2 = startWorker(src, c2.api, fetch);
  await w2.lifecycle("install");
  ok(c2.store.get(CACHE)!.size === cfg.precache.length - 1 && w2.self.skipped, "a precache file that fails to fetch is skipped, and the install still completes");
}

// ---- registration --------------------------------------------------------------------------

type Listener = () => void;
class FakeWorker {
  state = "installing";
  private ls: Listener[] = [];
  addEventListener(_: string, fn: Listener) { this.ls.push(fn); }
  removeEventListener(_: string, fn: Listener) { this.ls = this.ls.filter((l) => l !== fn); }
  set(s: string) { this.state = s; for (const l of [...this.ls]) l(); }
}
function fakeBrowser(host: string, controlled: boolean) {
  const reg = {
    installing: null as FakeWorker | null,
    waiting: null,
    ls: [] as Listener[],
    addEventListener(_: string, fn: Listener) { this.ls.push(fn); },
  };
  const calls: { url: string; scope: string }[] = [];
  const sw = {
    controller: controlled ? {} : null,
    register: async (url: string, o: { scope: string }) => { calls.push({ url, scope: o.scope }); reg.installing = new FakeWorker(); return reg; },
  };
  Object.assign(globalThis, {
    navigator: { serviceWorker: sw },
    location: new URL(`https://${host}/examples/world/`),
    document: { readyState: "complete" },
  });
  return { reg, sw, calls };
}

console.log("registerServiceWorker:");
{
  const saved = { navigator: globalThis.navigator, location: (globalThis as { location?: unknown }).location, document: (globalThis as { document?: unknown }).document };
  let b = fakeBrowser("voxolith.github.io", false);
  ok((await registerWith({ dev: true, base: "/examples/" }, {})) === null && b.calls.length === 0, "a dev build never registers");
  b = fakeBrowser("localhost:5173", false);
  ok((await registerWith({ dev: false, base: "/" }, {})) === null && b.calls.length === 0, "localhost never registers by default (previews, smoke, benches)");
  b = fakeBrowser("127.0.0.1:47811", false);
  await registerWith({ dev: false, base: "/" }, { localhost: true });
  ok(b.calls.length === 1, "  unless `localhost: true`");

  b = fakeBrowser("voxolith.github.io", false);
  const events: string[] = [];
  const reg = await registerWith({ dev: false, base: "/examples/" }, { onOfflineReady: () => events.push("offline"), onUpdate: () => events.push("update") });
  ok(reg !== null && b.calls[0].url === "https://voxolith.github.io/examples/sw.js" && b.calls[0].scope === "https://voxolith.github.io/examples/",
    "registers <base>sw.js, scoped to the base, from any page of the app", JSON.stringify(b.calls[0]));
  const first = b.reg.installing!;
  first.set("installed");
  ok(events.length === 0, "  nothing reported before the worker is active");
  first.set("activated");
  b.sw.controller = {};
  ok(events.join() === "offline", "  the first worker activating: onOfflineReady", events.join());
  b.reg.installing = new FakeWorker();
  for (const l of b.reg.ls) l();
  b.reg.installing.set("activated");
  ok(events.join() === "offline,update", "  a later deploy in the same session: onUpdate", events.join());

  b = fakeBrowser("voxolith.github.io", true);
  events.length = 0;
  await registerWith({ dev: false, base: "/examples/" }, { onOfflineReady: () => events.push("offline"), onUpdate: () => events.push("update") });
  b.reg.installing!.set("activated");
  ok(events.join() === "update", "a page an older build controls: onUpdate", events.join());

  b = fakeBrowser("voxolith.github.io", false);
  b.sw.register = async () => { throw new Error("404"); };
  let err = null as unknown;
  ok((await registerWith({ dev: false, base: "/examples/" }, { onError: (e) => { err = e; } })) === null && err instanceof Error, "a failed registration resolves null after onError");
  Object.assign(globalThis, saved);
}

console.log(`\n${checks - failed}/${checks} pwa checks passed`);
if (failed) process.exit(1);
