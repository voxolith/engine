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
import { hashBuild, serviceWorkerSource, type BakedConfig, type BakedRule, type CacheStrategy } from "./sw";

export type { CacheStrategy } from "./sw";

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
