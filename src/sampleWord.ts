import { STROKE, wordSegments, type Segment } from './glyphs'

export const WORD_HEIGHT = 3.6
const HALF_WIDTH = (STROKE * WORD_HEIGHT) / 2
const Z_STRETCH = 1.5
const PACKING = 0.14
const PAIR_BIN = 400

export type ParticleData = {
  count: number
  /** xyz = AKQA target, w = random seed */
  targetA: Float32Array
  /** xyz = WPP target, w = morph delay in [0, 1] */
  targetB: Float32Array
  /** xyz = scatter offset at the peak of the transition */
  scatter: Float32Array
  radius: Float32Array
  maxRadius: number
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function distToSegment(x: number, y: number, [[ax, ay], [bx, by]]: Segment) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
  return Math.hypot(x - ax - dx * t, y - ay - dy * t)
}

function segLength([[ax, ay], [bx, by]]: Segment) {
  return Math.hypot(bx - ax, by - ay)
}

function tubeVolume(segments: Segment[]) {
  const len = segments.reduce((s, seg) => s + segLength(seg), 0)
  return len * Math.PI * HALF_WIDTH * HALF_WIDTH * Z_STRETCH
}

/** Places spheres (largest first) inside the word's stroke tubes, minimising overlap. */
function placeInWord(segments: Segment[], radii: Float32Array, rng: () => number): Float32Array {
  const n = radii.length
  const out = new Float32Array(n * 3)
  const lengths = segments.map(segLength)
  const cumulative: number[] = []
  lengths.reduce((acc, l, i) => (cumulative[i] = acc + l), 0)
  const totalLen = cumulative[cumulative.length - 1]

  const cell = radii[0] * 2
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`

  const inside = (x: number, y: number, z: number, r: number) => {
    let d = Infinity
    for (const s of segments) d = Math.min(d, distToSegment(x, y, s))
    return Math.hypot(d, z / Z_STRETCH) + r * 0.7 < HALF_WIDTH
  }

  const worstOverlap = (x: number, y: number, z: number, r: number) => {
    let worst = -Infinity
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    const cz = Math.floor(z / cell)
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const bucket = grid.get(`${cx + i},${cy + j},${cz + k}`)
          if (!bucket) continue
          for (const o of bucket) {
            const d = Math.hypot(x - out[o * 3], y - out[o * 3 + 1], z - out[o * 3 + 2])
            worst = Math.max(worst, (r + radii[o]) * 0.95 - d)
          }
        }
    return worst
  }

  const candidate = (r: number): [number, number, number] => {
    for (let tries = 0; tries < 200; tries++) {
      const pick = rng() * totalLen
      let s = cumulative.findIndex((c) => c >= pick)
      if (s < 0) s = segments.length - 1
      const [[ax, ay], [bx, by]] = segments[s]
      const t = rng()
      const len = lengths[s] || 1
      const nx = -(by - ay) / len
      const ny = (bx - ax) / len
      const u = (rng() * 2 - 1) * HALF_WIDTH
      const x = ax + (bx - ax) * t + nx * u
      const y = ay + (by - ay) * t + ny * u
      const z = (rng() * 2 - 1) * HALF_WIDTH * Z_STRETCH
      if (inside(x, y, z, r)) return [x, y, z]
    }
    const [[ax, ay]] = segments[0]
    return [ax, ay, 0]
  }

  for (let i = 0; i < n; i++) {
    const r = radii[i]
    let best: [number, number, number] = [0, 0, 0]
    let bestOverlap = Infinity
    for (let attempt = 0; attempt < 60; attempt++) {
      const p = candidate(r)
      const o = worstOverlap(p[0], p[1], p[2], r)
      if (o < bestOverlap) {
        bestOverlap = o
        best = p
      }
      if (o <= 0) break
    }
    out.set(best, i * 3)
    const k = key(best[0], best[1], best[2])
    const bucket = grid.get(k)
    if (bucket) bucket.push(i)
    else grid.set(k, [i])
  }
  return out
}

/** Samples both words with one radius list; pairs slots by x within radius bins. */
export function buildParticles(count: number, seed = 7): ParticleData {
  const rng = mulberry32(seed)
  const segA = wordSegments('AKQA', WORD_HEIGHT)
  const segB = wordSegments('WPP', WORD_HEIGHT)

  const raw = Float32Array.from({ length: count }, () => 0.35 + 0.65 * Math.pow(rng(), 2.2))
  raw.sort().reverse()
  const rawVolume = raw.reduce((s, r) => s + (4 / 3) * Math.PI * r ** 3, 0)
  const volume = Math.min(tubeVolume(segA), tubeVolume(segB))
  const scale = Math.cbrt((PACKING * volume) / rawVolume)
  const radius = raw.map((r) => r * scale)

  const posA = placeInWord(segA, radius, rng)
  const posB = placeInWord(segB, radius, rng)

  const targetA = new Float32Array(count * 4)
  const targetB = new Float32Array(count * 4)
  const scatter = new Float32Array(count * 4)
  const outRadius = new Float32Array(count)

  const byX = (pos: Float32Array) => (a: number, b: number) =>
    pos[a * 3] - pos[b * 3] || pos[a * 3 + 1] - pos[b * 3 + 1]

  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, posA[i * 3])
    maxX = Math.max(maxX, posA[i * 3])
  }

  let p = 0
  for (let start = 0; start < count; start += PAIR_BIN) {
    const slots = Array.from({ length: Math.min(PAIR_BIN, count - start) }, (_, i) => start + i)
    const a = [...slots].sort(byX(posA))
    const b = [...slots].sort(byX(posB))
    for (let r = 0; r < slots.length; r++, p++) {
      const ia = a[r]
      const ib = b[r]
      const ax = posA[ia * 3]
      const ay = posA[ia * 3 + 1]
      targetA.set([ax, ay, posA[ia * 3 + 2], rng()], p * 4)
      const sweep = (ax - minX) / (maxX - minX || 1)
      targetB.set([posB[ib * 3], posB[ib * 3 + 1], posB[ib * 3 + 2], sweep * 0.75 + rng() * 0.25], p * 4)
      outRadius[p] = radius[ia]

      // Random 3D direction, biased outward from the word centre and stretched in depth.
      let dx = rng() * 2 - 1 + ax * 0.08
      let dy = rng() * 2 - 1 + ay * 0.25
      let dz = (rng() * 2 - 1) * 1.9
      const len = Math.hypot(dx, dy, dz) || 1
      const mag = 3 + rng() * 5.5
      dx = (dx / len) * mag
      dy = (dy / len) * mag
      dz = (dz / len) * mag
      scatter.set([dx, dy, dz, 0], p * 4)
    }
  }

  return { count, targetA, targetB, scatter, radius: outRadius, maxRadius: radius[0] }
}
