import type { CostModel, FxReport } from '../types'
import { evaluateWeights, median } from './simulate'

function weightedMonths(returns: number[][], weights: number[]): number[] {
  const tLen = returns[0]?.length ?? 0
  const out = new Array<number>(tLen)
  for (let t = 0; t < tLen; t += 1) {
    let s = 0
    for (let i = 0; i < weights.length; i += 1) s += (weights[i] ?? 0) * (returns[i]?.[t] ?? 0)
    out[t] = s
  }
  return out
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function annVol(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let v = 0
  for (const x of xs) v += (x - m) ** 2
  v /= xs.length - 1
  return Math.sqrt(Math.max(0, v)) * Math.sqrt(12)
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i += 1) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  const den = Math.sqrt(da * db)
  return den < 1e-18 ? 0 : num / den
}

export function analyzeFx(input: {
  unhedgedReturns: number[][]
  hedgedReturns: number[][]
  fxReturns: number[]
  foreign: boolean[]
  weights: number[]
  dates: string[]
  periodMonths: number
  rollStep: number
  rebalEvery: number
  initial: number
  monthly: number
  target: number
  costs: CostModel
  liquidate: boolean
}): FxReport | null {
  const foreignWeight = input.weights.reduce((s, w, i) => s + (input.foreign[i] ? w : 0), 0)
  if (foreignWeight < 0.005) return null

  const uPort = weightedMonths(input.unhedgedReturns, input.weights)
  const hPort = weightedMonths(input.hedgedReturns, input.weights)
  const hedged = evaluateWeights({
    returns: input.hedgedReturns,
    dates: input.dates,
    weights: input.weights,
    periodMonths: input.periodMonths,
    rollStep: input.rollStep,
    rebalEvery: input.rebalEvery,
    initial: input.initial,
    monthly: input.monthly,
    target: input.target,
    rfAnnual: 0,
    costs: input.costs,
    liquidate: input.liquidate,
    withWindows: true,
    computeRequired: false,
  })
  const unhedged = evaluateWeights({
    returns: input.hedgedReturns,
    dates: input.dates,
    weights: input.weights,
    periodMonths: input.periodMonths,
    rollStep: input.rollStep,
    rebalEvery: input.rebalEvery,
    initial: input.initial,
    monthly: input.monthly,
    target: input.target,
    rfAnnual: 0,
    costs: input.costs,
    liquidate: input.liquidate,
    withWindows: true,
    computeRequired: false,
    fxReturns: input.fxReturns,
    foreign: input.foreign,
  })

  const impacts: { start: string; impact: number }[] = []
  for (const w of unhedged.windows) {
    const h = hedged.windows.find((x) => x.start === w.start)
    if (!h) continue
    impacts.push({ start: w.start, impact: w.final - h.final })
  }
  let worstFxImpact = 0
  let worstFxStart = unhedged.windows[0]?.start ?? ''
  for (const row of impacts) {
    if (row.impact < worstFxImpact) {
      worstFxImpact = row.impact
      worstFxStart = row.start
    }
  }

  return {
    foreignWeight,
    fxVol: annVol(input.fxReturns),
    unhedgedVol: annVol(uPort),
    hedgedVol: annVol(hPort),
    fxCorr: corr(uPort, input.fxReturns),
    unhedgedReturn: mean(uPort) * 12,
    hedgedReturn: mean(hPort) * 12,
    medianFxImpact: median(impacts.map((x) => x.impact)),
    worstFxImpact,
    worstFxStart,
    hedgedWorst: hedged.worst,
    hedgedMedian: hedged.median,
    hedgedBest: hedged.best,
  }
}
