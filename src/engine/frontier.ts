import type {
  EvaluationBasis,
  FrontierMap,
  FrontierRequest,
  HedgeMode,
  RiskReturnPoint,
} from '../types.ts'
import { clipBounds, countAllocations, forEachAllocation } from './allocations.ts'

const SEARCH_CAP = 80_000
const CLOUD_CAP = 480

export function monthlyAssetReturns(input: {
  returns: number[][]
  fxReturns?: number[]
  foreign?: boolean[]
  hedgeReturns?: number[]
  hedgeMode?: HedgeMode
  expenseRatios: number[]
  cpiReturns?: number[]
  evaluationBasis?: EvaluationBasis
}): number[][] {
  const n = input.returns.length
  const tLen = input.returns[0]?.length ?? 0
  const rows = Array.from({ length: n }, () => new Array<number>(tLen))
  const hedgeMode = input.hedgeMode ?? 'unhedged'
  const real = input.evaluationBasis === 'real'
  for (let i = 0; i < n; i += 1) {
    const ter = input.expenseRatios[i] ?? 0
    const foreignAsset = Boolean(input.foreign?.[i])
    const row = rows[i]!
    for (let t = 0; t < tLen; t += 1) {
      const loc = input.returns[i]![t] ?? 0
      const fxR = foreignAsset
        ? hedgeMode === 'hedged'
          ? (input.hedgeReturns?.[t] ?? 0)
          : (input.fxReturns?.[t] ?? 0)
        : 0
      let r = (1 + loc) * (1 - ter / 12) * (1 + fxR) - 1
      if (real) r = (1 + r) / (1 + (input.cpiReturns?.[t] ?? 0)) - 1
      row[t] = r
    }
  }
  return rows
}

export function meanCov(assetReturns: number[][]): { mean: Float64Array; cov: Float64Array } {
  const n = assetReturns.length
  const tLen = assetReturns[0]?.length ?? 0
  const mean = new Float64Array(n)
  const cov = new Float64Array(n * n)
  if (tLen === 0 || n === 0) return { mean, cov }
  for (let i = 0; i < n; i += 1) {
    let s = 0
    const row = assetReturns[i]!
    for (let t = 0; t < tLen; t += 1) s += row[t] ?? 0
    mean[i] = s / tLen
  }
  const denom = Math.max(1, tLen - 1)
  for (let i = 0; i < n; i += 1) {
    const ri = assetReturns[i]!
    const mi = mean[i]!
    for (let j = i; j < n; j += 1) {
      const rj = assetReturns[j]!
      const mj = mean[j]!
      let v = 0
      for (let t = 0; t < tLen; t += 1) v += (ri[t]! - mi) * (rj[t]! - mj)
      const c = v / denom
      cov[i * n + j] = c
      cov[j * n + i] = c
    }
  }
  return { mean, cov }
}

export function portMoments(
  weights: ArrayLike<number>,
  mean: Float64Array,
  cov: Float64Array,
): { mu: number; sigma: number } {
  const n = mean.length
  let mu = 0
  let variance = 0
  for (let i = 0; i < n; i += 1) {
    const wi = weights[i] ?? 0
    mu += wi * (mean[i] ?? 0)
    for (let j = 0; j < n; j += 1) variance += wi * (weights[j] ?? 0) * (cov[i * n + j] ?? 0)
  }
  return {
    mu: mu * 12,
    sigma: Math.sqrt(Math.max(0, variance)) * Math.sqrt(12),
  }
}

function pickStep(n: number, requested: number, mins: number[], maxs: number[]): { step: number; count: number } {
  const steps = [requested, 2, 5, 10, 20, 25].filter((s, i, a) => a.indexOf(s) === i).sort((a, b) => a - b)
  let chosen = requested
  let count = Infinity
  for (const step of steps) {
    if (step < requested) continue
    const units = Math.round(100 / step)
    const b = clipBounds(n, units, mins, maxs, step)
    count = countAllocations(n, units, b.mins, b.maxs)
    chosen = step
    if (count <= SEARCH_CAP) break
  }
  return { step: chosen, count }
}

function toWeights(units: Int16Array, stepPct: number): number[] {
  const w = Array.from(units, (u) => (u * stepPct) / 100)
  const s = w.reduce((a, b) => a + b, 0)
  return s > 0 ? w.map((x) => x / s) : w
}

function copyPoint(weights: number[], mu: number, sigma: number): RiskReturnPoint {
  return { weights: weights.slice(), mu, sigma }
}

export function paretoFrontier(points: RiskReturnPoint[]): RiskReturnPoint[] {
  const sorted = points.slice().sort((a, b) => a.sigma - b.sigma || b.mu - a.mu)
  const out: RiskReturnPoint[] = []
  let bestMu = -Infinity
  for (const p of sorted) {
    if (p.mu > bestMu + 1e-12) {
      out.push(p)
      bestMu = p.mu
    }
  }
  return out
}

export function pickByRiskReturn(points: RiskReturnPoint[], sigma: number, mu: number): RiskReturnPoint | null {
  if (points.length === 0) return null
  let minS = Infinity
  let maxS = -Infinity
  let minM = Infinity
  let maxM = -Infinity
  for (const p of points) {
    if (p.sigma < minS) minS = p.sigma
    if (p.sigma > maxS) maxS = p.sigma
    if (p.mu < minM) minM = p.mu
    if (p.mu > maxM) maxM = p.mu
  }
  const sSpan = Math.max(1e-8, maxS - minS)
  const mSpan = Math.max(1e-8, maxM - minM)
  let best = points[0]!
  let bestD = Infinity
  for (const p of points) {
    const ds = (p.sigma - sigma) / sSpan
    const dm = (p.mu - mu) / mSpan
    const d = ds * ds + dm * dm
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

export function buildFrontierMap(req: FrontierRequest): FrontierMap {
  const n = req.returns.length
  if (n === 0) throw new Error('no assets')
  const assetReturns = monthlyAssetReturns(req)
  const { mean, cov } = meanCov(assetReturns)
  const { step, count } = pickStep(n, req.stepPct, req.mins, req.maxs)
  let note: string | null = null
  if (step !== req.stepPct) {
    note = `組み合わせが多いため ${step}% 刻みで地図を作りました（${count.toLocaleString()} 通り）。`
  }
  const units = Math.round(100 / step)
  const b = clipBounds(n, units, req.mins, req.maxs, step)
  const all: RiskReturnPoint[] = []
  const w = new Float64Array(n)
  forEachAllocation(n, units, b.mins, b.maxs, (u) => {
    const weights = toWeights(u, step)
    for (let i = 0; i < n; i += 1) w[i] = weights[i] ?? 0
    const { mu, sigma } = portMoments(w, mean, cov)
    all.push({ weights, mu, sigma })
  })
  if (all.length === 0) throw new Error('no feasible allocation')

  const frontier = paretoFrontier(all)
  const stride = Math.max(1, Math.ceil(all.length / CLOUD_CAP))
  const cloud: RiskReturnPoint[] = []
  for (let i = 0; i < all.length; i += stride) cloud.push(all[i]!)

  const assets = Array.from({ length: n }, (_, i) => {
    const one = new Float64Array(n)
    one[i] = 1
    return portMoments(one, mean, cov)
  })

  let minMu = Infinity
  let maxMu = -Infinity
  let minSigma = Infinity
  let maxSigma = -Infinity
  for (const p of frontier) {
    if (p.mu < minMu) minMu = p.mu
    if (p.mu > maxMu) maxMu = p.mu
    if (p.sigma < minSigma) minSigma = p.sigma
    if (p.sigma > maxSigma) maxSigma = p.sigma
  }

  return {
    assets,
    frontier: frontier.map((p) => copyPoint(p.weights, p.mu, p.sigma)),
    cloud: cloud.map((p) => copyPoint(p.weights, p.mu, p.sigma)),
    minMu,
    maxMu,
    minSigma,
    maxSigma,
    searched: all.length,
    stepUsed: step,
    note,
  }
}
