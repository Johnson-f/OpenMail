import { createBackgroundRuntime } from './runtime'
import type { MainToBackground } from './protocol'

const port = process.parentPort

const runtime = createBackgroundRuntime({
  send: (message) => port.postMessage(message),
  onShutdown: () => process.exit(0),
})

port.on('message', (event) => runtime.handle(event.data as MainToBackground))
runtime.start()
