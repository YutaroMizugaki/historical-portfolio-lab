import type { AssetClass, Candidate, OptimizeRequest, OptimizeResponse, OptimizeProgress } from '../types'
import { clipBounds, countAllocations, forEachAllocation } from './allocations'
import { evaluateWeights } from './simulate'

type ProgressFn = (p: OptimizeProgress) => void
type Req = OptimizeRequest & { assetClasses: AssetClass[] }

function score(mode: OptimizeRequest['mode'], c: Candidate): number {
  if (mode === 'minimax') return c.worst
  if (mode === 'minContribution') return -c.requiredMonthly
  if (mode === 'successRate') return c.successRate * 1e12 + c.worst
  if (mode === 'median') return c.median
  return c.sharpe
}

function toWeights(units: Int16Array, stepPct: number): number[] {
  const w = Array.from(units, (u) => (u * stepPct) / 100)
  const s = w.reduce((a, b) => a + b, 0)
  return s > 0 ? w.map((x) => x / s) : w
}

function pickStep(
  n: number,
  requested: number,
  mins: number[],
  maxs: number[],
  reverse: boolean,
): { step: number; count: number } {
  const cap = reverse ? 20_000 : 80_000
  const steps = [requested, 2, 5, 10].filter((s, i, a) => a.indexOf(s) === i).sort((a, b) => a - b)
  let chosen = requested
  let count = Infinity
  for (const step of steps) {
    if (step < requested) continue
    const units = Math.round(100 / step)
    const b = clipBounds(n, units, mins, maxs, step)
    count = countAllocations(n, units, b.mins, b.maxs)
    chosen = step
    if (count <= cap) break
  }
  return { step: chosen, count }
}

function evaluateLite(req: Req, weights: number[]): Candidate {
  return evaluateWeights({
    returns: req.returns,
    dates: req.dates,
    weights,
    periodMonths: req.periodMonths,
    rollStep: req.rollStep,
    rebalEvery: req.rebalanceEvery,
    initial: req.initial,
    monthly: req.monthly,
    target: req.target,
    rfAnnual: req.riskFree,
    costs: req.costs,
    liquidate: req.liquidate,
    withWindows: false,
    computeRequired: req.mode === 'minContribution',
    fxReturns: req.fxReturns,
    foreign: req.foreign,
  })
}

function evaluateFull(req: Req, weights: number[], monthly: number, computeRequired: boolean): Candidate {
  return evaluateWeights({
    returns: req.returns,
    dates: req.dates,
    weights,
    periodMonths: req.periodMonths,
    rollStep: req.rollStep,
    rebalEvery: req.rebalanceEvery,
    initial: req.initial,
    monthly,
    target: req.target,
    rfAnnual: req.riskFree,
    costs: req.costs,
    liquidate: req.liquidate,
    withWindows: true,
    computeRequired,
    fxReturns: req.fxReturns,
    foreign: req.foreign,
  })
}

function searchGrid(
  req: Req,
  step: number,
  minPct: number[],
  maxPct: number[],
  phase: 'coarse' | 'fine',
  keep: number,
  onProgress: ProgressFn,
  testedOffset: number,
  total: number,
): Candidate[] {
  const n = req.assetIds.length
  const units = Math.round(100 / step)
  const { mins, maxs } = clipBounds(n, units, minPct, maxPct, step)
  const top: Candidate[] = []
  let tested = 0
  forEachAllocation(n, units, mins, maxs, (u) => {
    const cand = evaluateLite(req, toWeights(u, step))
    tested += 1
    if (top.length < keep) {
      top.push(cand)
      top.sort((a, b) => score(req.mode, b) - score(req.mode, a))
    } else if (score(req.mode, cand) > score(req.mode, top[keep - 1]!)) {
      top[keep - 1] = cand
      top.sort((a, b) => score(req.mode, b) - score(req.mode, a))
    }
    if (tested % 50 === 0) {
      onProgress({
        phase,
        tested: testedOffset + tested,
        total,
        best: top[0] ?? null,
      })
    }
  })
  onProgress({ phase, tested: testedOffset + tested, total, best: top[0] ?? null })
  return top
}

function comparisonWeights(req: Req): { label: string; weights: number[] }[] {
  const n = req.assetIds.length
  const classes = req.assetClasses
  const rows: { label: string; weights: number[] }[] = []
  const eqIdx = classes.map((c, i) => (c === 'equity' ? i : -1)).filter((i) => i >= 0)
  const bdIdx = classes.map((c, i) => (c === 'bond' ? i : -1)).filter((i) => i >= 0)
  if (eqIdx.length && bdIdx.length) {
    const w = new Array(n).fill(0)
    for (const i of eqIdx) w[i] = 0.6 / eqIdx.length
    for (const i of bdIdx) w[i] = 0.4 / bdIdx.length
    rows.push({ label: '60/40', weights: w })
  } else {
    rows.push({ label: '均等配分', weights: new Array(n).fill(1 / n) })
  }
  const sp = req.assetIds.indexOf('sp500')
  const eq = sp >= 0 ? sp : eqIdx[0] ?? 0
  const w100 = new Array(n).fill(0)
  w100[eq] = 1
  const name = req.assetIds[eq] === 'sp500' ? 'S&P500 100%' : '株式 100%'
  rows.push({ label: name, weights: w100 })
  return rows
}

export function runOptimize(req: Req, onProgress: ProgressFn = () => {}): OptimizeResponse {
  const n = req.assetIds.length
  if (n === 0) throw new Error('no assets')
  const reverse = req.mode === 'minContribution' || req.mode === 'successRate'
  const { step, count } = pickStep(n, req.stepPct, req.mins, req.maxs, reverse)
  let note: string | null = null
  if (step !== req.stepPct) {
    note = `組み合わせが多いため粗探索を ${step}% 刻みに変更しました（${count.toLocaleString()} 通り）。`
  }

  const coarse = searchGrid(req, step, req.mins, req.maxs, 'coarse', 5, onProgress, 0, count)
  let bestLite = coarse[0]
  if (!bestLite) throw new Error('no feasible allocation')

  let searched = count
  if (req.fineSearch) {
    let offset = count
    for (const seed of coarse.slice(0, 3)) {
      const center = seed.weights.map((w) => Math.round(w * 100))
      const minPct = center.map((c, i) => (c === 0 ? 0 : Math.max(req.mins[i]!, c - 10)))
      const maxPct = center.map((c, i) => (c === 0 ? 0 : Math.min(req.maxs[i]!, c + 10)))
      const b1 = clipBounds(n, 100, minPct, maxPct, 1)
      let fineStep = 1
      let fineCount = countAllocations(n, 100, b1.mins, b1.maxs)
      if (fineCount > 20_000) {
        fineStep = 2
        const b2 = clipBounds(n, 50, minPct, maxPct, 2)
        fineCount = countAllocations(n, 50, b2.mins, b2.maxs)
      }
      const fine = searchGrid(req, fineStep, minPct, maxPct, 'fine', 3, onProgress, offset, offset + fineCount)
      offset += fineCount
      searched += fineCount
      if (fine[0] && score(req.mode, fine[0]) >= score(req.mode, bestLite)) bestLite = fine[0]
    }
  }

  const computeRequired = req.mode === 'minContribution'
  const displayMonthly = computeRequired ? bestLite.requiredMonthly : req.monthly
  const best = evaluateFull(req, bestLite.weights, displayMonthly, computeRequired)

  const comparisons = [
    { label: '最適配分', candidate: best },
    ...comparisonWeights(req).map(({ label, weights }) => ({
      label,
      candidate: evaluateFull(
        req,
        weights,
        computeRequired ? evaluateLite(req, weights).requiredMonthly : req.monthly,
        computeRequired,
      ),
    })),
  ]

  return { best, comparisons, searched, stepUsed: step, note }
}
