// Load events: what is loading, of how much, and when it started and ended.
//
// One small tracker serves two readers. An app subscribes to it to draw its own loading screen
// (the engine draws nothing and picks no look), and `?perf` or a bench reads the same records
// back as a per-phase load timeline. The engine's loaders (the generator pool, the chunked
// world, the instance layer and, through `trackRenderer`, the renderer) report into it when
// they are given one; apps add phases of their own the same way.
//
// Runtime-safe: no DOM, no GPU. Only `performance.now()`, which bun and workers have too.

/**
 * The phase names the engine's own loaders report under. Phases are plain strings, so an app
 * adds its own (`"layout"`, `"sounds"`) beside these.
 *
 * - `shaders`: linking the renderer's shader modules ({@link trackRenderer}).
 * - `pipelines`: creating the renderer's pipelines, one tick per variant ({@link trackRenderer}).
 * - `models`: generating (or loading from the cache) entities on the generator pool.
 * - `upload`: first-sight `addModel` uploads in an instance layer's model library.
 * - `placement`: the static `setInstances` of an instance layer (the per-cell lists and tables).
 * - `ground`: chunks built by a chunked world.
 */
export const LOAD_PHASES = {
  shaders: "shaders",
  pipelines: "pipelines",
  models: "models",
  upload: "upload",
  placement: "placement",
  ground: "ground",
} as const;

/** One of the engine's own phase names ({@link LOAD_PHASES}). */
export type LoadPhase = (typeof LOAD_PHASES)[keyof typeof LOAD_PHASES];

/**
 * One change to a phase, sent to {@link LoadTracker.on} listeners. The counts are the phase's
 * running totals after the change (every task on the phase, over its whole life), not deltas.
 */
export interface LoadEvent {
  /** The phase, e.g. one of {@link LOAD_PHASES} or an app's own. */
  phase: string;
  /**
   * `start` when the phase goes from idle to busy (its first open task, or the first after it
   * ended), `progress` when a count changes, `end` when its last open task ends.
   */
  kind: "start" | "progress" | "end";
  /** Items finished in this phase so far. */
  done: number;
  /** Items expected in this phase so far. It may grow; it never drops below `done`. */
  total: number;
  /** Of `done`, how many came from a cache (models served by the model cache). */
  cached: number;
  /** Detail of the tick that caused this event, e.g. a generator id or a pipeline variant. */
  label?: string;
  /** Milliseconds since the tracker was made. */
  t: number;
}

/** Extra detail for {@link LoadTask.tick}. */
export interface LoadTickInfo {
  /** The items came from a cache rather than being built. */
  cached?: boolean;
  /** Detail passed on to the event (a generator id, a pipeline variant). */
  label?: string;
}

/**
 * One piece of work on a phase, from {@link LoadTracker.task}. A phase is busy while any of its
 * tasks is open. After `end()` the task is inert: further calls do nothing.
 */
export interface LoadTask {
  /** Expect `n` more items (default 1). */
  add(n?: number): void;
  /**
   * `n` items finished (default 1). Ticking past the expected total grows the total, so `done`
   * never exceeds `total`; a task made without a total can simply tick.
   */
  tick(n?: number, info?: LoadTickInfo): void;
  /**
   * Close the task. Items it expected but never ticked are dropped from the phase's total, so a
   * task ended early (a cancelled load, a destroyed pool) counts only what it finished and an
   * idle phase always reads `done === total`. Calling it twice is harmless.
   */
  end(): void;
}

/** A phase as {@link LoadTracker.snapshot} reports it. */
export interface PhaseState {
  /** The phase name. */
  phase: string;
  /** Items finished, over the phase's whole life. */
  done: number;
  /** Items expected, over the phase's whole life. */
  total: number;
  /** Of `done`, how many came from a cache. */
  cached: number;
  /** Any task on the phase is open. */
  busy: boolean;
  /** When the phase first started, in ms since the tracker was made. */
  start: number;
  /** When it last ended; absent while it has not ended yet (or is busy again after reopening). */
  end?: number;
}

/** Every phase at one moment, from {@link LoadTracker.snapshot}. */
export interface LoadSnapshot {
  /** Phases in the order they first started. */
  phases: PhaseState[];
  /** Sum of `done` over the phases. Phases count different things; weigh them yourself if needed. */
  done: number;
  /** Sum of `total` over the phases. */
  total: number;
  /** Sum of `cached` over the phases. */
  cached: number;
  /** Any phase is busy. */
  busy: boolean;
}

/**
 * One phase of the load timeline, from {@link LoadTracker.timeline}. A phase that reopened
 * (streaming ground, a pipeline compiled lazily on a later frame) keeps one entry: `start` is
 * its first start, `end` its latest end, and `busy` / `spans` say how much of that stretch it
 * actually worked.
 */
export interface TimelineEntry {
  /** The phase name. */
  phase: string;
  /** First start, ms since the tracker was made. */
  start: number;
  /** Latest end, ms since the tracker was made; absent while the phase is busy. */
  end?: number;
  /** Milliseconds the phase spent busy, summed over its spans (up to now for an open span). */
  busy: number;
  /** How many times it went from idle to busy. */
  spans: number;
  /** Items finished. */
  done: number;
  /** Items expected. */
  total: number;
  /** Of `done`, how many came from a cache. */
  cached: number;
}

/**
 * Collects load progress by phase and tells listeners about it, from {@link makeLoadTracker}.
 *
 * Several tasks may run on one phase at once (two pools generating models); their counts add up
 * and the phase is busy while any is open. A phase can start again after it ended: the counts
 * carry on from where they were, a new `start` event is sent and the timeline entry stretches.
 */
export interface LoadTracker {
  /**
   * Open a task on `phase`, expecting `total` items (default 0; grow it with `add`, or just
   * `tick`). Starts the phase if it was idle.
   */
  task(phase: string, total?: number): LoadTask;
  /**
   * Listen to every event. Returns an unsubscribe. A listener that throws is logged with
   * `console.error` and never breaks the loader that reported.
   */
  on(fn: (e: LoadEvent) => void): () => void;
  /** Every phase's counts and state now. */
  snapshot(): LoadSnapshot;
  /**
   * Resolves when `phase` (or, without one, every phase) is idle. Resolves at once if it already
   * is, including a phase that has not started yet, so call it after the load has been kicked
   * off.
   */
  idle(phase?: string): Promise<void>;
  /** The load timeline: one entry per phase, in the order they first started. */
  timeline(): TimelineEntry[];
}

interface Phase {
  name: string;
  done: number;
  total: number;
  cached: number;
  open: number;
  start: number;
  end?: number;
  since: number;
  busyMs: number;
  spans: number;
}

/**
 * Make a load tracker: loaders report phases into it, and the app reads it to draw its own
 * loading screen and to time the load.
 *
 * Events are sent synchronously, from inside the loader's own call. So a phase that blocks the
 * main thread (an upload, the static placement, a pipeline compile) still sends `start` and
 * `end`, but the page only repaints after it has finished: a "placing..." line written from the
 * `start` event shows up together with the `end`. An app that wants its message on screen before
 * the stall lets a frame paint first, then calls the blocking step:
 * `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))`. A bare
 * `requestAnimationFrame` is not enough, because code resuming from its callback still runs
 * before that frame is painted. Moving those steps off the main thread later does not change
 * this API.
 *
 * @example
 * ```ts
 * const load = makeLoadTracker();
 * const renderer = await createRenderer(gpu, scene, { onLoad: trackRenderer(load) });
 * const pool = makeGeneratorPool({ spawn, load });
 * const off = load.on(() => {
 *   info.textContent = load.snapshot().phases
 *     .filter((p) => p.busy)
 *     .map((p) => `${p.phase} ${p.done}/${p.total}`)
 *     .join(", ");
 * });
 * await load.idle();
 * off();
 * console.log(formatTimeline(load.timeline()));
 * ```
 */
export function makeLoadTracker(): LoadTracker {
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const phases = new Map<string, Phase>();
  let listeners: ((e: LoadEvent) => void)[] = [];
  let waiters: { phase?: string; resolve: () => void }[] = [];

  function emit(p: Phase, kind: LoadEvent["kind"], label?: string, t = now()): void {
    if (listeners.length === 0) return;
    const e: LoadEvent = { phase: p.name, kind, done: p.done, total: p.total, cached: p.cached, t };
    if (label !== undefined) e.label = label;
    for (const fn of listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error(`voxolith: a load listener threw on "${p.name}" ${kind}`, err);
      }
    }
  }

  const busy = () => {
    for (const p of phases.values()) if (p.open > 0) return true;
    return false;
  };

  const isIdle = (phase?: string) => (phase === undefined ? !busy() : !phases.get(phase)?.open);

  function settle(): void {
    if (waiters.length === 0) return;
    const ready = waiters.filter((w) => isIdle(w.phase));
    waiters = waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  }

  return {
    task(phase, total = 0) {
      let p = phases.get(phase);
      const t = now();
      if (!p) {
        p = { name: phase, done: 0, total: 0, cached: 0, open: 0, start: t, since: t, busyMs: 0, spans: 0 };
        phases.set(phase, p);
      }
      const ph = p;
      const wasIdle = ph.open === 0;
      ph.open++;
      let expected = Math.max(0, total);
      let finished = 0;
      let open = true;
      ph.total += expected;
      if (wasIdle) {
        ph.end = undefined;
        ph.since = t;
        ph.spans++;
        emit(ph, "start", undefined, t);
      } else if (expected > 0) emit(ph, "progress", undefined, t);
      return {
        add(n = 1) {
          if (!open || n <= 0) return;
          expected += n;
          ph.total += n;
          emit(ph, "progress");
        },
        tick(n = 1, info) {
          if (!open || n <= 0) return;
          finished += n;
          ph.done += n;
          if (info?.cached) ph.cached += n;
          if (finished > expected) {
            ph.total += finished - expected;
            expected = finished;
          }
          emit(ph, "progress", info?.label);
        },
        end() {
          if (!open) return;
          open = false;
          ph.total -= expected - finished;
          ph.open--;
          if (ph.open === 0) {
            const t = now();
            ph.end = t;
            ph.busyMs += t - ph.since;
            emit(ph, "end", undefined, t);
            settle();
          }
        },
      };
    },

    on(fn) {
      listeners = [...listeners, fn];
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },

    snapshot() {
      const list: PhaseState[] = [];
      let done = 0, total = 0, cached = 0, any = false;
      for (const p of phases.values()) {
        const s: PhaseState = { phase: p.name, done: p.done, total: p.total, cached: p.cached, busy: p.open > 0, start: p.start };
        if (p.end !== undefined) s.end = p.end;
        list.push(s);
        done += p.done;
        total += p.total;
        cached += p.cached;
        any ||= p.open > 0;
      }
      return { phases: list, done, total, cached, busy: any };
    },

    idle(phase) {
      if (isIdle(phase)) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ phase, resolve }));
    },

    timeline() {
      const t = now();
      return [...phases.values()].map((p) => {
        const e: TimelineEntry = {
          phase: p.name,
          start: p.start,
          busy: p.busyMs + (p.open > 0 ? t - p.since : 0),
          spans: p.spans,
          done: p.done,
          total: p.total,
          cached: p.cached,
        };
        if (p.end !== undefined) e.end = p.end;
        return e;
      });
    },
  };
}

/**
 * The renderer's load callback, typed here by shape so the engine does not need a particular
 * renderer version: `RendererOptions.onLoad` in `@voxolith/renderer` has this signature.
 */
export type RendererLoadCallback = (phase: "shaders" | "pipelines", kind: "start" | "end", label?: string) => void;

/**
 * Report the renderer's loading steps into a tracker: pass the result as
 * `createRenderer(gpu, scene, { onLoad: trackRenderer(load) })`. Each `start` adds one item to its
 * phase (opening a task if none is open) and each `end` ticks it with the variant as the label;
 * the task ends when every started step has ended. Pipelines compiled lazily on a later frame
 * reopen the `pipelines` phase, so they show up in the timeline as the stall they are.
 */
export function trackRenderer(load: LoadTracker): RendererLoadCallback {
  const open = new Map<string, { task: LoadTask; running: number }>();
  return (phase, kind, label) => {
    let entry = open.get(phase);
    if (kind === "start") {
      if (!entry) {
        entry = { task: load.task(phase), running: 0 };
        open.set(phase, entry);
      }
      entry.running++;
      entry.task.add(1);
      return;
    }
    if (!entry) return; // an end without a start: nothing to close
    entry.task.tick(1, label === undefined ? undefined : { label });
    if (--entry.running <= 0) {
      entry.task.end();
      open.delete(phase);
    }
  };
}

/**
 * The load timeline as a plain-text table, one line per phase: when it started, how long it
 * took from first start to latest end (and how much of that it was busy, when it reopened),
 * done/total and cache hits. For logs and `?perf`, not for display.
 *
 * @example
 * ```ts
 * console.log(formatTimeline(load.timeline()));
 * // phase         start      took    done/total  cached
 * // shaders          0 ms    41 ms         1/1
 * // models          52 ms  1830 ms       12/12      12
 * ```
 */
export function formatTimeline(entries: readonly TimelineEntry[]): string {
  const ms = (v: number) => `${Math.round(v)} ms`;
  const rows = entries.map((e) => {
    const took = e.end === undefined ? "running" : ms(e.end - e.start);
    const busy = e.spans > 1 ? `busy ${ms(e.busy)} in ${e.spans} spans` : "";
    return [e.phase, ms(e.start), took, e.total ? `${e.done}/${e.total}` : "", e.cached ? String(e.cached) : "", busy];
  });
  const head = ["phase", "start", "took", "done/total", "cached", ""];
  const all = [head, ...rows];
  const width = head.map((_, c) => Math.max(...all.map((r) => r[c].length)));
  const line = (r: string[]) =>
    r.map((cell, c) => (c === 0 || c === r.length - 1 ? cell.padEnd(width[c]) : cell.padStart(width[c]))).join("  ").trimEnd();
  return all.map(line).join("\n");
}
