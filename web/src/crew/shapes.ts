/* Shared crew geometry: the same outlines drive the 2D avatar and the 3D characters. Coordinates are in a 100×100 box. */

/** profile: [radius, y] pairs from the top (y 0) to the bottom (y 1), as fractions of the body height; used for the 3D lathe. */
export type ShapeDef = { d: string; top: number; face: number; neck: number; half: number; profile: [number, number][] };

export const SHAPES: Record<string, ShapeDef> = {
  bean: { d: 'M30 20 C55 5 85 20 82 50 C80 80 55 95 32 88 C12 82 8 60 18 48 C24 40 16 28 30 20 Z', top: 12, face: 46, neck: 80, half: 32,
    profile: [[0, 0], [0.25, 0.05], [0.36, 0.25], [0.38, 0.55], [0.32, 0.8], [0.18, 0.96], [0, 1]] },
  pebble: { d: 'M10 58 C10 32 32 22 50 22 C70 22 90 32 90 58 C90 80 72 90 50 90 C28 90 10 80 10 58 Z', top: 22, face: 52, neck: 82, half: 38,
    profile: [[0, 0], [0.32, 0.05], [0.47, 0.3], [0.48, 0.6], [0.36, 0.88], [0, 1]] },
  pear: { d: 'M50 10 C62 10 66 24 64 34 C80 42 88 58 84 72 C80 88 64 92 50 92 C36 92 20 88 16 72 C12 58 20 42 36 34 C34 24 38 10 50 10 Z', top: 10, face: 58, neck: 84, half: 32,
    profile: [[0, 0], [0.14, 0.03], [0.19, 0.22], [0.36, 0.45], [0.42, 0.66], [0.36, 0.88], [0.2, 0.98], [0, 1]] },
  capsule: { d: 'M50 6 C70 6 80 20 80 36 V68 C80 84 68 94 50 94 C32 94 20 84 20 68 V36 C20 20 30 6 50 6 Z', top: 6, face: 40, neck: 80, half: 30,
    profile: [[0, 0], [0.2, 0.03], [0.3, 0.15], [0.3, 0.8], [0.22, 0.96], [0, 1]] },
  cube: { d: 'M24 16 H76 Q90 16 90 30 V80 Q90 94 76 94 H24 Q10 94 10 80 V30 Q10 16 24 16 Z', top: 16, face: 48, neck: 84, half: 40,
    profile: [[0, 0], [0.44, 0], [0.46, 0.06], [0.46, 0.94], [0.44, 1], [0, 1]] },
  triangle: { d: 'M50 8 Q57 8 61 17 L92 78 Q96 92 80 92 H20 Q4 92 8 78 L39 17 Q43 8 50 8 Z', top: 10, face: 62, neck: 84, half: 24,
    profile: [[0, 0], [0.06, 0.03], [0.12, 0.14], [0.46, 0.86], [0.44, 0.98], [0, 1]] },
  cloud: { d: 'M26 90 C10 90 4 76 10 66 C2 56 10 40 24 42 C26 26 44 20 54 30 C64 18 88 26 86 44 C96 50 96 68 86 74 C88 86 76 92 66 90 Z', top: 24, face: 58, neck: 86, half: 36,
    profile: [[0, 0], [0.3, 0.06], [0.42, 0.25], [0.37, 0.42], [0.44, 0.6], [0.36, 0.84], [0.18, 0.97], [0, 1]] },
  acorn: { d: 'M16 44 C16 24 32 14 50 14 C68 14 84 24 84 44 C84 48 80 51 75 51 C77 76 65 94 50 94 C35 94 23 76 25 51 C20 51 16 48 16 44 Z', top: 14, face: 64, neck: 88, half: 26,
    profile: [[0, 0], [0.3, 0.05], [0.37, 0.28], [0.34, 0.37], [0.27, 0.42], [0.3, 0.62], [0.22, 0.9], [0, 1]] },
  drop: { d: 'M50 6 C62 28 86 46 86 64 C86 82 70 94 50 94 C30 94 14 82 14 64 C14 46 38 28 50 6 Z', top: 10, face: 62, neck: 86, half: 30,
    profile: [[0, 0], [0.05, 0.04], [0.2, 0.25], [0.42, 0.56], [0.42, 0.76], [0.3, 0.94], [0, 1]] },
  bun: { d: 'M8 70 C8 40 28 26 50 26 C72 26 92 40 92 70 C92 86 80 92 50 92 C20 92 8 86 8 70 Z', top: 26, face: 58, neck: 84, half: 40,
    profile: [[0, 0], [0.32, 0.06], [0.5, 0.36], [0.52, 0.7], [0.44, 0.95], [0, 1]] },
};

export const ACCESSORY_COLOR: Record<string, string> = { bow: '#e5484d', headphones: '#ff7a45', beanie: '#9b6bff', scarf: '#3f8efc', glasses: '#25303d', freckles: '#25303d' };

export function mix(hex: string, t: number, to: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (to - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
