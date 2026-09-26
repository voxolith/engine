// Orbit camera controller: rotate, zoom and pan around a target.
//
// One controller for every orbit-style view: a turntable viewer (yaw and
// pitch, zoom), a room you can only look around within (yaw clamped, no
// pitch), an RTS map (no rotation, primary drag pans, zoom). The state is the
// shape the renderer's `makeCamera` frame takes, so:
//
//   const orbit = makeOrbitController(input, { distance: 300, distanceLimits: [60, 900] });
//   render({ ...camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch()) });
//
// Desktop: primary drag rotates, right/middle or shift+drag pans, wheel zooms,
// ctrl+wheel (trackpad pinch) zooms. Touch: one finger rotates, two fingers
// pinch to zoom and drag to pan (or to rotate, when panning is off).

import type { Input } from "./core";
import { recogniseGestures, type DragEvent, type GestureOptions } from "./gestures";

type Vec3 = [number, number, number];

/**
 * Options for {@link makeOrbitController}. Angles are in degrees; distance and target are in
 * world units (voxels), as the renderer's `makeCamera` takes them.
 */
export interface OrbitOptions {
  /** Initial yaw, degrees. Default 35. */
  yaw?: number;
  /** Initial pitch above the horizon, degrees. Default 25. */
  pitch?: number;
  /** Initial distance from the target. Default 100. */
  distance?: number;
  /** Initial point orbited. Default the origin. */
  target?: Vec3;
  /** Clamp yaw (degrees). Default unbounded. */
  yawLimits?: [number, number];
  /** Clamp pitch (degrees). Default [3, 87]. */
  pitchLimits?: [number, number];
  /** Clamp distance. Default [1, Infinity]. */
  distanceLimits?: [number, number];
  /** Which drags rotate: "both" axes, "yaw" only, or "none" (a pan-only map). Default "both". */
  rotate?: "both" | "yaw" | "none";
  /** Degrees per pixel of drag. Default 0.35. */
  sensitivity?: number;
  /** Wheel and pinch zoom. Default true. */
  zoom?: boolean;
  /**
   * How to pan: "secondary" (right/middle/shift-drag, two-finger drag), "primary"
   * (any one-pointer drag, for maps; pairs with rotate "none"), or "none". Default "none".
   */
  pan?: "secondary" | "primary" | "none";
  /** Clamp the target on XZ. */
  panBounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Vertical field of view, so a pan tracks the cursor. Default 45. */
  fovDeg?: number;
  /** Called on any change (hook a render-on-demand loop here, or pass `loop` to the input). */
  onChange?: () => void;
  /** Gesture tuning and priority among recognisers on the same input. */
  gestures?: GestureOptions;
}

/**
 * An orbit camera's state, from {@link makeOrbitController}. Dragging right decreases `yaw()`
 * (the scene turns with the pointer); dragging down raises `pitch()`.
 */
export interface OrbitController {
  /** Degrees. */
  yaw(): number;
  /** Degrees above the horizon. */
  pitch(): number;
  distance(): number;
  /** The point orbited. Replaced, not mutated, when it changes. */
  target(): Vec3;
  /** Move the camera from code; values are clamped to the limits and `onChange` fires. */
  set(state: Partial<{ yaw: number; pitch: number; distance: number; target: Vec3 }>): void;
  /** A drag or pinch is under way (e.g. to stop an idle turntable). */
  interacting(): boolean;
  /** Ignore input while disabled; `set` still works. */
  setEnabled(on: boolean): void;
  /** Stop listening to the input. */
  dispose(): void;
}

/**
 * An orbit camera over an input: turntable, look-around room or pan-only map, depending on
 * `rotate` and `pan`. Desktop: primary drag rotates, right/middle or shift+drag pans (with
 * `pan: "secondary"`), wheel and ctrl+wheel zoom. Touch: one finger rotates, two pinch to zoom
 * and drag to pan (or to turn, when panning is off). Long-press is off in its recogniser.
 *
 * The controller only holds state; read it each frame into the renderer's `makeCamera`.
 *
 * @param input - The surface's input.
 * @returns The camera state and controls.
 * @example
 * ```ts
 * const camera = makeCamera({ target: [48, 8, 48], distance: 200, pitchDeg: 32, fovDeg: 35 });
 * const orbit = makeOrbitController(input, {
 *   yaw: 35, pitch: 32, distance: 200, distanceLimits: [40, 600],
 *   target: [48, 8, 48], pan: "secondary", fovDeg: 35, onChange: () => loop.invalidate(),
 * });
 * renderer.render({ ...camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch()) });
 * ```
 */
export function makeOrbitController(input: Input, opts: OrbitOptions = {}): OrbitController {
  let yaw = opts.yaw ?? 35;
  let pitch = opts.pitch ?? 25;
  let dist = opts.distance ?? 100;
  let target: Vec3 = [...(opts.target ?? [0, 0, 0])] as Vec3;
  const [yMin, yMax] = opts.yawLimits ?? [-Infinity, Infinity];
  const [pMin, pMax] = opts.pitchLimits ?? [3, 87];
  const [dMin, dMax] = opts.distanceLimits ?? [1, Infinity];
  const rotate = opts.rotate ?? "both";
  const pan = opts.pan ?? "none";
  const sens = opts.sensitivity ?? 0.35;
  const tanHalf = Math.tan(((opts.fovDeg ?? 45) * Math.PI) / 360);
  const zoom = opts.zoom !== false;

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const changed = () => opts.onChange?.();

  const rotateBy = (dx: number, dy: number) => {
    if (rotate === "none") return;
    // Drag right: the scene turns right, so the camera's yaw decreases.
    const ny = clamp(yaw - dx * sens, yMin, yMax);
    const np = rotate === "both" ? clamp(pitch + dy * sens, pMin, pMax) : pitch;
    if (ny !== yaw || np !== pitch) {
      yaw = ny;
      pitch = np;
      changed();
    }
  };
  const zoomBy = (ratio: number) => {
    if (!zoom || !isFinite(ratio) || ratio <= 0) return;
    const nd = clamp(dist * ratio, dMin, dMax);
    if (nd !== dist) {
      dist = nd;
      changed();
    }
  };
  /** Slide the target so the ground follows the pointer. */
  const panBy = (dx: number, dy: number) => {
    const h = (input.el as HTMLElement).clientHeight || 600;
    const k = (2 * dist * tanHalf) / h;
    const y = (yaw * Math.PI) / 180;
    // Camera right on the ground is (cos, 0, -sin); forward is (-sin, 0, -cos).
    const rx = Math.cos(y), rz = -Math.sin(y);
    const fx = -Math.sin(y), fz = -Math.cos(y);
    let tx = target[0] - (dx * rx - dy * fx) * k;
    let tz = target[2] - (dx * rz - dy * fz) * k;
    const b = opts.panBounds;
    if (b) {
      tx = clamp(tx, b.minX, b.maxX);
      tz = clamp(tz, b.minZ, b.maxZ);
    }
    if (tx !== target[0] || tz !== target[2]) {
      target = [tx, target[1], tz];
      changed();
    }
  };

  const wantsPan = (d: DragEvent) =>
    pan === "primary" || (pan === "secondary" && d.type === "mouse" && (d.button === 1 || d.button === 2 || d.shiftKey));
  let mode: "rotate" | "pan" | null = null;

  const g = recogniseGestures(
    input,
    {
      dragStart(d) {
        mode = wantsPan(d) ? "pan" : "rotate";
      },
      drag(d) {
        if (mode === "pan") panBy(d.dx, d.dy);
        else rotateBy(d.dx, d.dy);
      },
      dragEnd() {
        mode = null;
      },
      pinch(p) {
        zoomBy(1 / p.ratio);
        if (p.source !== "touch") return;
        if (pan !== "none") panBy(p.dx, p.dy);
        else rotateBy(p.dx, 0);
      },
      wheel(w) {
        zoomBy(w.ratio);
      },
    },
    { longPressMs: 0, ...opts.gestures },
  );

  return {
    yaw: () => yaw,
    pitch: () => pitch,
    distance: () => dist,
    target: () => target,
    set(s) {
      if (s.yaw !== undefined) yaw = clamp(s.yaw, yMin, yMax);
      if (s.pitch !== undefined) pitch = clamp(s.pitch, pMin, pMax);
      if (s.distance !== undefined) dist = clamp(s.distance, dMin, dMax);
      if (s.target) target = [...s.target] as Vec3;
      changed();
    },
    interacting: () => g.dragging() || g.pinching(),
    setEnabled: (on) => g.setEnabled(on),
    dispose: () => g.dispose(),
  };
}
