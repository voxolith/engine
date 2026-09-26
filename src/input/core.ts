// The input core: one object per surface that owns every listener.
//
// Everything above this — gestures, actions, touch controls, camera
// controllers — reads from it instead of adding its own listeners, which is
// what lets two things share a canvas without both reacting to the same finger,
// and what makes the whole lot disposable in one call.
//
// Pointer Events cover mouse, pen and touch. Keys are tracked by `code`
// (physical position), so WASD stays WASD on AZERTY. Wheel deltas are
// normalised across `deltaMode`s and ctrl+wheel (how a trackpad reports a
// pinch) is flagged as a pinch. The first connected gamepad is polled in
// `update()`. A virtual channel lets on-screen controls feed values in beside
// the physical devices.
//
// Frame integration: pass a FrameLoop and every event invalidates it; while
// `active()` is true (keys held, pointer down, pad deflected, a touch control
// held), render continuously:
//
//   loop.setContinuous(game.animating() || input.active())

/** The kind of pointer, from `PointerEvent.pointerType`; anything unrecognised counts as mouse. */
export type PointerKind = "mouse" | "touch" | "pen";
/** What the player used last (`Input.lastDevice`), for choosing prompts and touch controls. */
export type Device = PointerKind | "keyboard" | "gamepad";

/**
 * A pointer that is down on the surface, as tracked by {@link Input}. The object is shared by
 * every listener on the input and updated in place, so copy what you need to keep.
 */
export interface PointerState {
  /** `PointerEvent.pointerId`. */
  id: number;
  type: PointerKind;
  /** Current position, client pixels. */
  x: number;
  y: number;
  /** Position when the pointer went down, client pixels. */
  startX: number;
  startY: number;
  /** Position at the previous move, for per-event deltas. */
  lastX: number;
  lastY: number;
  /** Total distance moved since down, in pixels. Tap vs drag is decided on this. */
  travel: number;
  /** Button that went down (0 primary, 1 middle, 2 secondary). */
  button: number;
  /** Time the pointer went down, in milliseconds on the input's clock (`InputOptions.now`). */
  t0: number;
  /** Modifier keys held when the pointer went down. */
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Stage of a pointer's life. `cancel` also covers a lost pointer capture. */
export type PointerPhase = "down" | "move" | "up" | "cancel";

/**
 * A normalised event, delivered to `Input.on` listeners. `look` carries raw mouse movement while
 * the pointer is locked (no pointer events are sent then); `source` is the DOM event behind the
 * others.
 */
export type InputEvent =
  | { kind: "pointer"; phase: PointerPhase; pointer: PointerState; source: Event }
  | {
      kind: "wheel";
      /** Normalised pixel deltas. */
      dx: number;
      dy: number;
      /** ctrl+wheel: a trackpad pinch (or ctrl+scroll). */
      pinch: boolean;
      x: number;
      y: number;
      source: Event;
    }
  | { kind: "key"; phase: "down" | "up"; code: string; repeat: boolean; source: Event }
  | { kind: "look"; dx: number; dy: number };

/** A snapshot of the first connected gamepad, taken in `Input.update`. */
export interface GamepadState {
  /** `Gamepad.id`. */
  id: string;
  /** Standard-mapping button values 0..1, by name. */
  buttons: Record<PadButton, number>;
  /** Sticks after a radial deadzone, -1..1 (Y is down-positive, as the API reports). */
  axes: Record<PadAxis, number>;
}

/** Gamepad button names in standard-mapping order (index 0 is A, the bottom face button). */
export const PAD_BUTTONS = [
  "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "LS", "RS", "DUp", "DDown", "DLeft", "DRight", "Home",
] as const;
/** Gamepad stick axis names in standard-mapping order. */
export const PAD_AXES = ["LeftX", "LeftY", "RightX", "RightY"] as const;
/** A standard-mapping gamepad button, as used in `pad:<name>` action sources. */
export type PadButton = (typeof PAD_BUTTONS)[number];
/** A standard-mapping stick axis, as used in `pad:<name>` action sources. */
export type PadAxis = (typeof PAD_AXES)[number];

/** The minimum of a FrameLoop the input needs. */
export interface Invalidatable {
  invalidate(): void;
}

/** Options for {@link createInput}. Most are injection points for tests and headless use. */
export interface InputOptions {
  /** Invalidated on every event, so render-on-demand apps redraw. */
  loop?: Invalidatable;
  /** Where key events are read. Default `window`. */
  keyTarget?: EventTarget;
  /** Where pointer-lock changes are reported. Default `document`. */
  lockTarget?: EventTarget & { pointerLockElement?: unknown; exitPointerLock?: () => void };
  /** Stick deadzone, radial. Default 0.15. */
  deadzone?: number;
  /** Stop the page scrolling or zooming on wheel over the surface. Default true. */
  captureWheel?: boolean;
  /** Clock in milliseconds. Default `performance.now`. */
  now?: () => number;
  /** Gamepad source. Default `navigator.getGamepads`. */
  getGamepads?: () => ArrayLike<Gamepad | null>;
}

/**
 * The input for one surface, made by {@link createInput}. It owns every listener; gestures,
 * actions, touch controls and camera controllers read from it rather than adding their own.
 *
 * Edge queries (`pressed`, `released`, `padPressed`, `virtualPressed`, ...) report what changed
 * between the last two `update()` calls, so call `update()` once per frame before reading them.
 */
export interface Input {
  /** The surface the pointer and wheel listeners are on. */
  readonly el: EventTarget;
  /** Live pointers, by id. */
  pointers(): ReadonlyMap<number, PointerState>;
  /**
   * Listen to normalised events. Higher `priority` hears them first; see
   * `claim`. Returns an unsubscribe.
   */
  on(fn: (e: InputEvent) => void, priority?: number): () => void;
  /** Reserve a pointer for one owner; others should ignore it (`claimedBy`). */
  claim(pointerId: number, owner: object): boolean;
  /** The owner that claimed a pointer, if any. Claims are released when the pointer lifts. */
  claimedBy(pointerId: number): object | undefined;

  /** Key held (by `KeyboardEvent.code`). */
  down(code: string): boolean;
  /** Went down / up since the previous `update()`. */
  pressed(code: string): boolean;
  /** Went up since the previous `update()`. */
  released(code: string): boolean;
  /** Only these codes have their default action prevented (so bound keys don't scroll). */
  captureKeys(codes: Iterable<string>): void;

  /** The first connected gamepad, as of the last `update()`. */
  gamepad(): GamepadState | null;
  /** Button crossed half-way down / up between the last two `update()` calls. */
  padPressed(button: PadButton): boolean;
  padReleased(button: PadButton): boolean;

  /**
   * Set a value on the virtual channel, read by `touch:<name>` action sources. On-screen controls
   * call this; a non-zero value also marks touch as the last device. 0 removes the entry.
   */
  setVirtual(name: string, value: number): void;
  /** Current virtual value, 0 when unset. */
  virtual(name: string): number;
  /** Became non-zero / returned to zero between the last two `update()` calls. */
  virtualPressed(name: string): boolean;
  virtualReleased(name: string): boolean;

  /** Ask for pointer lock (must be called from a user gesture). */
  lock(): void;
  /** Release pointer lock if this surface holds it. */
  unlock(): void;
  /** This surface holds pointer lock; mouse movement then arrives as `look` events. */
  locked(): boolean;

  /** Once per frame, before reading: advances edges and polls the gamepad. */
  update(): void;
  /** True while anything is being held; render continuously while it is. */
  active(): boolean;
  /** What was used last, for showing the right prompts or touch controls. */
  lastDevice(): Device;
  /** Called when `lastDevice()` changes. Returns an unsubscribe. */
  onDevice(fn: (d: Device) => void): () => void;
  /** Remove every listener, drop all state and release pointer lock. */
  dispose(): void;
}

const WHEEL_LINE = 16;

/** Normalise a wheel delta to pixels whatever unit the browser reported it in. */
export function wheelPixels(delta: number, mode: number, page = 800): number {
  return mode === 1 ? delta * WHEEL_LINE : mode === 2 ? delta * page : delta;
}

/** Radial deadzone: below `dz` is zero, above it rescales so the edge still reaches 1. */
export function deadzone2(x: number, y: number, dz: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m <= dz) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k];
}

const isTyping = (t: unknown): boolean => {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

/**
 * Create the input for one surface, usually the canvas. Make one per surface and build
 * everything else on it; `dispose()` removes every listener at once. DOM-only in practice,
 * though the targets and clocks can be injected (see {@link InputOptions}) to drive it
 * headlessly.
 *
 * Key events are read from `window` (they never target a canvas) and ignored while a text field
 * has focus. Held keys are released when the window loses focus or the page is hidden.
 *
 * @param el - The surface. It receives pointer capture and, with `lock()`, pointer lock.
 * @returns The input; pass it to {@link recogniseGestures}, {@link makeActions},
 *   {@link makeTouchControls}, {@link makeOrbitController} or {@link makeLookController}.
 * @example
 * ```ts
 * prepareSurface(canvas, { contextMenu: false });
 * const input = createInput(canvas, { loop });
 * const orbit = makeOrbitController(input, { distance: 200, pan: "secondary" });
 * // per frame:
 * input.update();
 * loop.setContinuous(input.active());
 * ```
 */
export function createInput(el: EventTarget, opts: InputOptions = {}): Input {
  const g = globalThis as unknown as {
    window?: EventTarget;
    document?: EventTarget & { pointerLockElement?: unknown; exitPointerLock?: () => void; hidden?: boolean };
    navigator?: { getGamepads?: () => ArrayLike<Gamepad | null> };
  };
  const keyTarget = opts.keyTarget ?? g.window ?? el;
  const lockTarget = opts.lockTarget ?? g.document;
  const now = opts.now ?? (() => performance.now());
  const getPads = opts.getGamepads ?? (() => g.navigator?.getGamepads?.() ?? []);
  const dz = opts.deadzone ?? 0.15;
  const loop = opts.loop;

  const pointers = new Map<number, PointerState>();
  const claims = new Map<number, object>();
  let listeners: { fn: (e: InputEvent) => void; priority: number }[] = [];
  const deviceListeners = new Set<(d: Device) => void>();
  let device: Device = "mouse";

  const held = new Set<string>();
  let pendDown = new Set<string>(), pendUp = new Set<string>();
  let frameDown = new Set<string>(), frameUp = new Set<string>();
  const captured = new Set<string>();

  let pad: GamepadState | null = null;
  let prevPadButtons: Record<string, number> = {};
  let padDown = new Set<string>(), padUp = new Set<string>();

  const virt = new Map<string, number>();
  let prevVirt = new Map<string, number>();
  let virtDown = new Set<string>(), virtUp = new Set<string>();

  let isLocked = false;

  const emit = (e: InputEvent) => {
    for (const l of listeners) l.fn(e);
    loop?.invalidate();
  };
  const setDevice = (d: Device) => {
    if (d === device) return;
    device = d;
    for (const f of deviceListeners) f(d);
  };

  const off: (() => void)[] = [];
  const listen = (t: EventTarget | undefined, type: string, fn: (e: any) => void, o?: AddEventListenerOptions) => {
    if (!t) return;
    t.addEventListener(type, fn, o);
    off.push(() => t.removeEventListener(type, fn, o));
  };

  const kindOf = (e: PointerEvent): PointerKind =>
    e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse";

  // --- pointers -----------------------------------------------------------
  listen(el, "pointerdown", (e: PointerEvent) => {
    const type = kindOf(e);
    setDevice(type);
    const p: PointerState = {
      id: e.pointerId, type,
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
      travel: 0, button: e.button ?? 0, t0: now(),
      shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, altKey: !!e.altKey, metaKey: !!e.metaKey,
    };
    pointers.set(e.pointerId, p);
    try {
      (el as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured; harmless.
    }
    if (type === "touch") e.preventDefault?.();
    emit({ kind: "pointer", phase: "down", pointer: p, source: e });
  });
  listen(el, "pointermove", (e: PointerEvent) => {
    if (isLocked) {
      const dx = e.movementX ?? 0, dy = e.movementY ?? 0;
      if (dx || dy) emit({ kind: "look", dx, dy });
      return;
    }
    const p = pointers.get(e.pointerId);
    if (!p) {
      if (kindOf(e) === "mouse" && device !== "mouse") setDevice("mouse");
      return;
    }
    p.lastX = p.x;
    p.lastY = p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    p.travel += Math.hypot(p.x - p.lastX, p.y - p.lastY);
    emit({ kind: "pointer", phase: "move", pointer: p, source: e });
  });
  const end = (phase: "up" | "cancel") => (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.lastX = p.x;
    p.lastY = p.y;
    if (phase === "up") {
      p.x = e.clientX ?? p.x;
      p.y = e.clientY ?? p.y;
    }
    pointers.delete(e.pointerId);
    emit({ kind: "pointer", phase, pointer: p, source: e });
    claims.delete(e.pointerId);
  };
  listen(el, "pointerup", end("up"));
  listen(el, "pointercancel", end("cancel"));
  listen(el, "lostpointercapture", end("cancel"));

  listen(
    el,
    "wheel",
    (e: WheelEvent) => {
      if (opts.captureWheel !== false) e.preventDefault?.();
      const page = (el as HTMLElement).clientHeight || 800;
      emit({
        kind: "wheel",
        dx: wheelPixels(e.deltaX ?? 0, e.deltaMode ?? 0, page),
        dy: wheelPixels(e.deltaY ?? 0, e.deltaMode ?? 0, page),
        pinch: !!e.ctrlKey,
        x: e.clientX ?? 0,
        y: e.clientY ?? 0,
        source: e,
      });
    },
    { passive: false },
  );

  // --- keyboard -----------------------------------------------------------
  listen(keyTarget, "keydown", (e: KeyboardEvent) => {
    if (e.isComposing || isTyping(e.target)) return;
    const code = e.code;
    if (!code) return;
    setDevice("keyboard");
    if (captured.has(code)) e.preventDefault?.();
    if (!held.has(code)) {
      held.add(code);
      pendDown.add(code);
    }
    emit({ kind: "key", phase: "down", code, repeat: !!e.repeat, source: e });
  });
  listen(keyTarget, "keyup", (e: KeyboardEvent) => {
    const code = e.code;
    if (!code || !held.has(code)) return;
    held.delete(code);
    pendUp.add(code);
    if (captured.has(code)) e.preventDefault?.();
    emit({ kind: "key", phase: "up", code, repeat: false, source: e });
  });
  // A key released while the window was unfocused never sends keyup: drop
  // everything held rather than leave the player walking forever.
  const releaseAll = () => {
    for (const code of held) pendUp.add(code);
    held.clear();
    loop?.invalidate();
  };
  listen(keyTarget, "blur", releaseAll);
  listen(g.document, "visibilitychange", () => {
    if (g.document?.hidden) releaseAll();
  });

  // --- pointer lock -------------------------------------------------------
  listen(lockTarget, "pointerlockchange", () => {
    isLocked = !!lockTarget && lockTarget.pointerLockElement === el;
    loop?.invalidate();
  });
  listen(g.window, "gamepadconnected", () => loop?.invalidate());

  const input: Input = {
    el,
    pointers: () => pointers,
    on(fn, priority = 0) {
      const entry = { fn, priority };
      listeners = [...listeners, entry].sort((a, b) => b.priority - a.priority);
      return () => {
        listeners = listeners.filter((l) => l !== entry);
      };
    },
    claim(id, owner) {
      const cur = claims.get(id);
      if (cur && cur !== owner) return false;
      claims.set(id, owner);
      return true;
    },
    claimedBy: (id) => claims.get(id),

    down: (code) => held.has(code),
    pressed: (code) => frameDown.has(code),
    released: (code) => frameUp.has(code),
    captureKeys(codes) {
      for (const c of codes) captured.add(c);
    },

    gamepad: () => pad,
    padPressed: (b) => padDown.has(b),
    padReleased: (b) => padUp.has(b),

    setVirtual(name, value) {
      if ((virt.get(name) ?? 0) === value) return;
      if (value === 0) virt.delete(name);
      else virt.set(name, value);
      if (value !== 0) setDevice("touch");
      loop?.invalidate();
    },
    virtual: (name) => virt.get(name) ?? 0,
    virtualPressed: (name) => virtDown.has(name),
    virtualReleased: (name) => virtUp.has(name),

    lock() {
      (el as Element).requestPointerLock?.();
    },
    unlock() {
      if (isLocked) lockTarget?.exitPointerLock?.();
    },
    locked: () => isLocked,

    update() {
      frameDown = pendDown;
      frameUp = pendUp;
      pendDown = new Set();
      pendUp = new Set();

      // Virtual edges: compare with the values at the previous update.
      virtDown = new Set();
      virtUp = new Set();
      for (const [k, v] of virt) if (v !== 0 && !(prevVirt.get(k))) virtDown.add(k);
      for (const [k, v] of prevVirt) if (v !== 0 && !virt.get(k)) virtUp.add(k);
      prevVirt = new Map(virt);

      // Gamepad: first connected, standard mapping.
      padDown = new Set();
      padUp = new Set();
      let gp: Gamepad | null = null;
      const pads = getPads();
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected !== false) { gp = p; break; }
      }
      if (!gp) {
        pad = null;
        prevPadButtons = {};
        return;
      }
      const buttons = {} as Record<PadButton, number>;
      PAD_BUTTONS.forEach((name, i) => {
        const b = gp!.buttons[i];
        buttons[name] = b ? (typeof b === "number" ? b : b.value || (b.pressed ? 1 : 0)) : 0;
      });
      const ax = gp.axes;
      const [lx, ly] = deadzone2(ax[0] ?? 0, ax[1] ?? 0, dz);
      const [rx, ry] = deadzone2(ax[2] ?? 0, ax[3] ?? 0, dz);
      const axes = { LeftX: lx, LeftY: ly, RightX: rx, RightY: ry };
      let any = false;
      for (const name of PAD_BUTTONS) {
        const was = (prevPadButtons[name] ?? 0) > 0.5, is = buttons[name] > 0.5;
        if (is && !was) padDown.add(name);
        if (!is && was) padUp.add(name);
        if (buttons[name] > 0.1) any = true;
      }
      if (any || lx || ly || rx || ry) setDevice("gamepad");
      prevPadButtons = buttons;
      pad = { id: gp.id, buttons, axes };
    },

    active() {
      if (held.size || pointers.size || virt.size) return true;
      if (!pad) return false;
      const a = pad.axes;
      if (a.LeftX || a.LeftY || a.RightX || a.RightY) return true;
      for (const name of PAD_BUTTONS) if (pad.buttons[name] > 0.1) return true;
      return false;
    },
    lastDevice: () => device,
    onDevice(fn) {
      deviceListeners.add(fn);
      return () => deviceListeners.delete(fn);
    },
    dispose() {
      for (const f of off.splice(0)) f();
      listeners = [];
      deviceListeners.clear();
      pointers.clear();
      held.clear();
      virt.clear();
      if (isLocked) lockTarget?.exitPointerLock?.();
    },
  };
  return input;
}

/**
 * Make an element behave as an input surface on touch devices: no browser
 * panning or pinch-zooming over it, no text selection, no tap flash, and
 * (optionally) no context menu, so right-drag can be a gesture. Use this instead of per-app
 * `touch-action` CSS. DOM-only.
 *
 * @param opts - `contextMenu: false` suppresses the context menu over the element.
 * @returns A function that restores the previous styles and removes the listener.
 * @example
 * ```ts
 * prepareSurface(canvas, { contextMenu: false });
 * const input = createInput(canvas);
 * ```
 */
export function prepareSurface(el: HTMLElement, opts: { contextMenu?: boolean } = {}): () => void {
  const s = el.style as CSSStyleDeclaration & Record<string, string>;
  const prev = { touchAction: s.touchAction, userSelect: s.userSelect, tap: s.webkitTapHighlightColor, cb: s.webkitTouchCallout };
  s.touchAction = "none";
  s.userSelect = "none";
  s.webkitUserSelect = "none";
  s.webkitTapHighlightColor = "transparent";
  s.webkitTouchCallout = "none";
  const noMenu = (e: Event) => e.preventDefault();
  if (opts.contextMenu === false) el.addEventListener("contextmenu", noMenu);
  return () => {
    s.touchAction = prev.touchAction;
    s.userSelect = prev.userSelect;
    s.webkitTapHighlightColor = prev.tap;
    s.webkitTouchCallout = prev.cb;
    el.removeEventListener("contextmenu", noMenu);
  };
}
