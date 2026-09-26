// First-person look: yaw and pitch from whatever the player has.
//
// Desktop: click the surface to capture the mouse (pointer lock), move to look,
// Esc to let go. Without a lock — before the first click, or where the browser
// refuses one — dragging looks too. Touch: drag anywhere that is not an
// on-screen control. Gamepad: the right stick. Keys: optional turn keys.
//
// Deltas are gathered as they arrive and applied in `update(dt)`, once a frame,
// so look speed from sticks and keys is framerate-independent and the mouse is
// never double-counted.

import type { Input } from "./core";
import { recogniseGestures, type GestureOptions } from "./gestures";

/** Options for {@link makeLookController}. Angles in degrees, rates in degrees per second. */
export interface LookOptions {
  /** Initial yaw, degrees. Default 0 (facing +Z in `firstPersonFrame`). */
  yaw?: number;
  /** Initial pitch, degrees; positive looks up. Default 0. */
  pitch?: number;
  /** Degrees per pixel while pointer-locked. Default 0.12. */
  lockSensitivity?: number;
  /** Degrees per pixel of drag (touch, or mouse without lock). Default 0.25. */
  dragSensitivity?: number;
  /** Clamp pitch (degrees). Default [-85, 85]. */
  pitchLimits?: [number, number];
  /** Ask for pointer lock when the surface is clicked with a mouse. Default true. */
  pointerLock?: boolean;
  /** Right-stick turn rate, degrees per second at full deflection. Default 160. */
  stickRate?: number;
  /** Key codes that turn, at `keyRate` degrees per second. */
  keys?: { left?: string[]; right?: string[]; up?: string[]; down?: string[] };
  /** Turn rate for `keys`, degrees per second. Default 100. */
  keyRate?: number;
  /** Invert vertical look for mouse, touch and stick (not keys). */
  invertY?: boolean;
  /** Gesture tuning and priority among recognisers on the same input. */
  gestures?: GestureOptions;
}

/**
 * A first-person camera's yaw and pitch, from {@link makeLookController}. Turning right increases
 * yaw, matching `firstPersonFrame` (screen-right is `cross(forward, up)`).
 */
export interface LookController {
  /**
   * Apply what was gathered since last frame; call once per frame after `input.update()`.
   * `dt` is in seconds and scales stick and key turning.
   */
  update(dt: number): void;
  /** Degrees; unbounded. */
  yaw(): number;
  /** Degrees, within `pitchLimits`. */
  pitch(): number;
  /** Set the view from code; pitch is clamped. */
  set(yaw: number, pitch?: number): void;
  /** Disabling drops pending movement and releases pointer lock. */
  setEnabled(on: boolean): void;
  /** Stop listening to the input. */
  dispose(): void;
}

/**
 * First-person look from mouse (pointer lock after a click, or drag without it), touch drag,
 * the right stick and optional turn keys. Movement is gathered as events arrive and applied in
 * `update(dt)`, so stick and key speed is framerate-independent and the mouse is counted once.
 *
 * @param input - The surface's input. Touches on {@link makeTouchControls} controls never reach it.
 * @returns The look state; feed `yaw()` and `pitch()` to the renderer's `firstPersonFrame`.
 * @example
 * ```ts
 * const look = makeLookController(input, { pitch: -10, keys: { left: ["KeyQ"], right: ["KeyE"] } });
 * // per frame:
 * input.update();
 * look.update(dt);
 * const y = (look.yaw() * Math.PI) / 180;
 * const forward = [Math.sin(y), Math.cos(y)], right = [-Math.cos(y), Math.sin(y)];
 * ```
 */
export function makeLookController(input: Input, opts: LookOptions = {}): LookController {
  let yaw = opts.yaw ?? 0;
  let pitch = opts.pitch ?? 0;
  const [pMin, pMax] = opts.pitchLimits ?? [-85, 85];
  const lockSens = opts.lockSensitivity ?? 0.12;
  const dragSens = opts.dragSensitivity ?? 0.25;
  const stickRate = opts.stickRate ?? 160;
  const keyRate = opts.keyRate ?? 100;
  const inv = opts.invertY ? -1 : 1;
  let enabled = true;
  let dYaw = 0, dPitch = 0;

  // Moving the mouse right turns right. With firstPersonFrame's basis (yaw 0
  // faces +Z, screen-right is cross(forward, up)) turning right increases yaw.
  const offLook = input.on((e) => {
    if (e.kind !== "look" || !enabled) return;
    dYaw += e.dx * lockSens;
    dPitch -= e.dy * lockSens * inv;
  });
  const g = recogniseGestures(
    input,
    {
      tap(t) {
        if (enabled && opts.pointerLock !== false && t.type === "mouse" && !input.locked()) input.lock();
      },
      drag(d) {
        if (!enabled || input.locked()) return;
        dYaw += d.dx * dragSens;
        dPitch -= d.dy * dragSens * inv;
      },
    },
    { longPressMs: 0, ...opts.gestures },
  );

  const held = (codes?: string[]) => (codes ?? []).some((c) => input.down(c));
  if (opts.keys) input.captureKeys([...(opts.keys.left ?? []), ...(opts.keys.right ?? []), ...(opts.keys.up ?? []), ...(opts.keys.down ?? [])]);

  return {
    update(dt) {
      if (enabled) {
        const pad = input.gamepad();
        if (pad) {
          dYaw += pad.axes.RightX * stickRate * dt;
          dPitch -= pad.axes.RightY * stickRate * dt * inv;
        }
        const k = opts.keys;
        if (k) {
          dYaw += ((held(k.right) ? 1 : 0) - (held(k.left) ? 1 : 0)) * keyRate * dt;
          dPitch += ((held(k.up) ? 1 : 0) - (held(k.down) ? 1 : 0)) * keyRate * dt;
        }
      }
      yaw += dYaw;
      pitch = Math.max(pMin, Math.min(pMax, pitch + dPitch));
      dYaw = dPitch = 0;
    },
    yaw: () => yaw,
    pitch: () => pitch,
    set(y, p) {
      yaw = y;
      if (p !== undefined) pitch = Math.max(pMin, Math.min(pMax, p));
    },
    setEnabled(on) {
      enabled = on;
      g.setEnabled(on);
      if (!on) {
        dYaw = dPitch = 0;
        input.unlock();
      }
    },
    dispose() {
      offLook();
      g.dispose();
    },
  };
}
