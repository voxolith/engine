// @voxolith/engine/preview — headless CPU rendering for generator work.
//
// Node/bun only: the PNG writer uses node:zlib. Use it from tools, not from a
// browser bundle.

export { renderEntity, renderModel } from "./render";
export type { RenderOptions, RenderResult } from "./render";

export { contactSheet } from "./sheet";
export type { SheetCell, SheetOptions } from "./sheet";

export { encodePng } from "./png";
export { drawText, textWidth } from "./font";
