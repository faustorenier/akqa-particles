import { Canvas, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WebGPURenderer } from "three/webgpu";
import { checkWebGPU, createRenderer } from "./createRenderer";
import { Particles } from "./Particles";

const FRAME_MS = 1000 / 60;

function FrameDriver({ paused }: { paused: boolean }) {
  const advance = useThree((s) => s.advance);
  const size = useThree((s) => s.size);

  useEffect(() => {
    if (paused) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // 2 ms of slack so a 120 Hz display lands on every other vblank instead of drifting.
      if (document.hidden || now - last < FRAME_MS - 2) return;
      last = now;
      advance(now);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paused, advance]);

  useEffect(() => {
    if (paused) advance(performance.now());
  }, [paused, advance, size]);

  return null;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export default function App() {
  const [status, setStatus] = useState<"checking" | "ready" | "error">(
    "checking",
  );
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();

  const fail = useCallback((message: string) => {
    setError(message);
    setStatus("error");
  }, []);

  useEffect(() => {
    checkWebGPU().then((message) =>
      message ? fail(message) : setStatus("ready"),
    );
  }, [fail]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      pausedRef.current = !p;
      return !p;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") togglePause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause]);

  return (
    <>
      <div className="scroll-track" aria-hidden="true" />
      {status === "ready" && (
        <Canvas
          className="stage"
          frameloop="never"
          dpr={[1, 1.5]}
          camera={{ fov: 35, near: 0.1, far: 200, position: [0, 0, 30] }}
          gl={(props) =>
            createRenderer(
              props as ConstructorParameters<typeof WebGPURenderer>[0],
              fail,
            )
          }
          aria-label="Sfere bianche che compongono AKQA e, scorrendo, WPP"
        >
          <color attach="background" args={["#000"]} />
          <hemisphereLight args={["#ffffff", "#1a1a1a", 0.35]} />
          <directionalLight position={[6, 7, 9]} intensity={2.8} />
          <directionalLight position={[-7, -2, 6]} intensity={0.5} />
          <directionalLight position={[-5, 4, -9]} intensity={2.4} />
          <Particles paused={pausedRef} reducedMotion={reducedMotion} />
          <FrameDriver paused={paused} />
        </Canvas>
      )}

      {status === "error" && (
        <div className="error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => location.reload()}>
            Ricarica
          </button>
        </div>
      )}

      <p className="hint" aria-hidden="true">
        Scroll
      </p>
      <button
        type="button"
        className="pause"
        aria-pressed={paused}
        onClick={togglePause}
        title="Pausa / riprendi (P)"
      >
        {paused ? "Riprendi" : "Pausa"}
      </button>
    </>
  );
}
