/**
 * `@voxolith/engine/input`: desktop and mobile input for Voxolith apps.
 *
 * DOM-only, so it lives on its own subpath and the engine barrel stays runtime-safe. Apps take
 * all camera and movement input from here rather than adding raw listeners. Layered; each layer
 * only uses the ones above it here:
 *
 * - {@link createInput}: one per surface: pointers, keys, wheel, pointer lock, gamepad, a
 *   virtual channel; owns every listener. {@link prepareSurface} readies the element.
 * - {@link recogniseGestures}: tap, double-tap, long-press, drag, pinch (touch and trackpad),
 *   with claiming between recognisers. Tap versus drag is decided on total travel.
 * - {@link makeActions}: named buttons and axes over keys, pad and touch
 * - {@link makeTouchControls}: on-screen joystick and buttons feeding the actions
 * - {@link makeOrbitController}, {@link makeLookController}: the two camera styles. Their state
 *   feeds the renderer's `makeCamera` and `firstPersonFrame`. Dragging right decreases an orbit
 *   camera's yaw; turning right increases a first-person yaw.
 *
 * Pass the app's frame loop to `createInput` so every event requests a frame, and render
 * continuously while `input.active()`.
 *
 * @packageDocumentation
 */

export {
  createInput,
  deadzone2,
  PAD_AXES,
  PAD_BUTTONS,
  prepareSurface,
  wheelPixels,
} from "./core";
export type {
  Device,
  GamepadState,
  Input,
  InputEvent,
  InputOptions,
  Invalidatable,
  PadAxis,
  PadButton,
  PointerKind,
  PointerPhase,
  PointerState,
} from "./core";

export { recogniseGestures } from "./gestures";
export type { DragEvent, GestureHandlers, GestureOptions, Gestures, Modifiers, PinchEvent, TapEvent, WheelGesture } from "./gestures";

export { axis, button, makeActions } from "./actions";
export type { Actions, AxisBinding, Binding, Bindings, ButtonBinding } from "./actions";

export { makeTouchControls } from "./touch";
export type { ButtonSpec, JoystickSpec, TouchControls, TouchControlsSpec } from "./touch";

export { makeOrbitController } from "./orbit";
export type { OrbitController, OrbitOptions } from "./orbit";

export { makeLookController } from "./look";
export type { LookController, LookOptions } from "./look";
