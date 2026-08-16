/// <reference lib="webworker" />
import type { OptimizeRequest, OptimizeResponse, OptimizeProgress } from '../types'
import { runOptimize } from '../engine/optimize'
import type { AssetClass } from '../types'

type In = OptimizeRequest & { assetClasses: AssetClass[] }

type Msg =
  | ({ type: 'progress' } & OptimizeProgress)
  | { type: 'done'; result: OptimizeResponse }
  | { type: 'error'; message: string }

self.onmessage = (event: MessageEvent<In>) => {
  try {
    const result = runOptimize(event.data, (p) => {
      const msg: Msg = { type: 'progress', ...p }
      self.postMessage(msg)
    })
    const done: Msg = { type: 'done', result }
    self.postMessage(done)
  } catch (err) {
    const msg: Msg = { type: 'error', message: err instanceof Error ? err.message : String(err) }
    self.postMessage(msg)
  }
}
