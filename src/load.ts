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
 * - `upload`: first-sight model uploads in an instance layer's model library: one per model with
 *   `addModel` on the main thread, or in bricks per model when encoded on a scene worker.
 * - `placement`: an instance layer's static placement (the per-cell lists and tables), from
 *   `commit()`, or from the bake request to the apply with `commitAsync()`.
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
 * Names for moments a page records with {@link LoadTracker.mark}. The engine records none of them
 * itself: when a page counts as drawn or settled is the page's call, so it marks them. Marks are
 * plain strings, so an app adds its own (`"playable"`) beside these.
 *
 * - `firstFrame`: the page's first picture of its scene has been submitted (where a loading
 *   screen would lift).
 * - `converged`: after the first frame, the picture has stopped converging for the first time
 *   (`renderer.converging()` first reads false), so what is on screen is the settled image.
 */
export const LOAD_MARKS = {
  firstFrame: "first-frame",
  converged: "converged",
} as const;

/** One of the engine's own mark names ({@link LOAD_MARKS}). */
export type LoadMarkName = (typeof LOAD_MARKS)[keyof typeof LOAD_MARKS];

/** A moment recorded with {@link LoadTracker.mark}, sent to {@link LoadTracker.onMark} listeners. */
export interface LoadMark {
  /** The mark, e.g. one of {@link LOAD_MARKS} or an app's own. */
  name: string;
  /** When it happened, in ms since the tracker was made (add {@link LoadTracker.origin} for `performance.now()` time). */
  t: number;
}

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
  /** Of `done`, how many came from a cache (models served by the model cache; encodings and bakes by the scene worker's). */
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
  /**
   * Close the task and take back what it ticked as well: its items leave the phase's `done`,
   * `total` and `cached`, as if it had never run. For work whose partial progress was shown but
   * whose result is thrown away (a superseded placement bake). The phase's `done` can drop, but
   * never below 0 or above `total`. After `end()` it does nothing, and the reverse.
   */
  discard(): void;
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
 * One row of the load timeline, from {@link LoadTracker.timeline}: a phase or a mark.
 *
 * A phase that reopened (streaming ground, a pipeline compiled lazily on a later frame) keeps one
 * entry: `start` is its first start, `end` its latest end, and `busy` / `spans` say how much of
 * that stretch it actually worked.
 *
 * A mark ({@link LoadTracker.mark}) is a row of zero length: `phase` holds its name, `start` and
 * `end` its time, and the counts are 0. So a reader that predates marks sees a phase that took no
 * time, and one that knows tells them apart by `kind`.
 */
export interface TimelineEntry {
  /** `phase` for a phase, `mark` for a moment recorded with {@link LoadTracker.mark}. */
  kind: "phase" | "mark";
  /** The phase name, or the mark's name. */
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
  /**
   * The load timeline: one entry per phase and one per mark, in time order (phases by their first
   * start, marks by their time).
   */
  timeline(): TimelineEntry[];
  /**
   * Record a moment, e.g. `load.mark(LOAD_MARKS.firstFrame)` at the page's first picture. `t` is
   * the time in ms since the tracker was made (default now; see {@link LoadTracker.now}), for a
   * moment noticed later than it happened. A name may be marked more than once; every mark is
   * kept. Marks are not phases: they never make the tracker busy, never show in `snapshot()` and
   * do not reach {@link LoadTracker.on} listeners (listen with {@link LoadTracker.onMark}).
   */
  mark(name: string, t?: number): void;
  /** Every mark so far, in time order. */
  marks(): LoadMark[];
  /**
   * Listen to marks. Returns an unsubscribe. A listener that throws is logged with
   * `console.error`, as for {@link LoadTracker.on}.
   */
  onMark(fn: (m: LoadMark) => void): () => void;
  /** Milliseconds since the tracker was made: the time base of every event, entry and mark. */
  now(): number;
  /**
   * The `performance.now()` at which the tracker was made. Add it to any tracker time to get
   * `performance.now()` time, e.g. to line long tasks from a `PerformanceObserver` up with the
   * marks: `lt.startTime > load.origin + firstFrame.t`.
   */
  readonly origin: number;
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
 * before that frame is painted. Three of those steps need not block at all: the renderer's
 * `prepare()` (with `deferPipelines`) compiles pipelines asynchronously, and an instance layer
 * with a scene worker encodes its models there and its `commitAsync()` bakes placement there
 * too. Their phases then span the real work while the page keeps drawing.
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
  const markList: LoadMark[] = [];
  let markListeners: ((m: LoadMark) => void)[] = [];

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
      let fromCache = 0;
      let open = true;
      ph.total += expected;
      if (wasIdle) {
        ph.end = undefined;
        ph.since = t;
        ph.spans++;
        emit(ph, "start", undefined, t);
      } else if (expected > 0) emit(ph, "progress", undefined, t);
      function close(drop: boolean): void {
        if (!open) return;
        open = false;
        ph.total -= expected - finished;
        if (drop && finished > 0) {
          ph.total -= finished;
          ph.done -= finished;
          ph.cached -= fromCache;
          emit(ph, "progress");
        }
        ph.open--;
        if (ph.open === 0) {
          const t = now();
          ph.end = t;
          ph.busyMs += t - ph.since;
          emit(ph, "end", undefined, t);
          settle();
        }
      }
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
          if (info?.cached) {
            ph.cached += n;
            fromCache += n;
          }
          if (finished > expected) {
            ph.total += finished - expected;
            expected = finished;
          }
          emit(ph, "progress", info?.label);
        },
        end: () => close(false),
        discard: () => close(true),
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
      const rows = [...phases.values()].map((p) => {
        const e: TimelineEntry = {
          kind: "phase",
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
      for (const m of markList) {
        rows.push({ kind: "mark", phase: m.name, start: m.t, end: m.t, busy: 0, spans: 0, done: 0, total: 0, cached: 0 });
      }
      // Stable, so phases keep their first-start order and a mark lands after a phase that
      // started at the same instant.
      return rows.sort((a, b) => a.start - b.start);
    },

    mark(name, t = now()) {
      const m: LoadMark = { name, t };
      let i = markList.length;
      while (i > 0 && markList[i - 1].t > t) i--;
      markList.splice(i, 0, m);
      for (const fn of markListeners) {
        try {
          fn({ ...m });
        } catch (err) {
          console.error(`voxolith: a mark listener threw on "${name}"`, err);
        }
      }
    },

    marks: () => markList.map((m) => ({ ...m })),

    onMark(fn) {
      markListeners = [...markListeners, fn];
      return () => {
        markListeners = markListeners.filter((l) => l !== fn);
      };
    },

    now,
    origin: t0,
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
 * done/total and cache hits. A mark is one line too, with `mark` for its length. For logs and
 * `?perf`, not for display.
 *
 * @example
 * ```ts
 * console.log(formatTimeline(load.timeline()));
 * // phase         start      took    done/total  cached
 * // shaders          0 ms    41 ms         1/1
 * // models          52 ms  1830 ms       12/12      12
 * // first-frame   1904 ms     mark
 * ```
 */
export function formatTimeline(entries: readonly TimelineEntry[]): string {
  const ms = (v: number) => `${Math.round(v)} ms`;
  const rows = entries.map((e) => {
    const took = e.kind === "mark" ? "mark" : e.end === undefined ? "running" : ms(e.end - e.start);
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
