// Headless checks for @voxolith/engine/input, driven by synthetic events on a
// plain EventTarget. No DOM, no GPU.
//
//   bun tools/verify-input.ts

import {
  axis,
  button,
  createInput,
  deadzone2,
  makeActions,
  makeLookController,
  makeOrbitController,
  recogniseGestures,
  wheelPixels,
  type Input,
} from "../src/input/index";

let failed = 0;
let checks = 0;
function ok(cond: boolean, what: string, detail = ""): void {
  checks++;
  if (cond) console.log(`  ✓ ${what}`);
  else {
    failed++;
    console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A surface that counts its listeners, so dispose() can be checked. */
class Surface extends EventTarget {
  clientHeight = 600;
  listeners = 0;
  override addEventListener(t: string, f: EventListenerOrEventListenerObject | null, o?: AddEventListenerOptions | boolean) {
    this.listeners++;
    super.addEventListener(t, f, o);
  }
  override removeEventListener(t: string, f: EventListenerOrEventListenerObject | null, o?: EventListenerOptions | boolean) {
    this.listeners--;
    super.removeEventListener(t, f, o);
  }
}

function fire(t: EventTarget, type: string, props: Record<string, unknown>): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, props);
  t.dispatchEvent(e);
  return e;
}

interface Rig {
  el: Surface;
  keys: Surface;
  input: Input;
  pads: (Gamepad | null)[];
  invalidations: number;
  down(id: number, x: number, y: number, o?: Record<string, unknown>): void;
  move(id: number, x: number, y: number): void;
  up(id: number, x: number, y: number): void;
  key(type: "keydown" | "keyup", code: string, o?: Record<string, unknown>): Event;
}

function rig(keyTarget?: Surface): Rig {
  const el = new Surface();
  const keys = keyTarget ?? new Surface();
  const r = { invalidations: 0 } as Rig;
  const pads: (Gamepad | null)[] = [];
  const input = createInput(el, {
    keyTarget: keys,
    lockTarget: new Surface() as never,
    loop: { invalidate: () => r.invalidations++ },
    getGamepads: () => pads,
  });
  const ptr = (type: string, id: number, x: number, y: number, o: Record<string, unknown> = {}) =>
    fire(el, type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0, ...o });
  Object.assign(r, {
    el, keys, input, pads,
    down: (id: number, x: number, y: number, o?: Record<string, unknown>) => ptr("pointerdown", id, x, y, o),
    move: (id: number, x: number, y: number) => ptr("pointermove", id, x, y),
    up: (id: number, x: number, y: number) => ptr("pointerup", id, x, y),
    key: (type: "keydown" | "keyup", code: string, o: Record<string, unknown> = {}) => fire(keys, type, { code, ...o }),
  });
  return r;
}

console.log("wheel and sticks:");
ok(wheelPixels(3, 1) === 48, "line-mode wheel deltas become pixels");
ok(wheelPixels(1, 2, 700) === 700, "page-mode wheel deltas scale by the surface height");
{
  const [x, y] = deadzone2(0.1, 0.05, 0.15);
  const [fx] = deadzone2(1, 0, 0.15);
  const [hx, hy] = deadzone2(0.6, 0.6, 0.15);
  ok(x === 0 && y === 0, "a resting stick inside the deadzone reads zero");
  ok(Math.abs(fx - 1) < 1e-9, "full deflection still reaches 1");
  ok(Math.abs(hx - hy) < 1e-9 && hx > 0 && Math.hypot(hx, hy) <= 1, "radial deadzone keeps direction and stays in the unit circle");
}

console.log("gestures:");
{
  // A slow drag: many 1 px moves must still add up to a drag, never a tap.
  const r = rig();
  let taps = 0, drags = 0, starts = 0;
  recogniseGestures(r.input, { tap: () => taps++, dragStart: () => void starts++, drag: () => drags++ });
  r.down(1, 100, 100);
  for (let i = 1; i <= 30; i++) r.move(1, 100 + i, 100);
  r.up(1, 130, 100);
  ok(taps === 0 && starts === 1 && drags > 0, "a slow 1 px-per-event drag is a drag, not a tap", `taps ${taps} starts ${starts}`);

  // A press with a little jitter is still a tap.
  r.down(2, 50, 50);
  r.move(2, 53, 52);
  r.up(2, 53, 52);
  ok(taps === 1, "a press that wobbles inside the slop is a tap");
}
{
  const r = rig();
  let doubles = 0, taps = 0;
  recogniseGestures(r.input, { tap: () => taps++, doubleTap: () => doubles++ });
  r.down(1, 10, 10); r.up(1, 10, 10);
  r.down(2, 12, 11); r.up(2, 12, 11);
  ok(taps === 2 && doubles === 1, "two quick taps in the same place are a double tap");
  await sleep(340);
  r.down(3, 12, 11); r.up(3, 12, 11);
  ok(doubles === 1, "a third tap after the window is not another double tap");
}
{
  const r = rig();
  let longs = 0, taps = 0;
  recogniseGestures(r.input, { tap: () => taps++, longPress: () => longs++ }, { longPressMs: 40 });
  r.down(1, 10, 10);
  await sleep(70);
  r.up(1, 10, 10);
  ok(longs === 1 && taps === 0, "holding still fires a long press and suppresses the tap");
  r.down(2, 10, 10);
  r.move(2, 40, 10);
  await sleep(70);
  r.up(2, 40, 10);
  ok(longs === 1, "moving past the slop cancels the long press");
}
{
  // One finger dragging, a second lands: the drag ends cancelled and a pinch begins.
  const r = rig();
  let cancelled: boolean | null = null, ratio = 1, pinches = 0, taps = 0;
  recogniseGestures(r.input, {
    tap: () => taps++,
    dragEnd: (_d, c) => { cancelled = c; },
    pinch: (p) => { ratio *= p.ratio; pinches++; },
  });
  r.down(1, 100, 100);
  r.move(1, 130, 100);
  r.down(2, 200, 100); // fingers 70 apart
  r.move(2, 270, 100); // now 140 apart
  r.up(2, 270, 100);
  r.up(1, 130, 100);
  ok(cancelled === true, "a second finger cancels the one-finger drag");
  ok(pinches > 0 && Math.abs(ratio - 2) < 1e-6, "spreading two fingers to twice the distance is a pinch of ratio 2", `ratio ${ratio}`);
  ok(taps === 0, "lifting fingers after a pinch is not a tap");
}
{
  const r = rig();
  let pinch = 0, wheel = 0;
  recogniseGestures(r.input, { pinch: (p) => { pinch = p.ratio; }, wheel: (w) => { wheel = w.ratio; } });
  const e = fire(r.el, "wheel", { deltaY: -10, deltaMode: 0, ctrlKey: true });
  ok(pinch > 1 && wheel === 0, "ctrl+wheel (a trackpad pinch) arrives as a pinch, not a scroll");
  ok(e.defaultPrevented, "wheel over the surface does not scroll the page");
  fire(r.el, "wheel", { deltaY: 100, deltaMode: 0 });
  ok(wheel > 1, "scrolling down zooms out (ratio > 1)");
}
{
  // Claiming: a high-priority recogniser takes a finger; the lower one leaves it.
  const r = rig();
  let lowDrags = 0, highDrags = 0;
  recogniseGestures(r.input, { drag: () => lowDrags++ });
  recogniseGestures(r.input, { press: () => true, drag: () => highDrags++ }, { priority: 10 });
  r.down(1, 0, 0);
  r.move(1, 40, 0);
  r.move(1, 80, 0);
  r.up(1, 80, 0);
  ok(highDrags > 0 && lowDrags === 0, "a claimed pointer is left alone by lower-priority recognisers", `high ${highDrags} low ${lowDrags}`);
}

console.log("keyboard:");
{
  const r = rig();
  r.key("keydown", "KeyW");
  r.input.update();
  ok(r.input.down("KeyW") && r.input.pressed("KeyW"), "a key down is held and pressed this frame");
  r.key("keydown", "KeyW", { repeat: true });
  r.input.update();
  ok(r.input.down("KeyW") && !r.input.pressed("KeyW"), "auto-repeat is not a new press");
  ok(r.input.active(), "a held key keeps the input active");
  fire(r.keys, "blur", {});
  r.input.update();
  ok(!r.input.down("KeyW") && r.input.released("KeyW"), "losing focus releases held keys");
  ok(!r.input.active(), "and the input goes idle");

  const a = makeActions(r.input, { jump: button("key:Space") });
  const e1 = r.key("keydown", "Space");
  const e2 = r.key("keydown", "KeyP");
  ok(e1.defaultPrevented && !e2.defaultPrevented, "only bound keys have their default prevented");
  r.input.update();
  ok(a.pressed("jump"), "an action is pressed by its key");
  ok(r.invalidations > 0, "events invalidate the frame loop");
}
{
  const typing = new Surface() as Surface & { tagName: string };
  typing.tagName = "INPUT";
  const r = rig(typing);
  r.key("keydown", "KeyW");
  r.input.update();
  ok(!r.input.down("KeyW"), "keys typed into a text field are ignored");
}

console.log("actions and gamepad:");
{
  const r = rig();
  const a = makeActions(r.input, {
    steer: axis({ negative: ["key:KeyA"], positive: ["key:KeyD"], analog: ["pad:LeftX", "touch:stick.x"] }),
    fire: button("key:Space", "pad:A", "touch:fire"),
    gas: button("pad:RT", "key:KeyW"),
  });
  const pad = (axes: number[], buttons: number[]) =>
    ({ id: "test pad", connected: true, axes, buttons: buttons.map((v) => ({ value: v, pressed: v > 0.5 })) }) as unknown as Gamepad;
  r.pads[0] = pad([0.5, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0.4]);
  r.input.update();
  ok(Math.abs(a.value("steer") - (0.5 - 0.15) / 0.85) < 1e-9, "a half-tilted stick steers proportionally (after the deadzone)");
  ok(a.pressed("fire") && a.down("fire"), "a pad button presses an action");
  ok(Math.abs(a.value("gas") - 0.4) < 1e-9, "triggers are analog");
  r.key("keydown", "KeyA");
  r.input.update();
  ok(a.value("steer") === -1, "a key pushed fully wins over a half-tilted stick");
  r.key("keyup", "KeyA");
  r.pads[0] = null;
  r.input.setVirtual("stick.x", -0.3);
  r.input.update();
  ok(Math.abs(a.value("steer") + 0.3) < 1e-9, "a touch joystick feeds the same axis");
  const fwd = makeActions(r.input, { walk: axis({ analog: ["touch:stick.y-"] }) });
  r.input.setVirtual("stick.y", -0.8);
  r.input.update();
  ok(Math.abs(fwd.value("walk") - 0.8) < 1e-9, "a half-axis suffix works on touch sources too (joystick pushed up walks forward)");
  r.input.setVirtual("stick.y", 0);
  r.input.setVirtual("fire", 1);
  r.input.update();
  ok(a.pressed("fire"), "a touch button presses the same action");

  const saved = JSON.parse(JSON.stringify(a.bindings()));
  saved.fire = button("key:KeyF");
  a.load(saved);
  r.input.setVirtual("fire", 0);
  r.key("keydown", "KeyF");
  r.input.update();
  ok(a.pressed("fire"), "bindings round-trip through JSON and rebinding takes effect");
  const [vx, vy] = makeActions(r.input, {
    x: axis({ negative: ["key:KeyZ"], positive: ["key:KeyC"] }),
    y: axis({ negative: ["key:KeyQ"], positive: ["key:KeyE"] }),
  }).vector("x", "y");
  ok(vx === 0 && vy === 0, "vector reads zero at rest");
}

console.log("controllers:");
{
  const r = rig();
  const orbit = makeOrbitController(r.input, { yaw: 0, pitch: 30, distance: 100, distanceLimits: [50, 200], yawLimits: [-45, 45] });
  r.down(1, 0, 0, { pointerType: "mouse" });
  r.move(1, 1000, 0);
  r.up(1, 1000, 0);
  ok(orbit.yaw() === -45, "yaw is clamped to its limits", `yaw ${orbit.yaw()}`);
  for (let i = 0; i < 40; i++) fire(r.el, "wheel", { deltaY: 100, deltaMode: 0 });
  ok(orbit.distance() === 200, "zoom is clamped to its limits");
  r.down(2, 100, 100);
  r.down(3, 300, 100);
  r.move(3, 500, 100); // spread: 200 -> 400
  r.up(3, 500, 100);
  r.up(2, 100, 100);
  ok(Math.abs(orbit.distance() - 100) < 1e-6, "spreading two fingers zooms in by the pinch ratio", `distance ${orbit.distance()}`);

  const m = rig();
  const pan = makeOrbitController(m.input, { yaw: 0, distance: 100, rotate: "none", pan: "primary", target: [0, 0, 0], panBounds: { minX: -10, maxX: 10, minZ: -500, maxZ: 500 } });
  m.down(1, 0, 0, { pointerType: "mouse" });
  m.move(1, 400, 0);
  m.up(1, 400, 0);
  ok(pan.target()[0] === -10, "dragging right slides the target left, clamped to the pan bounds", `x ${pan.target()[0]}`);
  m.down(2, 0, 0, { pointerType: "mouse" });
  m.move(2, 0, 60);
  m.up(2, 0, 60);
  ok(pan.target()[2] < 0, "dragging down pulls the ground towards the viewer (target moves away)");
  ok(pan.yaw() === 0, "a pan-only controller never rotates");
}
{
  const r = rig();
  const look = makeLookController(r.input, { yaw: 0, pitch: 0, pitchLimits: [-80, 80] });
  r.down(1, 0, 0);
  r.move(1, 100, 0);
  r.move(1, 100, -2000);
  r.up(1, 100, -2000);
  look.update(1 / 60);
  ok(look.yaw() > 0, "dragging right turns right (yaw increases, as firstPersonFrame expects)");
  ok(look.pitch() === 80, "look pitch is clamped");
  const pad = { id: "p", connected: true, axes: [0, 0, 1, 0], buttons: [] } as unknown as Gamepad;
  r.pads[0] = pad;
  r.input.update();
  const y0 = look.yaw();
  look.update(0.5);
  ok(Math.abs(look.yaw() - y0 - 80) < 1e-6, "the right stick turns at its rate, scaled by dt");
}

console.log("dispose:");
{
  const r = rig();
  const g = recogniseGestures(r.input, {});
  makeOrbitController(r.input, {});
  const before = r.el.listeners;
  g.dispose();
  r.input.dispose();
  ok(before > 0 && r.el.listeners === 0 && r.keys.listeners === 0, "dispose() removes every listener it added", `${r.el.listeners} left on the surface, ${r.keys.listeners} on keys`);
}

console.log(`\n${checks - failed}/${checks} input checks passed`);
if (failed) process.exit(1);
