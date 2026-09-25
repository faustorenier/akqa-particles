import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicLoad,
  atomicStore,
  clamp,
  dot,
  exp,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  ivec3,
  length,
  max,
  min,
  mix,
  mx_noise_vec3,
  normalize,
  positionLocal,
  select,
  smoothstep,
  sqrt,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import { InstancedMesh, MeshStandardNodeMaterial, SphereGeometry, Vector3, Vector4 } from 'three/webgpu'
import type { ComputeNode, Node, WebGPURenderer } from 'three/webgpu'
import type { ParticleData } from './sampleWord'

const SPRING = 34
const DAMPING = 4.2
const MAX_SPEED = 40
const MORPH_DELAY = 0.45
const INTRO_SPREAD = 0.4
const INTRO_DEPTH = -3
const POINTER_RADIUS = 1.6
const GLOW_DECAY = 2.2
const TRAIL_RADIUS = 0.85
export const TRAIL_LENGTH = 16
const COLLISION_ITERATIONS = 2
const RELAXATION = 0.8
const VELOCITY_TRANSFER = 0.35

const TABLE_SIZE = 32768
const SLOTS_PER_CELL = 16
// Keeps cell coordinates positive so the uint hash never sees negative ints.
const CELL_OFFSET = 4096

export type Simulation = ReturnType<typeof createSimulation>

// @types/three omits Loop's runtime `name` option, needed so nested loops don't both declare `i`.
function namedLoop<T extends 'int' | 'uint'>(
  name: string,
  range: { start: Node<T> | number; end: Node<T> | number; type: T },
  body: (index: Node<T>) => void,
) {
  const loop = Loop as unknown as (param: object, fn: (inputs: Record<string, Node<T>>) => void) => void
  loop({ ...range, name }, (inputs) => body(inputs[name]))
}

export function createSimulation(data: ParticleData) {
  const n = data.count
  const cellSize = data.maxRadius * 2

  const initial = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    initial[i * 4] = data.targetA[i * 4] + data.scatter[i * 4] * INTRO_SPREAD
    initial[i * 4 + 1] = data.targetA[i * 4 + 1] + data.scatter[i * 4 + 1] * INTRO_SPREAD
    initial[i * 4 + 2] = data.targetA[i * 4 + 2] + data.scatter[i * 4 + 2] * INTRO_SPREAD + INTRO_DEPTH
    initial[i * 4 + 3] = data.radius[i]
  }

  // pos.w carries the radius so the collision pass reads one vec4 per neighbour.
  const pos = instancedArray(initial, 'vec4')
  const posNext = instancedArray(n, 'vec4')
  const vel = instancedArray(n, 'vec4')
  const targetA = instancedArray(data.targetA, 'vec4')
  const targetB = instancedArray(data.targetB, 'vec4')
  const scatter = instancedArray(data.scatter, 'vec4')
  const crowding = instancedArray(n, 'float')
  const glow = instancedArray(n, 'float')
  const cellCount = instancedArray(TABLE_SIZE, 'uint').toAtomic()
  const cellSlots = instancedArray(TABLE_SIZE * SLOTS_PER_CELL, 'uint')

  const uMorph = uniform(0)
  const uTime = uniform(0)
  const uDt = uniform(1 / 60)
  const uPointer = uniform(new Vector3(0, 0, 999))
  const uPointerStrength = uniform(0)
  const uScatter = uniform(1)
  const uIdle = uniform(1)
  const uIntro = uniform(0)
  const uFade = uniform(0)
  // xyz = past pointer position, w = remaining strength. Plain uniforms are refreshed on compute.
  const uGlowScale = uniform(0)
  const uTrail = Array.from({ length: TRAIL_LENGTH }, () => uniform(new Vector4(0, 0, 999, 0)))

  const cellOf = (p: Node<'vec3'>) => ivec3(floor(p.div(cellSize))).add(ivec3(CELL_OFFSET))
  const hashCell = (c: Node<'ivec3'>) =>
    uint(c.x)
      .mul(uint(73856093))
      .bitXor(uint(c.y).mul(uint(19349663)))
      .bitXor(uint(c.z).mul(uint(83492791)))
      .bitAnd(uint(TABLE_SIZE - 1))

  const integrate = Fn(() => {
    const p = pos.element(instanceIndex)
    const v = vel.element(instanceIndex)
    const a = targetA.element(instanceIndex)
    const b = targetB.element(instanceIndex)

    const local = smoothstep(0, 1, clamp(uMorph.sub(b.w.mul(MORPH_DELAY)).div(1 - MORPH_DELAY), 0, 1))
    const burst = local.mul(local.oneMinus()).mul(4).toVar()
    const home = mix(a.xyz, b.xyz, local).toVar()

    const idle = mx_noise_vec3(vec3(home.xy.mul(0.3), uTime.mul(0.35).add(a.w.mul(17))))
      .mul(vec3(0.1, 0.1, 0.8))
      .mul(uIdle)
    const turbulence = mx_noise_vec3(home.mul(0.2).add(vec3(0, 0, uTime.mul(0.6)))).mul(2.6)
    const flight = scatter.element(instanceIndex).xyz.add(turbulence).mul(burst.mul(uScatter))
    // Shrinking the offset on an eased curve lets the spring follow a slow target instead of snapping.
    const gathered = smoothstep(0, 1, clamp(uIntro.mul(1.5).sub(a.w.mul(0.5)), 0, 1))
    const intro = scatter.element(instanceIndex).xyz.mul(INTRO_SPREAD).add(vec3(0, 0, INTRO_DEPTH)).mul(gathered.oneMinus())
    const target = home.add(idle).add(flight).add(intro)

    const acc = target.sub(p.xyz).mul(mix(SPRING, SPRING * 0.2, burst)).toVar()

    // Repulsion dents the word backwards so the hover reads as a spatial crater, not a 2D push.
    const heat = float(0).toVar()
    const repel = (center: Node<'vec3'>, strength: Node<'float'>, radius: number) => {
      const d = p.xyz.sub(center).toVar()
      const falloff = clamp(length(vec3(d.x, d.y, d.z.mul(0.4))).div(radius).oneMinus(), 0, 1)
      const push = falloff.mul(falloff).mul(strength).toVar()
      heat.addAssign(push)
      return normalize(vec3(d.x, d.y, -0.6)).mul(push)
    }
    acc.addAssign(repel(uPointer, uPointerStrength, POINTER_RADIUS))
    for (const point of uTrail) acc.addAssign(repel(point.xyz, point.w, TRAIL_RADIUS))

    // Spheres light up where the pointer passes and cool down slowly, leaving a luminous wake.
    const g = glow.element(instanceIndex)
    g.assign(max(min(heat.mul(uGlowScale), 1), g.mul(exp(uDt.mul(-GLOW_DECAY)))))

    const nextVel = v.xyz.add(acc.mul(uDt)).mul(exp(uDt.mul(-DAMPING))).toVar()
    nextVel.mulAssign(min(1, float(MAX_SPEED).div(max(length(nextVel), 1e-5))))

    v.assign(vec4(nextVel, 0))
    p.assign(vec4(p.xyz.add(nextVel.mul(uDt)), p.w))
  })().compute(n)

  const clearGrid = Fn(() => {
    atomicStore(cellCount.element(instanceIndex), uint(0))
  })().compute(TABLE_SIZE)

  const binParticles = Fn(() => {
    const h = hashCell(cellOf(pos.element(instanceIndex).xyz)).toVar()
    const slot = atomicAdd(cellCount.element(h), uint(1))
    If(slot.lessThan(uint(SLOTS_PER_CELL)), () => {
      cellSlots.element(h.mul(uint(SLOTS_PER_CELL)).add(slot)).assign(instanceIndex)
    })
  })().compute(n)

  // Jacobi step: every particle reads neighbours from `pos` and writes only its own `posNext`.
  const solveCollisions = Fn(() => {
    const pi = pos.element(instanceIndex).toVar()
    const ci = cellOf(pi.xyz).toVar()
    const correction = vec3(0).toVar()
    const neighbours = float(0).toVar()
    const ri3 = pi.w.mul(pi.w).mul(pi.w)

    namedLoop('c', { start: int(0), end: int(27), type: 'int' }, (c) => {
      const cell = ci.add(ivec3(c.mod(int(3)).sub(int(1)), c.div(int(3)).mod(int(3)).sub(int(1)), c.div(int(9)).sub(int(1)))).toVar()
      const h = hashCell(cell).toVar()
      const stored = atomicLoad(cellCount.element(h)).toVar()
      const count = select(stored.greaterThan(uint(SLOTS_PER_CELL)), uint(SLOTS_PER_CELL), stored)

      namedLoop('s', { start: uint(0), end: count, type: 'uint' }, (s) => {
        const j = cellSlots.element(h.mul(uint(SLOTS_PER_CELL)).add(s)).toVar()
        If(j.notEqual(instanceIndex), () => {
          const pj = pos.element(j).toVar()
          const cj = cellOf(pj.xyz)
          // Hash buckets are shared by distant cells: only accept particles that live in `cell`.
          If(cj.x.equal(cell.x).and(cj.y.equal(cell.y)).and(cj.z.equal(cell.z)), () => {
            const delta = pi.xyz.sub(pj.xyz).toVar()
            const dist2 = dot(delta, delta).toVar()
            const contact = pi.w.add(pj.w).toVar()
            If(dist2.lessThan(contact.mul(contact).mul(2.25)), () => {
              neighbours.addAssign(1)
            })
            If(dist2.lessThan(contact.mul(contact)).and(dist2.greaterThan(1e-10)), () => {
              const dist = sqrt(dist2)
              const rj3 = pj.w.mul(pj.w).mul(pj.w)
              const share = rj3.div(ri3.add(rj3))
              correction.addAssign(delta.div(dist).mul(contact.sub(dist)).mul(share))
            })
          })
        })
      })
    })

    const shift = correction.mul(RELAXATION)
    posNext.element(instanceIndex).assign(vec4(pi.xyz.add(shift), pi.w))
    const v = vel.element(instanceIndex)
    v.assign(vec4(v.xyz.add(shift.div(uDt).mul(VELOCITY_TRANSFER)), 0))
    crowding.element(instanceIndex).assign(neighbours)
  })().compute(n)

  const commit = Fn(() => {
    pos.element(instanceIndex).assign(posNext.element(instanceIndex))
  })().compute(n)

  const passes: ComputeNode[] = [integrate]
  for (let i = 0; i < COLLISION_ITERATIONS; i++) passes.push(clearGrid, binParticles, solveCollisions, commit)

  const geometry = new SphereGeometry(1, 16, 12)
  const material = new MeshStandardNodeMaterial({ roughness: 0.34, metalness: 0 })
  const body = pos.toAttribute()
  material.positionNode = positionLocal.mul(body.w).add(body.xyz)
  const packed = smoothstep(3, 16, crowding.toAttribute())
  const depth = smoothstep(-3.5, 1.2, body.z)
  material.colorNode = vec3(mix(1, 0.42, packed).mul(mix(0.5, 1, depth)).mul(uFade))
  material.emissiveNode = vec3(0.7, 0.82, 1).mul(glow.toAttribute().mul(1.6))

  const mesh = new InstancedMesh(geometry, material, n)
  mesh.frustumCulled = false

  return {
    mesh,
    uniforms: { uMorph, uTime, uDt, uPointer, uPointerStrength, uScatter, uIdle, uIntro, uFade, uTrail, uGlowScale },
    step(renderer: WebGPURenderer) {
      renderer.compute(passes)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      mesh.dispose()
    },
  }
}
