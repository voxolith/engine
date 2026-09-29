// The logic of `registerServiceWorker` (`./index.ts`), apart from `import.meta.env` so
// `tools/verify-pwa.ts` can drive it in bun with a fake navigator.

/** Options for `registerServiceWorker`. */
export interface RegisterServiceWorkerOptions {
  /** The app's base URL (default `import.meta.env.BASE_URL`); the worker is `<base><file>`, scoped to `<base>`. */
  base?: string;
  /** The worker's file name, as given to the plugin (default `sw.js`). */
  file?: string;
  /**
   * Register on `localhost`, `127.0.0.1` and `[::1]` too (default false), e.g. to try offline
   * loading against `vite preview`.
   */
  localhost?: boolean;
  /**
   * The first worker for this app has installed and taken over: what it precaches is now
   * cached, so the app loads offline from here on.
   */
  onOfflineReady?(registration: ServiceWorkerRegistration): void;
  /**
   * A new build's worker has installed and taken over from an older one. The page still runs
   * the old code; a reload runs the new build. Whether to say so is the app's call.
   */
  onUpdate?(registration: ServiceWorkerRegistration): void;
  /** Registering failed (default: `console.warn`). */
  onError?(error: unknown): void;
}

/** What `registerServiceWorker` reads from `import.meta.env`, passed in for testing. */
export interface RegisterEnv {
  dev: boolean;
  base: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** `registerServiceWorker` with `import.meta.env` passed in. */
export function registerWith(env: RegisterEnv, opts: RegisterServiceWorkerOptions): Promise<ServiceWorkerRegistration | null> {
  if (env.dev) return Promise.resolve(null);
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!opts.localhost && LOOPBACK.has(location.hostname)) return Promise.resolve(null);
  const sw = navigator.serviceWorker;
  const scope = new URL(opts.base ?? env.base, location.href).href;
  const url = new URL(opts.file ?? "sw.js", scope).href;
  const onError = opts.onError ?? ((e: unknown) => console.warn("voxolith: service worker registration failed", e));
  const loaded = document.readyState === "complete" ? Promise.resolve() : new Promise<void>((r) => window.addEventListener("load", () => r(), { once: true }));
  return loaded
    .then(() =>
      sw.register(url, { scope }).then((reg) => {
        const seen = new WeakSet<ServiceWorker>();
        const follow = (w: ServiceWorker | null) => {
          if (!w || seen.has(w)) return;
          seen.add(w);
          // A worker already controls the page (an older build's): this one taking over is an
          // update. Read when the worker appears, so a deploy arriving later in the session
          // after the first install still counts as one.
          const replacing = !!sw.controller;
          const check = () => {
            if (w.state !== "activated") return;
            w.removeEventListener("statechange", check);
            if (replacing) opts.onUpdate?.(reg);
            else opts.onOfflineReady?.(reg);
          };
          w.addEventListener("statechange", check);
          check();
        };
        follow(reg.installing ?? reg.waiting);
        reg.addEventListener("updatefound", () => follow(reg.installing));
        return reg;
      }),
    )
    .catch((e: unknown) => {
      onError(e);
      return null;
    });
}
