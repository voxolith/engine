// On-screen controls for touch: a floating joystick and round buttons.
//
// They feed the input's virtual channel (`touch:<id>` sources in an action
// map), so a game binds `touch:move.x` next to `key:KeyA` and `pad:LeftX` and
// never knows which one the player used. A joystick appears where the thumb
// lands inside its zone, which is kinder than a fixed base on phones of every
// size. The controls are their own elements above the canvas, so the fingers
// on them never reach the camera's gestures.
//
// By default they show once a touch is seen and hide again when a mouse,
// keyboard or gamepad is used. Colours come from CSS custom properties with
// fallbacks, so an app can map them onto its theme:
//   --vx-control-bg, --vx-control-fg, --vx-control-active

import type { Device, Input } from "./core";

/**
 * A floating joystick. It sets virtual values `<id>` (1 while held) and `<id>.x`, `<id>.y`
 * (-1..1, Y down-positive), read as `touch:<id>.x` and so on in an action map.
 */
export interface JoystickSpec {
  id: string;
  /** Which part of the screen the thumb can land in. */
  side: "left" | "right";
  /** Knob travel in CSS pixels. Default 56. */
  radius?: number;
}

/** A round button. It sets virtual value `<id>` to 1 while any finger is on it (`touch:<id>`). */
export interface ButtonSpec {
  /** Virtual channel name; also the button's accessible label. */
  id: string;
  /** Short text or a symbol. */
  label: string;
  /** Default "right". */
  side?: "left" | "right";
  /** Diameter in CSS pixels. Default 64. */
  size?: number;
}

/** What {@link makeTouchControls} puts on screen. */
export interface TouchControlsSpec {
  joysticks?: JoystickSpec[];
  /** Laid out bottom-up, innermost first, on their side. */
  buttons?: ButtonSpec[];
  /** Default "auto": shown after a touch, hidden on mouse/keyboard/gamepad. */
  show?: "auto" | "always" | "never";
  /** Element to put the overlay in. Default document.body. */
  container?: HTMLElement;
}

/** The on-screen controls, from {@link makeTouchControls}. */
export interface TouchControls {
  /** Show or hide the overlay. In "auto" mode the next device change can override this. */
  setVisible(on: boolean): void;
  visible(): boolean;
  /** Remove the overlay and its listeners and zero every virtual value it set. */
  dispose(): void;
}

const VAR_BG = "var(--vx-control-bg, rgba(20, 24, 36, 0.35))";
const VAR_FG = "var(--vx-control-fg, rgba(255, 255, 255, 0.85))";
const VAR_ACTIVE = "var(--vx-control-active, rgba(255, 255, 255, 0.35))";

/**
 * Add on-screen joysticks and buttons that feed the input's virtual channel, so a game binds
 * `touch:move.x` beside `key:KeyA` and `pad:LeftX`. The controls are a fixed overlay of their own
 * elements, so fingers on them never reach the canvas gestures. DOM-only.
 *
 * Joysticks take the lower part of their side of the screen and centre on wherever the thumb
 * lands. Buttons stack bottom-up in two columns from the outer edge. Colours come from the CSS
 * custom properties `--vx-control-bg`, `--vx-control-fg` and `--vx-control-active`.
 *
 * @param input - The surface's input.
 * @param spec - The controls to create and when to show them.
 * @returns A handle to show, hide or remove them.
 * @example
 * ```ts
 * makeTouchControls(input, {
 *   joysticks: [{ id: "move", side: "left" }],
 *   buttons: [{ id: "jump", label: "A" }],
 * });
 * const actions = makeActions(input, {
 *   strafe: axis({ negative: ["key:KeyA"], positive: ["key:KeyD"], analog: ["touch:move.x"] }),
 *   jump: button("key:Space", "touch:jump"),
 * });
 * ```
 */
export function makeTouchControls(input: Input, spec: TouchControlsSpec): TouchControls {
  const doc = document;
  const root = doc.createElement("div");
  root.className = "vx-touch-controls";
  Object.assign(root.style, {
    position: "fixed", inset: "0", pointerEvents: "none", zIndex: "20",
    userSelect: "none", webkitUserSelect: "none", touchAction: "none",
  } as Partial<CSSStyleDeclaration>);
  (spec.container ?? doc.body).append(root);

  const off: (() => void)[] = [];
  const on = (t: EventTarget, type: string, fn: (e: any) => void) => {
    t.addEventListener(type, fn, { passive: false });
    off.push(() => t.removeEventListener(type, fn));
  };
  const capture = (el: Element, id: number) => {
    try {
      el.setPointerCapture(id);
    } catch {
      /* ignore */
    }
  };

  // --- joysticks --------------------------------------------------------------
  for (const js of spec.joysticks ?? []) {
    const r = js.radius ?? 56;
    const zone = doc.createElement("div");
    Object.assign(zone.style, {
      position: "absolute", bottom: "0", top: "35%", width: "45%", pointerEvents: "auto", touchAction: "none",
      [js.side]: "0",
    } as Partial<CSSStyleDeclaration>);
    const base = doc.createElement("div");
    const knob = doc.createElement("div");
    Object.assign(base.style, {
      position: "absolute", width: `${2 * r}px`, height: `${2 * r}px`, borderRadius: "50%",
      background: VAR_BG, border: `2px solid ${VAR_ACTIVE}`, transform: "translate(-50%, -50%)",
      opacity: "0.55", transition: "opacity 120ms",
      // Rest position, so the player can see there is a stick before touching
      // it: centred r + 28 px in from the corner (the translate moves the box
      // left and up by r, hence the offsets).
      left: js.side === "left" ? `calc(${r + 28}px + env(safe-area-inset-left, 0px))` : "auto",
      right: js.side === "right" ? `calc(${28 - r}px + env(safe-area-inset-right, 0px))` : "auto",
      bottom: `calc(${28 - r}px + env(safe-area-inset-bottom, 0px))`,
    } as Partial<CSSStyleDeclaration>);
    Object.assign(knob.style, {
      position: "absolute", left: "50%", top: "50%", width: `${r}px`, height: `${r}px`, borderRadius: "50%",
      background: VAR_FG, transform: "translate(-50%, -50%)", opacity: "0.8",
    } as Partial<CSSStyleDeclaration>);
    base.append(knob);
    zone.append(base);
    root.append(zone);

    let active = -1, cx = 0, cy = 0;
    const rest = { left: base.style.left, right: base.style.right, bottom: base.style.bottom, top: base.style.top };
    const set = (x: number, y: number) => {
      input.setVirtual(`${js.id}.x`, x);
      input.setVirtual(`${js.id}.y`, y);
      knob.style.transform = `translate(calc(-50% + ${x * r}px), calc(-50% + ${y * r}px))`;
    };
    on(zone, "pointerdown", (e: PointerEvent) => {
      if (active >= 0) return;
      e.preventDefault();
      active = e.pointerId;
      capture(zone, e.pointerId);
      const box = zone.getBoundingClientRect();
      cx = e.clientX;
      cy = e.clientY;
      Object.assign(base.style, { left: `${cx - box.left}px`, top: `${cy - box.top}px`, right: "auto", bottom: "auto", opacity: "1" });
      input.setVirtual(js.id, 1);
      set(0, 0);
    });
    on(zone, "pointermove", (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      let dx = (e.clientX - cx) / r, dy = (e.clientY - cy) / r;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      set(dx, dy);
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = -1;
      set(0, 0);
      input.setVirtual(js.id, 0);
      Object.assign(base.style, { ...rest, opacity: "0.55" });
    };
    on(zone, "pointerup", release);
    on(zone, "pointercancel", release);
  }

  // --- buttons -----------------------------------------------------------------
  const stacks: Record<"left" | "right", number> = { left: 0, right: 0 };
  for (const b of spec.buttons ?? []) {
    const side = b.side ?? "right";
    const size = b.size ?? 64;
    const idx = stacks[side]++;
    const el = doc.createElement("div");
    el.textContent = b.label;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", b.id);
    // Two columns, filled bottom-up from the outer edge.
    const col = idx % 2, row = Math.floor(idx / 2);
    Object.assign(el.style, {
      position: "absolute", width: `${size}px`, height: `${size}px`, borderRadius: "50%",
      display: "flex", alignItems: "center", justifyContent: "center",
      font: `600 ${Math.round(size * 0.32)}px system-ui, sans-serif`, color: VAR_FG,
      background: VAR_BG, border: `2px solid ${VAR_ACTIVE}`, pointerEvents: "auto", touchAction: "none",
      [side]: `calc(${24 + col * (size + 14)}px + env(safe-area-inset-${side}, 0px))`,
      bottom: `calc(${28 + row * (size + 14) + (col ? size * 0.6 : 0)}px + env(safe-area-inset-bottom, 0px))`,
    } as Partial<CSSStyleDeclaration>);
    root.append(el);
    let held = new Set<number>();
    const update = () => {
      input.setVirtual(b.id, held.size ? 1 : 0);
      el.style.background = held.size ? VAR_ACTIVE : VAR_BG;
    };
    on(el, "pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      capture(el, e.pointerId);
      held.add(e.pointerId);
      update();
    });
    const up = (e: PointerEvent) => {
      if (held.delete(e.pointerId)) update();
    };
    on(el, "pointerup", up);
    on(el, "pointercancel", up);
  }

  // --- visibility --------------------------------------------------------------
  const mode = spec.show ?? "auto";
  let shown = false;
  const setVisible = (v: boolean) => {
    shown = v;
    root.style.display = v ? "block" : "none";
  };
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  setVisible(mode === "always" || (mode === "auto" && coarse));
  if (mode === "auto") {
    const stop = input.onDevice((d: Device) => {
      if (d === "touch") setVisible(true);
      else if (d === "mouse" || d === "keyboard" || d === "gamepad") setVisible(false);
    });
    off.push(stop);
    // Touches on the controls themselves never reach the input's element.
    on(root, "pointerdown", (e: PointerEvent) => {
      if (e.pointerType === "touch") setVisible(true);
    });
  }

  return {
    setVisible,
    visible: () => shown,
    dispose() {
      for (const f of off.splice(0)) f();
      for (const js of spec.joysticks ?? []) {
        input.setVirtual(js.id, 0);
        input.setVirtual(`${js.id}.x`, 0);
        input.setVirtual(`${js.id}.y`, 0);
      }
      for (const b of spec.buttons ?? []) input.setVirtual(b.id, 0);
      root.remove();
    },
  };
}
