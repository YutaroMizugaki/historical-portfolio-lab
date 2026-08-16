/// <reference lib="webworker" />
import { buildFrontierMap } from '../engine/frontier'
import type { FrontierMap, FrontierRequest } from '../types'

type Msg = { type: 'done'; result: FrontierMap } | { type: 'error'; message: string }

self.onmessage = (event: MessageEvent<FrontierRequest>) => {
  try {
    const result = buildFrontierMap(event.data)
    const done: Msg = { type: 'done', result }
    self.postMessage(done)
  } catch (err) {
    const msg: Msg = { type: 'error', message: err instanceof Error ? err.message : String(err) }
    self.postMessage(msg)
  }
}
