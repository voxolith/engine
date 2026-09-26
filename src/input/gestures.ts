// Gestures: turn raw pointers into tap, double-tap, long-press, drag and pinch.
//
// The one rule that matters is that tap versus drag is decided on *total*
// travel since the pointer went down, not on any single move: a slow pan
// crawls a pixel at a time and must still count as a drag. Past the slop a
// pointer is a drag for the rest of its life and can never also be a tap.
//
// A second finger turns a one-finger drag into a pinch (the drag ends with
// `cancelled: true`), and ctrl+wheel — how trackpads report a pinch — arrives
// as the same pinch. After a pinch, nothing is a tap until every finger is up.
//
// Several recognisers can share one input. Give the one that should win a
// higher `priority`, and have it `claim` a pointer in `dragStart` (return
// true); lower-priority recognisers then leave that pointer alone. That is how
// a slingshot aim or an editor tool keeps a finger the camera would otherwise
// take.

import type { Input, PointerKind, PointerState } from "./core";

/** Modifier keys held when the pointer went down. */
export interface Modifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** A tap, double-tap, long-press or press. Position in client pixels. */
export interface TapEvent extends Modifiers {
  x: number;
  y: number;
  type: PointerKind;
  /** Button that went down (0 primary, 1 middle, 2 secondary). */
  button: number;
  pointerId: number;
}

/**
 * One step of a drag, in client pixels. `startX`/`startY` and the totals are measured from where
 * this recogniser's drag began, which after a pinch is where the remaining finger was when it
 * ended.
 */
export interface DragEvent extends Modifiers {
  pointerId: number;
  type: PointerKind;
  button: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  /** Movement since the previous drag event. */
  dx: number;
  dy: number;
  /** Movement since the pointer went down. */
  totalX: number;
  totalY: number;
}

/** One step of a two-finger pinch or a ctrl+wheel (trackpad) pinch. Position in client pixels. */
export interface PinchEvent {
  /** Scale change since the previous pinch event; > 1 spreads the fingers. */
  ratio: number;
  /** Midpoint movement since the previous pinch event. */
  dx: number;
  dy: number;
  /** Midpoint of the two fingers, or the cursor for a wheel pinch. */
  x: number;
  y: number;
  /** A wheel pinch has no midpoint movement (`dx`, `dy` are 0). */
  source: "touch" | "wheel";
}

/** A plain wheel step (not ctrl+wheel, which arrives as a pinch). */
export interface WheelGesture {
  /** Zoom factor for this notch; < 1 zooms in (scroll up / away). */
  ratio: number;
  /** Normalised wheel deltas, pixels. */
  dx: number;
  dy: number;
  /** Cursor position, client pixels. */
  x: number;
  y: number;
}

/**
 * Callbacks for {@link recogniseGestures}; supply only the ones you need. A pointer that becomes a
 * drag, a long-press or part of a pinch never also fires `tap`.
 */
export interface GestureHandlers {
  /** Released within the slop, not cancelled, not after a long-press or pinch. */
  tap?(e: TapEvent): void;
  /** A second tap within `doubleTapMs` and `doubleTapDistance` of the first; `tap` fires too. */
  doubleTap?(e: TapEvent): void;
  /** Held for `longPressMs` without moving past the slop. The release is then not a tap. */
  longPress?(e: TapEvent): void;
  /** Return true to claim the pointer; lower-priority recognisers then ignore it. */
  dragStart?(e: DragEvent): boolean | void;
  drag?(e: DragEvent): void;
  /** `cancelled` when a second finger turned the drag into a pinch, or the pointer was cancelled. */
  dragEnd?(e: DragEvent, cancelled: boolean): void;
  /** A second touch went down; any drag has already ended as cancelled. */
  pinchStart?(): void;
  /** Touch pinches arrive between `pinchStart` and `pinchEnd`; wheel pinches arrive alone. */
  pinch?(e: PinchEvent): void;
  pinchEnd?(): void;
  wheel?(e: WheelGesture): void;
  /**
   * A pointer went down (before it is known what it is). Return true to claim
   * it immediately, e.g. for a slingshot that aims from the first touch.
   */
  press?(e: TapEvent): boolean | void;
}

/** Tuning for {@link recogniseGestures}. Distances in CSS pixels, times in milliseconds. */
export interface GestureOptions {
  /** Travel that turns a press into a drag, per pointer type. Default mouse 6, pen 8, touch 10. */
  slop?: Partial<Record<PointerKind, number>>;
  /** Longest gap between the taps of a double-tap. Default 300. */
  doubleTapMs?: number;
  /** Furthest apart the taps of a double-tap may be. Default 24. */
  doubleTapDistance?: number;
  /** Hold time for a long-press. Default 500; 0 disables long-press. */
  longPressMs?: number;
  /** Which mouse buttons this recogniser responds to. Default all. */
  buttons?: number[];
  /** Which pointer types. Default all. */
  pointerTypes?: PointerKind[];
  /** Order among recognisers on the same input; higher first. */
  priority?: number;
  /** Zoom per pixel of wheel. Default 0.0015 (a mouse notch is ~14%). */
  wheelZoom?: number;
  /** Zoom per pixel of ctrl+wheel. Default 0.01. */
  pinchZoom?: number;
}

/** A running recogniser, from {@link recogniseGestures}. */
export interface Gestures {
  /** This recogniser is dragging at least one pointer. */
  dragging(): boolean;
  /** A two-finger pinch is under way. */
  pinching(): boolean;
  /** Disabling ends any drag (as cancelled) and pinch, and ignores input until re-enabled. */
  setEnabled(on: boolean): void;
  /** Stop listening to the input. */
  dispose(): void;
}

const DEFAULT_SLOP: Record<PointerKind, number> = { mouse: 6, pen: 8, touch: 10 };

const mods = (p: PointerState): Modifiers => ({ shiftKey: p.shiftKey, ctrlKey: p.ctrlKey, altKey: p.altKey, metaKey: p.metaKey });
const tapOf = (p: PointerState): TapEvent => ({ x: p.x, y: p.y, type: p.type, button: p.button, pointerId: p.id, ...mods(p) });

/**
 * Recognise taps, double-taps, long-presses, drags, pinches and wheel steps on an input. Tap
 * versus drag is decided on total travel since the pointer went down, so a slow pan still counts
 * as a drag. Several recognisers can share one input: the one with the higher `priority` hears
 * events first and can claim a pointer from `press` or `dragStart` by returning true.
 *
 * @param input - The surface's input, from {@link createInput}.
 * @param h - The handlers to call.
 * @returns A handle to query, disable or dispose the recogniser.
 * @example
 * ```ts
 * // Beside an orbit controller: a tap picks, a drag still turns the camera.
 * recogniseGestures(input, { tap: (t) => pick(t.x, t.y) }, { longPressMs: 0 });
 * ```
 */
export function recogniseGestures(input: Input, h: GestureHandlers, opts: GestureOptions = {}): Gestures {
  const slop = { ...DEFAULT_SLOP, ...opts.slop };
  const doubleMs = opts.doubleTapMs ?? 300;
  const doubleDist = opts.doubleTapDistance ?? 24;
  const longMs = opts.longPressMs ?? 500;
  const wheelZoom = opts.wheelZoom ?? 0.0015;
  const pinchZoom = opts.pinchZoom ?? 0.01;
  const me = {};
  let enabled = true;

  /** Pointers this recogniser is following, and whether each became a drag. */
  interface Tracked { p: PointerState; drag: boolean; timer: ReturnType<typeof setTimeout> | null; long: boolean; sx: number; sy: number; travel0: number }
  const mine = new Map<number, Tracked>();
  let pinch: { dist: number; mx: number; my: number } | null = null;
  /** After a pinch, taps are off until every finger lifts. */
  let noTaps = false;
  let lastTap: { t: number; x: number; y: number } | null = null;

  const accepts = (p: PointerState) =>
    enabled &&
    (!opts.pointerTypes || opts.pointerTypes.includes(p.type)) &&
    (p.type !== "mouse" || !opts.buttons || opts.buttons.includes(p.button));

  // Pointer state is shared by every recogniser on the input, so each keeps
  // its own baseline (a pinch re-baselines the finger left behind).
  const dragOf = (m: Tracked): DragEvent => {
    const p = m.p;
    return {
      pointerId: p.id, type: p.type, button: p.button,
      x: p.x, y: p.y, startX: m.sx, startY: m.sy,
      dx: p.x - p.lastX, dy: p.y - p.lastY, totalX: p.x - m.sx, totalY: p.y - m.sy, ...mods(p),
    };
  };

  const touches = () => [...mine.values()].filter((m) => m.p.type === "touch");
  const pinchGeom = () => {
    const [a, b] = touches();
    return { dist: Math.max(1, Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y)), mx: (a.p.x + b.p.x) / 2, my: (a.p.y + b.p.y) / 2 };
  };
  const clearTimer = (m: { timer: ReturnType<typeof setTimeout> | null }) => {
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
  };

  const startPinch = () => {
    for (const m of mine.values()) {
      clearTimer(m);
      if (m.drag) {
        m.drag = false;
        h.dragEnd?.(dragOf(m), true);
      }
    }
    pinch = pinchGeom();
    noTaps = true;
    h.pinchStart?.();
  };
  const endPinch = () => {
    if (!pinch) return;
    pinch = null;
    h.pinchEnd?.();
    // The finger left behind starts afresh from where it is, so the camera
    // does not jump by everything it moved during the pinch.
    for (const m of mine.values()) {
      m.sx = m.p.x;
      m.sy = m.p.y;
      m.travel0 = m.p.travel;
    }
  };

  const unsubscribe = input.on((e) => {
    if (e.kind === "wheel") {
      if (!enabled) return;
      if (e.pinch) h.pinch?.({ ratio: Math.exp(-e.dy * pinchZoom), dx: 0, dy: 0, x: e.x, y: e.y, source: "wheel" });
      else h.wheel?.({ ratio: Math.exp(e.dy * wheelZoom), dx: e.dx, dy: e.dy, x: e.x, y: e.y });
      return;
    }
    if (e.kind !== "pointer") return;
    const p = e.pointer;
    const owner = input.claimedBy(p.id);
    if (owner && owner !== me) {
      // Someone else has it: if we were tracking it, let go quietly.
      const m = mine.get(p.id);
      if (m) {
        clearTimer(m);
        if (m.drag) h.dragEnd?.(dragOf(m), true);
        mine.delete(p.id);
      }
      return;
    }

    if (e.phase === "down") {
      if (!accepts(p)) return;
      const m: Tracked = { p, drag: false, timer: null, long: false, sx: p.x, sy: p.y, travel0: p.travel };
      mine.set(p.id, m);
      if (h.press?.(tapOf(p)) === true) input.claim(p.id, me);
      if (touches().length === 2 && p.type === "touch") {
        startPinch();
        return;
      }
      if (longMs > 0 && h.longPress && !pinch) {
        m.timer = setTimeout(() => {
          m.timer = null;
          if (!m.drag && mine.get(p.id) === m && !pinch) {
            m.long = true;
            h.longPress!(tapOf(p));
          }
        }, longMs);
      }
      return;
    }

    const m = mine.get(p.id);
    if (!m) return;

    if (e.phase === "move") {
      if (pinch) {
        if (touches().length >= 2) {
          const now = pinchGeom();
          const ratio = now.dist / pinch.dist;
          const dx = now.mx - pinch.mx, dy = now.my - pinch.my;
          pinch = now;
          if (ratio !== 1 || dx || dy) h.pinch?.({ ratio, dx, dy, x: now.mx, y: now.my, source: "touch" });
        }
        return;
      }
      if (!m.drag && !m.long && p.travel - m.travel0 > slop[p.type]) {
        clearTimer(m);
        m.drag = true;
        const d = dragOf(m);
        if (h.dragStart?.(d) === true) input.claim(p.id, me);
        // Report the movement that crossed the slop too, so nothing is lost.
        h.drag?.({ ...d, dx: p.x - m.sx, dy: p.y - m.sy });
        return;
      }
      if (m.drag) h.drag?.(dragOf(m));
      return;
    }

    // up / cancel
    clearTimer(m);
    mine.delete(p.id);
    const cancelled = e.phase === "cancel";
    if (pinch) {
      if (touches().length < 2) endPinch();
    } else if (m.drag) {
      h.dragEnd?.(dragOf(m), cancelled);
    } else if (!cancelled && !noTaps && !m.long) {
      const t = tapOf(p);
      h.tap?.(t);
      const now = performance.now();
      if (h.doubleTap && lastTap && now - lastTap.t < doubleMs && Math.hypot(t.x - lastTap.x, t.y - lastTap.y) < doubleDist) {
        lastTap = null;
        h.doubleTap(t);
      } else lastTap = { t: now, x: t.x, y: t.y };
    }
    if (mine.size === 0) noTaps = false;
  }, opts.priority ?? 0);

  return {
    dragging: () => [...mine.values()].some((m) => m.drag),
    pinching: () => pinch !== null,
    setEnabled(on) {
      enabled = on;
      if (!on) {
        for (const m of mine.values()) {
          clearTimer(m);
          if (m.drag) h.dragEnd?.(dragOf(m), true);
        }
        mine.clear();
        if (pinch) endPinch();
      }
    },
    dispose() {
      for (const m of mine.values()) clearTimer(m);
      mine.clear();
      unsubscribe();
    },
  };
}
