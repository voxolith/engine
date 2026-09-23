// @voxolith/engine/input — desktop and mobile input for Voxolith apps.
//
// DOM-only, so it lives on its own subpath and the engine barrel stays
// runtime-safe. Layered; each layer only uses the ones above it here:
//
//   createInput        one per surface: pointers, keys, wheel, pointer lock,
//                      gamepad, a virtual channel; owns every listener
//   recogniseGestures  tap, double-tap, long-press, drag, pinch (touch and
//                      trackpad), with claiming between recognisers
//   makeActions        named buttons and axes over keys, pad and touch
//   makeTouchControls  on-screen joystick and buttons feeding the actions
//   makeOrbitController, makeLookController   the two camera styles

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
