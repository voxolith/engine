/**
 * `@voxolith/engine/pwa`: register the service worker that `serviceWorker()` from
 * `@voxolith/engine/vite` emits into a build, and hear when the app is ready offline or a new
 * version has arrived.
 *
 * Data and callbacks only: whether to tell the user about an update, and how, is the app's call.
 * So is being installable (a manifest and icons are the app's own files).
 *
 * @packageDocumentation
 */

/// <reference types="vite/client" />

import { registerWith, type RegisterServiceWorkerOptions } from "./register";

export type { RegisterServiceWorkerOptions } from "./register";

/**
 * Register the app's service worker, `sw.js` at the app's base (`import.meta.env.BASE_URL`),
 * scoped to that base. Waits for the page's `load` event first, so the worker's precaching never
 * competes with the page's own start-up.
 *
 * Does nothing and resolves `null`:
 * - on a Vite dev server (`import.meta.env.DEV`), which has no worker (the plugin runs on
 *   `vite build` only);
 * - on `localhost`, `127.0.0.1` or `[::1]`, unless {@link RegisterServiceWorkerOptions.localhost}
 *   is set, so local previews, smoke tests and benches never serve from a cache;
 * - where the browser has no service workers (or the page is not a secure context).
 *
 * Otherwise it resolves the registration, or `null` after `onError` when registering failed
 * (e.g. a build without the plugin, so no `sw.js`).
 *
 * @example
 * ```ts
 * registerServiceWorker({
 *   onOfflineReady: () => console.info("ready to work offline"),
 *   onUpdate: () => showReloadHint(), // the app's own UI, if it wants one
 * });
 * ```
 */
export function registerServiceWorker(opts: RegisterServiceWorkerOptions = {}): Promise<ServiceWorkerRegistration | null> {
  return registerWith({ dev: import.meta.env.DEV, base: import.meta.env.BASE_URL }, opts);
}
