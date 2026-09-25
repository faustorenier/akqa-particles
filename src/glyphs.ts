export type Vec2 = [number, number]
export type Segment = [Vec2, Vec2]

type Glyph = { width: number; segments: Segment[] }

// Glyph space: cap height 1, baseline y=0. Centerlines sit STROKE/2 inside the box.
export const STROKE = 0.2
const I = STROKE / 2

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 18): Segment[] {
  const out: Segment[] = []
  for (let s = 0; s < steps; s++) {
    const a0 = from + ((to - from) * s) / steps
    const a1 = from + ((to - from) * (s + 1)) / steps
    out.push([
      [cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry],
      [cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry],
    ])
  }
  return out
}

const top = 1 - I
const bottom = I

const GLYPHS: Record<string, Glyph> = {
  H: {
    width: 0.8,
    segments: [
      [[I, bottom], [I, top]],
      [[0.8 - I, bottom], [0.8 - I, top]],
      [[I, 0.5], [0.8 - I, 0.5]],
    ],
  },
  W: {
    width: 1.18,
    segments: [
      [[I, top], [0.34, bottom]],
      [[0.34, bottom], [0.59, 0.72]],
      [[0.59, 0.72], [0.84, bottom]],
      [[0.84, bottom], [1.18 - I, top]],
    ],
  },
  P: {
    width: 0.76,
    segments: [
      [[I, bottom], [I, top]],
      [[I, top], [0.43, top]],
      [[I, 0.4], [0.43, 0.4]],
      ...arc(0.43, (top + 0.4) / 2, 0.76 - I - 0.43, (top - 0.4) / 2, Math.PI / 2, -Math.PI / 2),
    ],
  },
  '-': {
    width: 0.44,
    segments: [[[I + 0.02, 0.47], [0.44 - I - 0.02, 0.47]]],
  },
  A: {
    width: 0.9,
    segments: [
      [[I, bottom], [0.45, top]],
      [[0.45, top], [0.9 - I, bottom]],
      [[0.23, 0.38], [0.67, 0.38]],
    ],
  },
  R: {
    width: 0.8,
    segments: [
      [[I, bottom], [I, top]],
      [[I, top], [0.46, top]],
      [[I, 0.5], [0.46, 0.5]],
      ...arc(0.46, (top + 0.5) / 2, 0.24, (top - 0.5) / 2, Math.PI / 2, -Math.PI / 2),
      [[0.42, 0.5], [0.8 - I, bottom]],
    ],
  },
  T: {
    width: 0.8,
    segments: [
      [[I, top], [0.8 - I, top]],
      [[0.4, bottom], [0.4, top]],
    ],
  },
  K: {
    width: 0.82,
    segments: [
      [[I, bottom], [I, top]],
      [[I + 0.04, 0.42], [0.82 - I, top]],
      [[0.33, 0.6], [0.82 - I, bottom]],
    ],
  },
  Q: {
    width: 0.96,
    segments: [
      ...arc(0.48, 0.5, 0.48 - I, 0.5 - I, 0, Math.PI * 2, 36),
      [[0.56, 0.3], [0.94, -0.04]],
    ],
  },
}

const TRACKING = 0.16

/** Centerline segments of `word`, centered on the origin and scaled to `height` world units. */
export function wordSegments(word: string, height: number): Segment[] {
  const glyphs = [...word].map((ch) => {
    const g = GLYPHS[ch]
    if (!g) throw new Error(`Glyph mancante: ${ch}`)
    return g
  })
  const total = glyphs.reduce((w, g) => w + g.width, 0) + TRACKING * (glyphs.length - 1)
  const out: Segment[] = []
  let x = -total / 2
  for (const g of glyphs) {
    for (const [a, b] of g.segments) {
      out.push([
        [(a[0] + x) * height, (a[1] - 0.5) * height],
        [(b[0] + x) * height, (b[1] - 0.5) * height],
      ])
    }
    x += g.width + TRACKING
  }
  return out
}
