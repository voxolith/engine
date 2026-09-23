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

export interface LookOptions {
  yaw?: number;
  pitch?: number;
  /** Degrees per pixel while pointer-locked. Default 0.12. */
  lockSensitivity?: number;
  /** Degrees per pixel of drag (touch, or mouse without lock). Default 0.25. */
  dragSensitivity?: number;
  /** Default [-85, 85]. */
  pitchLimits?: [number, number];
  /** Ask for pointer lock when the surface is clicked with a mouse. Default true. */
  pointerLock?: boolean;
  /** Right-stick turn rate, degrees per second at full deflection. Default 160. */
  stickRate?: number;
  /** Key codes that turn, at `keyRate` degrees per second. */
  keys?: { left?: string[]; right?: string[]; up?: string[]; down?: string[] };
  keyRate?: number;
  invertY?: boolean;
  gestures?: GestureOptions;
}

export interface LookController {
  /** Apply what was gathered since last frame; call once per frame after `input.update()`. */
  update(dt: number): void;
  yaw(): number;
  pitch(): number;
  set(yaw: number, pitch?: number): void;
  setEnabled(on: boolean): void;
  dispose(): void;
}

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
