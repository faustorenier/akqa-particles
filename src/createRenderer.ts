import { WebGPURenderer } from 'three/webgpu'

type GpuNavigator = Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }

/** Resolves to an error message when the browser cannot provide a WebGPU adapter. */
export async function checkWebGPU(): Promise<string | null> {
  const gpu = (navigator as GpuNavigator).gpu
  if (!gpu) return 'Questo browser non espone WebGPU. Usa una versione recente di Chrome.'
  try {
    const adapter = await gpu.requestAdapter()
    return adapter ? null : 'Nessun adattatore WebGPU disponibile su questo dispositivo.'
  } catch {
    return 'Richiesta dell’adattatore WebGPU non riuscita.'
  }
}

export async function createRenderer(
  props: ConstructorParameters<typeof WebGPURenderer>[0],
  onFatal: (message: string) => void,
) {
  const renderer = new WebGPURenderer({ ...props, antialias: true, powerPreference: 'high-performance' })
  await renderer.init()
  // WebGPURenderer silently falls back to WebGL2; this demo must run on the WebGPU backend.
  if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
    onFatal('Il renderer è passato al backend WebGL: WebGPU non è realmente attivo.')
  }
  renderer.onDeviceLost = (info) => onFatal(`Dispositivo GPU perso (${info.reason ?? 'motivo sconosciuto'}).`)
  return renderer
}
