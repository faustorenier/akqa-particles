import {
  Fn,
  abs,
  clamp,
  exp,
  float,
  floor,
  fract,
  instanceIndex,
  instancedArray,
  int,
  length,
  max,
  min,
  mix,
  select,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import { AdditiveBlending, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector2 } from 'three/webgpu'
import type { ComputeNode, Node, StorageBufferNode, WebGPURenderer } from 'three/webgpu'

const GRID_W = 240
const GRID_H = 135
const WORLD_W = 24
const WORLD_H = (WORLD_W * GRID_H) / GRID_W
const CELL = WORLD_W / GRID_W
const PLANE_Z = 0.25
const PRESSURE_ITERATIONS = 24
const PRESSURE_RETAIN = 0.8
const VELOCITY_DISSIPATION = 1.2
const DYE_DISSIPATION = 0.75
const VORTICITY = 10
const SPLAT_RADIUS = 0.3
const SPLAT_FORCE = 0.6
// Semi-Lagrangian advection stays sharp below ~2 cells per frame.
const MAX_SPEED = 120
const SPLAT_DYE = 14
const SMOKE_OPACITY = 0.5
const NEBULA_DRIFT = 0.08

type Field = 'float' | 'vec2'

export type Fluid = ReturnType<typeof createFluid>

/** Stable-fluids smoke on a grid in the word plane; the pointer injects velocity and glowing dye. */
export function createFluid() {
  const cells = GRID_W * GRID_H
  const velocity = instancedArray(cells, 'vec2')
  const velocityNext = instancedArray(cells, 'vec2')
  const dye = instancedArray(cells, 'float')
  const dyeNext = instancedArray(cells, 'float')
  const pressure = instancedArray(cells, 'float')
  const pressureNext = instancedArray(cells, 'float')
  const divergence = instancedArray(cells, 'float')
  const curl = instancedArray(cells, 'float')

  const uDt = uniform(1 / 60)
  const uFrom = uniform(new Vector2())
  const uTo = uniform(new Vector2())
  const uPointerVelocity = uniform(new Vector2())
  const uEnergy = uniform(0)
  const uTime = uniform(0)

  const cellX = int(instanceIndex).mod(int(GRID_W))
  const cellY = int(instanceIndex).div(int(GRID_W))
  const clampInt = (v: Node<'int'>, hi: number) =>
    select(v.lessThan(int(0)), int(0), select(v.greaterThan(int(hi)), int(hi), v))
  const index = (x: Node<'int'>, y: Node<'int'>) =>
    clampInt(y, GRID_H - 1)
      .mul(int(GRID_W))
      .add(clampInt(x, GRID_W - 1))
  // @types/three can't infer element types through a generic buffer, hence the casts.
  const read = <T extends Field>(buffer: StorageBufferNode<T>, i: Node<'int'>) =>
    buffer.element(i) as unknown as Node<T>
  const at = <T extends Field>(buffer: StorageBufferNode<T>, dx: number, dy: number) =>
    read(buffer, index(cellX.add(int(dx)), cellY.add(int(dy))))

  const bilinear = <T extends Field>(buffer: StorageBufferNode<T>, p: Node<'vec2'>) => {
    const q = clamp(p, vec2(0, 0), vec2(GRID_W - 1, GRID_H - 1)).toVar()
    const x0 = int(floor(q.x))
    const y0 = int(floor(q.y))
    const f = fract(q)
    const corner = (dx: number, dy: number) =>
      read(buffer, index(x0.add(int(dx)), y0.add(int(dy)))) as unknown as Node<'vec2'>
    const row0 = mix(corner(0, 0), corner(1, 0), f.x)
    const row1 = mix(corner(0, 1), corner(1, 1), f.x)
    return mix(row0, row1, f.y) as unknown as Node<T>
  }

  const kernel = (body: () => void) => Fn(body)().compute(cells)

  const splat = kernel(() => {
    // Distance from this cell to the segment the pointer swept during the last frame (world units).
    const world = vec2(float(cellX).add(0.5), float(cellY).add(0.5)).mul(CELL).sub(vec2(WORLD_W / 2, WORLD_H / 2))
    const seg = uTo.sub(uFrom).toVar()
    const t = clamp(world.sub(uFrom).dot(seg).div(max(seg.dot(seg), 1e-6)), 0, 1)
    const d = length(world.sub(uFrom.add(seg.mul(t))))
    const falloff = exp(d.mul(d).div(-(SPLAT_RADIUS * SPLAT_RADIUS))).mul(uEnergy).toVar()
    const v = velocity.element(instanceIndex)
    // Blend towards the pointer's velocity instead of adding it, so repeated strokes can't pile up energy.
    v.assign(mix(v, uPointerVelocity.div(CELL), clamp(falloff.mul(SPLAT_FORCE), 0, 1)))
    const s = dye.element(instanceIndex)
    s.assign(s.add(falloff.mul(SPLAT_DYE).mul(uDt)))
  })

  const computeCurl = kernel(() => {
    const value = at(velocity, 1, 0).y.sub(at(velocity, -1, 0).y).sub(at(velocity, 0, 1).x.sub(at(velocity, 0, -1).x))
    curl.element(instanceIndex).assign(value.mul(0.5))
  })

  // Vorticity confinement re-injects the small swirls that numerical diffusion smears out.
  const vorticity = kernel(() => {
    const force = vec2(abs(at(curl, 0, 1)).sub(abs(at(curl, 0, -1))), abs(at(curl, 1, 0)).sub(abs(at(curl, -1, 0))))
      .mul(0.5)
      .toVar()
    force.assign(force.div(length(force).add(1e-4)).mul(curl.element(instanceIndex)).mul(VORTICITY))
    const v = velocity.element(instanceIndex)
    v.assign(v.add(vec2(force.x, force.y.negate()).mul(uDt)))
  })

  const computeDivergence = kernel(() => {
    // Backward div + forward gradient form the 5-point Laplacian; central diffs leave striped modes.
    const v = velocity.element(instanceIndex)
    const value = v.x.sub(at(velocity, -1, 0).x).add(v.y.sub(at(velocity, 0, -1).y))
    divergence.element(instanceIndex).assign(value)
    const p = pressure.element(instanceIndex)
    p.assign(p.mul(PRESSURE_RETAIN))
  })

  const jacobi = (source: StorageBufferNode<'float'>, target: StorageBufferNode<'float'>) =>
    kernel(() => {
      const sum = at(source, -1, 0).add(at(source, 1, 0)).add(at(source, 0, -1)).add(at(source, 0, 1))
      target.element(instanceIndex).assign(sum.sub(divergence.element(instanceIndex)).mul(0.25))
    })
  const jacobiForward = jacobi(pressure, pressureNext)
  const jacobiBack = jacobi(pressureNext, pressure)

  const subtractGradient = kernel(() => {
    const p = pressure.element(instanceIndex)
    const gradient = vec2(at(pressure, 1, 0).sub(p), at(pressure, 0, 1).sub(p))
    const v = velocity.element(instanceIndex)
    v.assign(v.sub(gradient))
  })

  // Semi-Lagrangian advection: sample where this cell's content was one step ago.
  const advect = kernel(() => {
    const v = velocity.element(instanceIndex)
    const back = vec2(float(cellX), float(cellY)).sub(v.mul(uDt))
    velocityNext.element(instanceIndex).assign(bilinear(velocity, back).div(uDt.mul(VELOCITY_DISSIPATION).add(1)))
    dyeNext.element(instanceIndex).assign(bilinear(dye, back).div(uDt.mul(DYE_DISSIPATION).add(1)))
  })

  const commit = kernel(() => {
    const next = velocityNext.element(instanceIndex).toVar()
    next.mulAssign(min(1, float(MAX_SPEED).div(max(length(next), 1e-5))))
    const border = cellX.equal(int(0)).or(cellY.equal(int(0))).or(cellX.equal(int(GRID_W - 1))).or(cellY.equal(int(GRID_H - 1)))
    velocity.element(instanceIndex).assign(select(border, vec2(0, 0), next))
    dye.element(instanceIndex).assign(dyeNext.element(instanceIndex))
  })

  const passes: ComputeNode[] = [splat, computeCurl, vorticity, computeDivergence]
  for (let i = 0; i < PRESSURE_ITERATIONS / 2; i++) passes.push(jacobiForward, jacobiBack)
  passes.push(subtractGradient, advect, commit)

  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
  const density = bilinear(dye, uv().mul(vec2(GRID_W, GRID_H)).sub(0.5)).toVar()
  const edge = smoothstep(0, 0.08, uv().x)
    .mul(smoothstep(0, 0.08, uv().x.oneMinus()))
    .mul(smoothstep(0, 0.1, uv().y))
    .mul(smoothstep(0, 0.1, uv().y.oneMinus()))
  const glow = density.mul(2).negate().exp().oneMinus().mul(edge)
  const drift = uTime.mul(NEBULA_DRIFT)
  const nebula = sin(uv().x.mul(5).add(uv().y.mul(3)).add(drift))
    .mul(sin(uv().y.mul(4).sub(uv().x.mul(2)).sub(drift.mul(1.3))))
    .mul(0.5)
    .add(0.5)
  const tint = mix(vec3(0.45, 0.8, 1), vec3(0.62, 0.48, 1), nebula)
  // Thin wisps sink to deep blue, mid densities take the drifting nebula tint, cores burn white.
  const hue = mix(vec3(0.22, 0.35, 0.95), tint, smoothstep(0.02, 0.35, glow))
  material.colorNode = mix(hue, vec3(1, 0.98, 1), smoothstep(0.45, 0.95, glow)).mul(glow).mul(SMOKE_OPACITY)
  const mesh = new Mesh(new PlaneGeometry(WORLD_W, WORLD_H), material)
  mesh.position.z = PLANE_Z
  mesh.renderOrder = 1

  return {
    mesh,
    /** Injects the pointer segment (group-local world units) and advances the fluid one frame. */
    step(renderer: WebGPURenderer, dt: number, from: Vector2, to: Vector2, pointerVelocity: Vector2, energy: number) {
      uDt.value = dt
      uTime.value += dt
      uFrom.value.copy(from)
      uTo.value.copy(to)
      uPointerVelocity.value.copy(pointerVelocity)
      uEnergy.value = energy
      renderer.compute(passes)
    },
    dispose() {
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}
