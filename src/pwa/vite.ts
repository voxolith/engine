/**
 * `@voxolith/engine/vite`: build-time helpers for Vite configs. Runs in the build (bun or Node),
 * never in the browser.
 *
 * {@link serviceWorker} emits a service worker for an app, so a second visit loads from the
 * cache and works offline. Register it from the page with `registerServiceWorker` from
 * `@voxolith/engine/pwa`.
 *
 * This module imports only types from `vite`, so the engine takes no runtime dependency on it.
 *
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, ResolvedConfig, Rollup } from "vite";


/**
 * Fetched data to cache at run time, e.g. the viewer's samples or an example's `.vox` files:
 * files from the public directory, which are not part of the bundle and so are not precached.
 * Matching responses go to a cache of their own that survives deploys (their URLs carry no hash,
 * so a new build does not make them stale; `stale-while-revalidate` refreshes them anyway).
 */
export interface RuntimeCacheRule {
  /**
   * Which requests, by path relative to the app's base: a string is a prefix (`"samples/"`,
   * `"models/"`), a RegExp is tested against the relative path (`/\.vox$/`).
   */
  match: string | RegExp;
  /**
   * How to answer (default `stale-while-revalidate`):
   * - `stale-while-revalidate`: the cached copy at once, refreshed from the network behind it;
   * - `cache-first`: the cached copy if there is one, else the network (for files that never change);
   * - `network-first`: the network, the cached copy only when offline.
   */
  strategy?: CacheStrategy;
}

/** Options for {@link serviceWorker}. */
export interface ServiceWorkerOptions {
  /**
   * The app's cache name prefix, e.g. `"examples"`. Every app on the origin shares one Cache
   * Storage (GitHub Pages serves them all from one host), so it must be unique among them: the
   * worker deletes only caches named `<name>-<build id>` of older builds. Letters, digits and
   * dashes.
   */
  name: string;
  /**
   * What to fetch on install, so it is there offline before it is first opened:
   * - `"all"` (default): every file of the build (each page, its chunks and CSS, workers,
   *   imported assets; not source maps). For a multi-page app that is every page, so a second
   *   visit works offline even on pages not yet opened. Costs the whole build's size once per
   *   deploy (the examples are about a megabyte).
   * - `"entry"`: only the root `index.html`, its entry chunk, the chunks it imports statically
   *   and their CSS. Other pages, lazy chunks and workers are cached when first used.
   * - `false`: nothing but the root `index.html`; everything is cached when first used.
   */
  precache?: "all" | "entry" | false;
  /**
   * More files to precache, relative to the base, e.g. `["manifest.webmanifest", "favicon.svg"]`
   * from the public directory. Files that fail to fetch are skipped, never fail the install.
   */
  include?: string[];
  /** Fetched data to cache at run time; the first matching rule wins. See {@link RuntimeCacheRule}. */
  runtime?: RuntimeCacheRule[];
  /**
   * The worker's file name at the root of the build, which is the app's base (default `sw.js`).
   * It cannot live under `assets/`: a worker's scope is its own folder at most, unless the server
   * sends `Service-Worker-Allowed`, which GitHub Pages cannot.
   */
  fileName?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * A Vite plugin that emits a service worker at the root of the build (`sw.js`), with the build id
 * and the list of files to precache baked in. It runs on `vite build` only (`apply: "build"`), so
 * a dev server never has a worker and never serves stale code.
 *
 * The worker, scoped to the app's base:
 * - on install fetches the precache list (see {@link ServiceWorkerOptions.precache}) into a
 *   cache named `<name>-<build id>`, and takes over at once;
 * - on activate deletes this app's caches of older builds;
 * - answers page loads network first (a new deploy shows up at once; the cached page when offline or on a server error),
 *   hashed build assets and precached files cache first, {@link ServiceWorkerOptions.runtime}
 *   matches by their rule, and anything else in scope stale-while-revalidate.
 *
 * The build id is a hash of the build's files, so an unchanged rebuild keeps its cache and any
 * change makes a new worker (the browser compares `sw.js` byte for byte). A manifest and icons,
 * to make the app installable, stay the app's own.
 *
 * The app's `base` must be absolute (`/` or `/<repo>/`), as the worker's scope is resolved
 * from it.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { serviceWorker } from "@voxolith/engine/vite";
 * export default defineConfig({
 *   base: process.env.BASE_PATH ?? "/",
 *   plugins: [basicSsl(), serviceWorker({ name: "viewer", runtime: [{ match: "samples/" }] })],
 * });
 * // src/main.ts
 * import { registerServiceWorker } from "@voxolith/engine/pwa";
 * registerServiceWorker();
 * ```
 */
export function serviceWorker(opts: ServiceWorkerOptions): Plugin {
  if (!NAME.test(opts.name)) throw new Error(`serviceWorker: name ${JSON.stringify(opts.name)} must be letters, digits and dashes`);
  const fileName = opts.fileName ?? "sw.js";
  if (fileName.includes("/")) throw new Error(`serviceWorker: fileName ${JSON.stringify(fileName)} must sit at the root of the build`);
  const runtime: BakedRule[] = (opts.runtime ?? []).map((r) => {
    const strategy = r.strategy ?? "stale-while-revalidate";
    return typeof r.match === "string" ? { prefix: r.match.replace(/^\.?\//, ""), strategy } : { source: r.match.source, flags: r.match.flags, strategy };
  });
  let config: ResolvedConfig | undefined;
  return {
    name: "voxolith:service-worker",
    apply: "build",
    enforce: "post",
    configResolved(c) {
      config = c;
    },
    generateBundle: {
      order: "post",
      handler(_output, bundle) {
        if (!config) throw new Error("serviceWorker: generateBundle ran before configResolved");
        if (!/^(\/|https?:)/.test(config.base)) this.warn(`base ${JSON.stringify(config.base)} is relative; the service worker needs an absolute base`);
        if (fileName in bundle) this.error(`the build already has a ${fileName}; pick another fileName`);
        if (config.publicDir && existsSync(resolve(config.publicDir, fileName))) {
          this.error(`${config.publicDir}/${fileName} would overwrite the generated service worker; delete it`);
        }
        const baked = bakeConfig(bundle, config, opts, runtime, fileName);
        this.emitFile({ type: "asset", fileName, source: serviceWorkerSource(baked) });
      },
    },
  };
}

// Choose the precache list and the build id from the bundle.
function bakeConfig(
  bundle: Rollup.OutputBundle,
  config: ResolvedConfig,
  opts: ServiceWorkerOptions,
  runtime: BakedRule[],
  fileName: string,
): BakedConfig {
  const files = Object.keys(bundle).filter((f) => !f.endsWith(".map") && !f.startsWith(".vite/")).sort();
  const precache = new Set<string>();
  const mode = opts.precache ?? "all";
  if (mode === "all") for (const f of files) precache.add(f);
  else if (mode === "entry") {
    const rootHtml = resolve(config.root, "index.html");
    const visit = (f: string) => {
      const item = bundle[f];
      if (!item || precache.has(f)) return;
      precache.add(f);
      if (item.type !== "chunk") return;
      for (const i of item.imports) visit(i);
      const meta = (item as { viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> } }).viteMetadata;
      for (const css of meta?.importedCss ?? []) visit(css);
      for (const a of meta?.importedAssets ?? []) visit(a);
    };
    for (const item of Object.values(bundle)) {
      if (item.type === "chunk" && item.isEntry && item.facadeModuleId && resolve(item.facadeModuleId) === rootHtml) visit(item.fileName);
    }
  }
  if ("index.html" in bundle) precache.add("index.html");
  for (const f of opts.include ?? []) precache.add(f.replace(/^\.?\//, ""));
  const build = hashBuild(
    (function* () {
      for (const f of files) {
        const item = bundle[f];
        yield f;
        yield item.type === "chunk" ? item.code : item.source;
      }
    })(),
  );
  const assets = `${config.build.assetsDir.replace(/^\.?\/|\/$/g, "")}/`;
  return { name: opts.name, build, precache: [...precache], assets, file: fileName, runtime };
}

// The service worker's source, generated at build time by `serviceWorker()` above.
//
// Kept in this file rather than a module of its own: an app's vite.config loads this file
// through Node, which does not resolve extensionless relative imports. Internal: not an export of
// the package. It is a plain function from a config to the text of
// `sw.js`, so `tools/verify-pwa.ts` can run the very same worker against fake `caches` and
// `fetch` in bun. The worker itself is plain JavaScript in a template (it runs in the browser's
// service worker global scope, not through any bundler), so keep it small and ES2020.
//
// Strategy, generalised from demolition-shot's hand-written `sw.js`:
// - install: fetch the precache list into the build's cache, then take over at once;
// - activate: delete this app's caches of older builds (never another app's on the origin);
// - navigations: network first (a new deploy shows up at once), the cached page offline;
// - runtime rules (fetched data): their own strategy, in a cache that outlives builds;
// - precached files and hashed build assets: cache first;
// - anything else in scope (icons, the manifest): stale-while-revalidate.

/** How a runtime rule answers a request. */
export type CacheStrategy = "cache-first" | "network-first" | "stale-while-revalidate";

/** A runtime rule as it is baked into the worker: a path prefix, or a RegExp's parts. */
export interface BakedRule {
  prefix?: string;
  source?: string;
  flags?: string;
  strategy: CacheStrategy;
}

/** Everything the worker needs, fixed at build time. */
export interface BakedConfig {
  /** Cache name prefix, unique per app on the origin. */
  name: string;
  /** Build id: names the build's cache, so each deploy gets a fresh one. */
  build: string;
  /** Files to fetch on install, relative to the scope (`"assets/index-abc.js"`, `"world/index.html"`). */
  precache: string[];
  /** Prefix of hashed build assets, relative to the scope (`"assets/"`). */
  assets: string;
  /** The worker's own file, relative to the scope; never cached. */
  file: string;
  /** Runtime rules, first match wins. */
  runtime: BakedRule[];
}

/** The cache holding one build's files. */
export const buildCacheName = (name: string, build: string): string => `${name}-${build}`;
/** The cache holding runtime-rule responses; it survives deploys. */
export const runtimeCacheName = (name: string): string => `${name}-runtime-cache`;

/** A build id: a short base-36 hash (cyrb53) of the given parts, so equal builds get equal ids. */
export function hashBuild(parts: Iterable<string | Uint8Array>): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const mix = (c: number) => {
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  };
  for (const part of parts) {
    if (typeof part === "string") for (let i = 0; i < part.length; i++) mix(part.charCodeAt(i));
    else for (let i = 0; i < part.length; i++) mix(part[i]);
    mix(0x1f); // separator, so ["ab", "c"] and ["a", "bc"] differ
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The text of `sw.js` for a config. */
export function serviceWorkerSource(config: BakedConfig): string {
  return `// Generated by serviceWorker() from @voxolith/engine/vite. Do not edit; rebuild instead.
const C = ${JSON.stringify(config)};
${WORKER}`;
}

const WORKER = String.raw`const SCOPE = self.registration.scope; // always ends with /
const SCOPE_PATH = new URL(SCOPE).pathname;
const CACHE = C.name + "-" + C.build;
const RUNTIME = C.name + "-runtime-cache";
// This app's build caches: its name, a dash, a base-36 id. Another app's names never match,
// even one whose name starts with ours ("demo" and "demo-shot-x": the rest has a dash).
const OLD = new RegExp("^" + C.name.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&") + "-[0-9a-z]+$");
const RULES = C.runtime.map((r) => {
  const re = r.prefix === undefined ? new RegExp(r.source, r.flags) : null;
  return { test: (p) => (re ? re.test(p) : p.startsWith(r.prefix)), strategy: r.strategy };
});
const at = (file) => new URL(file, SCOPE).href;
const PRECACHE = new Set(C.precache.map(at));
// A page's cache key: no query or hash, and a directory means its index.html.
const pageKey = (href) => {
  const u = new URL(href);
  u.search = "";
  u.hash = "";
  if (u.pathname.endsWith("/")) u.pathname += "index.html";
  return u.href;
};
const keep = (res) => res && res.status === 200;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        [...PRECACHE].map((href) =>
          fetch(new Request(href, { cache: "reload" }))
            .then((res) => (keep(res) ? cache.put(href, res) : undefined))
            .catch(() => undefined),
        ),
      ),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && OLD.test(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function store(event, name, key, res) {
  if (!keep(res)) return;
  const copy = res.clone();
  event.waitUntil(caches.open(name).then((c) => c.put(key, copy)).catch(() => undefined));
}

// Offline (fetch throws) or a server error: the cached copy if there is one.
async function networkFirst(event, name, key) {
  let res;
  try {
    res = await fetch(event.request);
  } catch (err) {
    const hit = await (await caches.open(name)).match(key);
    if (hit) return hit;
    throw err;
  }
  if (res.status >= 500) return (await (await caches.open(name)).match(key)) || res;
  store(event, name, key, res);
  return res;
}

async function cacheFirst(event, name, key) {
  const hit = await (await caches.open(name)).match(key);
  if (hit) return hit;
  const res = await fetch(event.request);
  store(event, name, key, res);
  return res;
}

async function staleWhileRevalidate(event, name, key) {
  const hit = await (await caches.open(name)).match(key);
  const network = fetch(event.request).then((res) => {
    store(event, name, key, res);
    return res;
  });
  if (!hit) return network;
  event.waitUntil(network.catch(() => undefined));
  return hit;
}

const STRATEGY = { "cache-first": cacheFirst, "network-first": networkFirst, "stale-while-revalidate": staleWhileRevalidate };

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  const rel = url.pathname.slice(SCOPE_PATH.length);
  if (rel === C.file) return;
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(event, CACHE, pageKey(req.url)));
    return;
  }
  const rule = RULES.find((r) => r.test(rel));
  if (rule) {
    event.respondWith(STRATEGY[rule.strategy](event, RUNTIME, req.url));
    return;
  }
  const bare = url.origin + url.pathname;
  if (PRECACHE.has(bare) || rel.startsWith(C.assets)) {
    event.respondWith(cacheFirst(event, CACHE, url.search ? req.url : bare));
    return;
  }
  event.respondWith(staleWhileRevalidate(event, CACHE, req.url));
});
`;
