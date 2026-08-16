import type { CostModel, EvaluationBasis, FxReport } from '../types.ts'
import { evaluateWeights, median } from './simulate.ts'

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

function weightedHedgedMonths(
  returns: number[][],
  weights: number[],
  foreign: boolean[],
  hedgeReturns: number[],
): number[] {
  const tLen = returns[0]?.length ?? 0
  const out = new Array<number>(tLen)
  for (let t = 0; t < tLen; t += 1) {
    let total = 0
    for (let i = 0; i < weights.length; i += 1) {
      const local = returns[i]?.[t] ?? 0
      const hedge = foreign[i] ? (hedgeReturns[t] ?? 0) : 0
      total += (weights[i] ?? 0) * ((1 + local) * (1 + hedge) - 1)
    }
    out[t] = total
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
  hedgeReturns: number[]
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
  evaluationBasis?: EvaluationBasis
  cpiLevels?: number[]
  cpiReference?: number
}): FxReport | null {
  const foreignWeight = input.weights.reduce((s, w, i) => s + (input.foreign[i] ? w : 0), 0)
  if (foreignWeight < 0.005) return null

  const uPort = weightedMonths(input.unhedgedReturns, input.weights)
  const hPort = weightedHedgedMonths(input.hedgedReturns, input.weights, input.foreign, input.hedgeReturns)
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
    foreign: input.foreign,
    hedgeReturns: input.hedgeReturns,
    hedgeMode: 'hedged',
    evaluationBasis: input.evaluationBasis,
    cpiLevels: input.cpiLevels,
    cpiReference: input.cpiReference,
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
    hedgeReturns: input.hedgeReturns,
    hedgeMode: 'unhedged',
    evaluationBasis: input.evaluationBasis,
    cpiLevels: input.cpiLevels,
    cpiReference: input.cpiReference,
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
    unhedgedWorst: unhedged.worst,
    unhedgedMedian: unhedged.median,
    unhedgedBest: unhedged.best,
    hedgedWorst: hedged.worst,
    hedgedMedian: hedged.median,
    hedgedBest: hedged.best,
    hedgeCostAnnual: Math.max(0, -mean(input.hedgeReturns) * 12),
    hedgeCostPaidMedian: median(hedged.windows.map((w) => w.hedgeCostPaid)),
  }
}
