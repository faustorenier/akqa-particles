import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  Group,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from "three/webgpu";
import { buildParticles } from "./sampleWord";
import { createSimulation, TRAIL_LENGTH } from "./simulation";
import { createFluid } from "./fluid";

const COUNT = 10000;
const FOV = 35;
const FIT_WIDTH = 18.5;
const FIT_HEIGHT = 9;
const MORPH_STIFFNESS = 16;
const INTRO_DURATION = 2.6;
const FADE_DURATION = 1.6;
const POINTER_FORCE = 320;
const POINTER_REST = 0.02;
const POINTER_FULL_SPEED = 12;
const TRAIL_GAIN = 0.4;
const TRAIL_SPACING = 0.45;
const TRAIL_LIFETIME = 0.8;
const GLOW_SCALE = 1.8 / POINTER_FORCE;

type Props = { paused: RefObject<boolean>; reducedMotion: boolean };

export function Particles({ paused, reducedMotion }: Props) {
  const gl = useThree((s) => s.gl) as unknown as WebGPURenderer;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const group = useRef<Group>(null);

  const sim = useMemo(() => createSimulation(buildParticles(COUNT)), []);
  useEffect(() => () => sim.dispose(), [sim]);
  const fluid = useMemo(() => createFluid(), []);
  useEffect(() => () => fluid.dispose(), [fluid]);

  useEffect(() => {
    sim.uniforms.uGlowScale.value = GLOW_SCALE;
  }, [sim]);

  useEffect(() => {
    sim.uniforms.uScatter.value = reducedMotion ? 0.35 : 1;
    sim.uniforms.uIdle.value = reducedMotion ? 0.35 : 1;
  }, [sim, reducedMotion]);

  useEffect(() => {
    const aspect = size.width / size.height;
    const halfTan = Math.tan((FOV * Math.PI) / 360);
    camera.fov = FOV;
    camera.position.set(
      0,
      0,
      Math.max(FIT_WIDTH / (2 * halfTan * aspect), FIT_HEIGHT / (2 * halfTan)),
    );
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, size]);

  const pointer = useRef({
    ndc: new Vector2(),
    active: false,
    strength: 0,
    energy: 0,
    tracking: false,
    prev: new Vector3(),
    lastDrop: new Vector3(),
    trailHead: 0,
    from: new Vector2(),
    to: new Vector2(),
    velocity: new Vector2(),
  });
  useEffect(() => {
    const state = pointer.current;
    const move = (e: PointerEvent) => {
      state.ndc.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      );
      state.active = true;
    };
    const release = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") state.active = false;
    };
    const leave = () => (state.active = false);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", move, { passive: true });
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
    };
  }, []);

  const morph = useRef({ value: 0, velocity: 0 });
  const introTime = useRef(0);
  const scratch = useMemo(
    () => ({
      raycaster: new Raycaster(),
      plane: new Plane(),
      hit: new Vector3(),
      normal: new Vector3(),
      pointerStep: new Vector2(),
    }),
    [],
  );

  useFrame((_, delta) => {
    if (paused.current || !group.current) return;
    const dt = Math.min(delta, 1 / 30);
    const u = sim.uniforms;

    const scrollable =
      document.documentElement.scrollHeight - window.innerHeight;
    const target =
      scrollable > 0
        ? Math.min(1, Math.max(0, window.scrollY / scrollable))
        : 0;
    // Critically damped spring: scroll reversals change the target, never the current state.
    const m = morph.current;
    m.velocity +=
      (MORPH_STIFFNESS * (target - m.value) -
        2 * Math.sqrt(MORPH_STIFFNESS) * m.velocity) *
      dt;
    m.value += m.velocity * dt;

    const p = pointer.current;
    p.strength += ((p.active ? 1 : 0) - p.strength) * (1 - Math.exp(-dt * 6));
    const g = group.current;
    const tilt = reducedMotion ? 0 : 1;
    g.rotation.y +=
      (p.ndc.x * 0.12 * tilt * p.strength - g.rotation.y) *
      (1 - Math.exp(-dt * 2.5));
    g.rotation.x +=
      (-p.ndc.y * 0.08 * tilt * p.strength - g.rotation.x) *
      (1 - Math.exp(-dt * 2.5));
    g.updateMatrixWorld();

    const { raycaster, plane, hit, normal, pointerStep } = scratch;
    raycaster.setFromCamera(p.ndc, camera);
    normal.set(0, 0, 1).transformDirection(g.matrixWorld);
    plane.setFromNormalAndCoplanarPoint(normal, g.getWorldPosition(hit));
    let energyTarget = 0;
    let moved = false;
    let emitting = false;
    if (raycaster.ray.intersectPlane(plane, hit)) {
      const local = g.worldToLocal(hit);
      if (p.active && p.tracking) {
        emitting = true;
        p.from.set(p.prev.x, p.prev.y);
        pointerStep.set(local.x - p.prev.x, local.y - p.prev.y).divideScalar(dt);
        p.velocity.lerp(pointerStep, 1 - Math.exp(-dt * 10));
        energyTarget = Math.min(
          1,
          local.distanceTo(p.prev) / dt / POINTER_FULL_SPEED,
        );
        moved = local.distanceTo(p.lastDrop) > TRAIL_SPACING;
      }
      p.prev.copy(local);
      p.tracking = p.active;
      u.uPointer.value.copy(local);
    } else p.tracking = false;
    // Fast attack, slow release: the push keeps its momentum for a moment after the pointer stops.
    p.energy +=
      (energyTarget - p.energy) *
      (1 - Math.exp(-dt * (energyTarget > p.energy ? 12 : 2.5)));
    const force =
      p.strength *
      POINTER_FORCE *
      (POINTER_REST + (1 - POINTER_REST) * p.energy);

    const fade = Math.exp(-dt / TRAIL_LIFETIME);
    for (const point of u.uTrail) point.value.w *= fade;
    if (moved) {
      u.uTrail[p.trailHead].value.set(
        p.prev.x,
        p.prev.y,
        p.prev.z,
        force * TRAIL_GAIN,
      );
      p.trailHead = (p.trailHead + 1) % TRAIL_LENGTH;
      p.lastDrop.copy(p.prev);
    }

    introTime.current += dt;
    const easeOut = (x: number) => 1 - (1 - Math.min(1, x)) ** 3;
    u.uIntro.value = easeOut(introTime.current / INTRO_DURATION);
    u.uFade.value = easeOut(introTime.current / FADE_DURATION);

    u.uMorph.value = m.value;
    u.uDt.value = dt;
    u.uTime.value += dt;
    u.uPointerStrength.value = force;
    sim.step(gl);

    p.to.set(p.prev.x, p.prev.y);
    if (!emitting) p.from.copy(p.to);
    const inflow = emitting ? p.energy ** 1.5 * (reducedMotion ? 0.3 : 1) : 0;
    fluid.step(gl, dt, p.from, p.to, p.velocity, inflow);
  });

  return (
    <group ref={group}>
      <primitive object={sim.mesh} />
      <primitive object={fluid.mesh} />
    </group>
  );
}
