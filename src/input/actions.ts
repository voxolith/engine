// Actions: what the game means, bound to whatever the player has.
//
// A game asks for `jump` or `steer`, never for Space or the left stick. Each
// action lists its sources, so the same code runs on a keyboard, a gamepad and
// a phone, and rebinding is a matter of editing a list:
//
//   key:KeyW          a key, by KeyboardEvent.code (physical, layout-independent)
//   pad:A             a gamepad button (value 0..1, so triggers are analog)
//   pad:LeftX         a signed stick axis, -1..1
//   touch:jump        an on-screen control (see touch.ts); touch:move.x for a joystick axis
//   ...+ / ...-       one half of any signed source, 0..1: pad:LeftY- or touch:move.y- is
//                     the stick pushed up (screen and pad Y are down-positive)
//
// Buttons are held when any source is; axes combine a negative and a positive
// list of digital sources with signed analog ones, and take whichever is
// pushed hardest, so a half-tilted stick is not overridden by a stale key.

import type { Input, PadAxis, PadButton } from "./core";
import { PAD_AXES, PAD_BUTTONS } from "./core";

/** A button action: held when any source is; its value is the strongest source, 0..1. */
export interface ButtonBinding {
  kind: "button";
  /** Source strings such as `key:Space`, `pad:A`, `touch:jump`. */
  sources: string[];
}

/**
 * An axis action, -1..1. The digital result is (strongest positive) minus (strongest negative);
 * the strongest analog source wins over it when pushed harder.
 */
export interface AxisBinding {
  kind: "axis";
  /** Digital or half-axis sources that push towards -1. */
  negative?: string[];
  /** ... and towards +1. */
  positive?: string[];
  /** Signed sources, -1..1 (pad:LeftX, touch:move.x). */
  analog?: string[];
}

/** How one action reads its sources. Plain JSON, so bindings can be saved and restored. */
export type Binding = ButtonBinding | AxisBinding;
/** An action map: action name to binding. */
export type Bindings = Record<string, Binding>;

/** Shorthand for a {@link ButtonBinding}: `button("key:Space", "pad:A", "touch:jump")`. */
export const button = (...sources: string[]): ButtonBinding => ({ kind: "button", sources });
/** Shorthand for an {@link AxisBinding}: `axis({ negative: ["key:KeyA"], positive: ["key:KeyD"], analog: ["pad:LeftX"] })`. */
export const axis = (b: Omit<AxisBinding, "kind">): AxisBinding => ({ kind: "axis", ...b });

/**
 * Named game controls over an input, from {@link makeActions}. Values are read live from the
 * input; edges (`pressed`, `released`) follow its `update()`.
 */
export interface Actions<B extends Bindings = Bindings> {
  /** Held (a button), or pushed past half-way (an axis, either direction). */
  down(name: keyof B & string): boolean;
  /** Went down / up since the previous `input.update()`. */
  pressed(name: keyof B & string): boolean;
  /** A source went up since the previous `input.update()` and the action is no longer down. */
  released(name: keyof B & string): boolean;
  /** -1..1 for axes, 0..1 for buttons. */
  value(name: keyof B & string): number;
  /** Two axes as a vector, clamped to the unit circle so diagonals are not faster. */
  vector(x: keyof B & string, y: keyof B & string): [number, number];
  /** Replace one action's binding (the binding is copied). */
  bind(name: keyof B & string, binding: Binding): void;
  /** The current bindings as plain JSON, for saving a player's rebinding. */
  bindings(): B;
  /** Restore saved bindings; unknown names are ignored, missing ones keep their defaults. */
  load(saved: Partial<Record<string, Binding>>): void;
  /** Every key code any action uses. */
  keys(): string[];
}

const isButton = (s: string): s is PadButton => (PAD_BUTTONS as readonly string[]).includes(s);
const isAxis = (s: string): s is PadAxis => (PAD_AXES as readonly string[]).includes(s);

/**
 * Bind named actions to keys, gamepad and on-screen controls. Sources are strings:
 * `key:<KeyboardEvent.code>`, `pad:<PadButton>` (0..1), `pad:<PadAxis>` (-1..1),
 * `touch:<id>` (a {@link makeTouchControls} control; a joystick adds `<id>.x` and `<id>.y`), and a
 * trailing `+` or `-` for one half of a signed source. Screen and pad Y are down-positive, so
 * "stick pushed up" is `pad:LeftY-`.
 *
 * Every bound key has its default action prevented, so bound keys do not scroll the page.
 *
 * @param input - The surface's input. Call `input.update()` once per frame before reading.
 * @param defaults - The action map; it is copied, and `bindings()` returns the current one.
 * @returns The actions, typed by the names in `defaults`.
 * @example
 * ```ts
 * const actions = makeActions(input, {
 *   strafe: axis({ negative: ["key:KeyA"], positive: ["key:KeyD"], analog: ["pad:LeftX", "touch:move.x"] }),
 *   // Up is negative on a stick, so each half goes to the opposite side.
 *   walk: axis({ negative: ["key:KeyS", "pad:LeftY+", "touch:move.y+"], positive: ["key:KeyW", "pad:LeftY-", "touch:move.y-"] }),
 *   jump: button("key:Space", "pad:A", "touch:jump"),
 * });
 * // per frame, after input.update():
 * const [x, z] = actions.vector("strafe", "walk");
 * if (actions.pressed("jump")) jump();
 * ```
 */
export function makeActions<B extends Bindings>(input: Input, defaults: B): Actions<B> {
  const map: Bindings = structuredClone(defaults);
  // Keep bound keys from scrolling the page or moving the caret.
  const recapture = () => input.captureKeys(keysOf());

  /** Current value of one source: 0..1 for buttons and half-axes, -1..1 for signed axes. */
  const read = (src: string): number => {
    const i = src.indexOf(":");
    const dev = src.slice(0, i);
    let id = src.slice(i + 1);
    // A trailing + or - takes one half of a signed source, for any device.
    const half = id.endsWith("+") ? 1 : id.endsWith("-") ? -1 : 0;
    if (half) id = id.slice(0, -1);
    let v = 0;
    if (dev === "key") v = input.down(id) ? 1 : 0;
    else if (dev === "touch") v = input.virtual(id);
    else if (dev === "pad") {
      const pad = input.gamepad();
      if (pad && isButton(id)) v = pad.buttons[id];
      else if (pad && isAxis(id)) v = pad.axes[id];
    }
    return half ? Math.max(0, v * half) : v;
  };
  const edge = (src: string, up: boolean): boolean => {
    const i = src.indexOf(":");
    const dev = src.slice(0, i), id = src.slice(i + 1);
    if (dev === "key") return up ? input.released(id) : input.pressed(id);
    if (dev === "touch") return up ? input.virtualReleased(id) : input.virtualPressed(id);
    if (dev === "pad" && isButton(id)) return up ? input.padReleased(id) : input.padPressed(id);
    return false;
  };

  const value = (name: string): number => {
    const b = map[name];
    if (!b) return 0;
    if (b.kind === "button") {
      let v = 0;
      for (const s of b.sources) v = Math.max(v, Math.abs(read(s)));
      return v;
    }
    let neg = 0, pos = 0, analog = 0;
    for (const s of b.negative ?? []) neg = Math.max(neg, Math.abs(read(s)));
    for (const s of b.positive ?? []) pos = Math.max(pos, Math.abs(read(s)));
    for (const s of b.analog ?? []) {
      const v = read(s);
      if (Math.abs(v) > Math.abs(analog)) analog = v;
    }
    const digital = pos - neg;
    return Math.max(-1, Math.min(1, Math.abs(analog) > Math.abs(digital) ? analog : digital));
  };

  const sourcesOf = (b: Binding): string[] =>
    b.kind === "button" ? b.sources : [...(b.negative ?? []), ...(b.positive ?? []), ...(b.analog ?? [])];
  function keysOf(): string[] {
    const out = new Set<string>();
    for (const b of Object.values(map)) for (const s of sourcesOf(b)) if (s.startsWith("key:")) out.add(s.slice(4));
    return [...out];
  }
  recapture();

  return {
    down: (name) => Math.abs(value(name)) > 0.5,
    pressed: (name) => {
      const b = map[name];
      return !!b && sourcesOf(b).some((s) => edge(s, false));
    },
    released: (name) => {
      const b = map[name];
      return !!b && sourcesOf(b).some((s) => edge(s, true)) && Math.abs(value(name)) <= 0.5;
    },
    value,
    vector(x, y) {
      const vx = value(x), vy = value(y);
      const m = Math.hypot(vx, vy);
      return m > 1 ? [vx / m, vy / m] : [vx, vy];
    },
    bind(name, binding) {
      map[name] = structuredClone(binding);
      recapture();
    },
    bindings: () => structuredClone(map) as B,
    load(saved) {
      for (const [k, b] of Object.entries(saved)) if (k in map && b && (b.kind === "button" || b.kind === "axis")) map[k] = structuredClone(b);
      recapture();
    },
    keys: keysOf,
  };
}
