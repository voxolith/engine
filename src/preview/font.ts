// A 3×5 bitmap font, just enough to caption contact sheets. Drawn at 2× or 3×
// it stays legible, and it keeps previews self-describing so a sheet of twenty
// parameter variants can be read without counting cells.

const GLYPHS: Record<string, string> = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
  E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
  I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "101111111111101", O: "010101101101010", P: "110101110100100",
  Q: "010101101111011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101011", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111",
  "0": "111101101101111", "1": "010110010010111", "2": "110001010100111", "3": "110001010001110",
  "4": "101101111001001", "5": "111100110001110", "6": "011100110101010", "7": "111001010010010",
  "8": "010101010101010", "9": "010101011001110",
  ".": "000000000000010", ",": "000000000010100", "-": "000000111000000", "_": "000000000000111",
  ":": "000010000010000", "/": "001001010100100", "%": "101001010100101", "+": "000010111010000",
  "(": "001010010010001", ")": "100010010010100", "=": "000111000111000", "*": "101010101000000",
  "#": "101111101111101", "!": "010010010000010", "?": "110001010000010", "<": "001010100010001",
  ">": "100010001010100", "'": "010010000000000", " ": "000000000000000",
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
/** Columns a string occupies at scale 1, including inter-glyph spacing. */
export const textWidth = (s: string, scale = 1): number => s.length * (GLYPH_W + 1) * scale;

/** Draw `text` into an RGB buffer. Unknown characters render as blank. */
export function drawText(
  rgb: Uint8Array,
  bufW: number,
  bufH: number,
  x0: number,
  y0: number,
  text: string,
  color: [number, number, number],
  scale = 2,
): void {
  let cx = x0;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch];
    if (g) {
      for (let row = 0; row < GLYPH_H; row++)
        for (let col = 0; col < GLYPH_W; col++) {
          if (g[row * GLYPH_W + col] !== "1") continue;
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++) {
              const px = cx + col * scale + sx;
              const py = y0 + row * scale + sy;
              if (px < 0 || py < 0 || px >= bufW || py >= bufH) continue;
              const o = (py * bufW + px) * 3;
              rgb[o] = color[0];
              rgb[o + 1] = color[1];
              rgb[o + 2] = color[2];
            }
        }
    }
    cx += (GLYPH_W + 1) * scale;
  }
}
