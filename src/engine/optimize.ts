import type { AssetClass, Candidate, OptimizeMode, OptimizeProgress, OptimizeRequest, OptimizeResponse } from '../types.ts'
import { clipBounds, countAllocations, forEachAllocation } from './allocations.ts'
import { evaluateWeights } from './simulate.ts'

type ProgressFn = (p: OptimizeProgress) => void
type Req = OptimizeRequest & { assetClasses: AssetClass[] }
type ScoreMode = 'minimax' | 'median' | 'sharpe'

const EXPLORE_MODES: ScoreMode[] = ['minimax', 'median', 'sharpe']

function score(mode: OptimizeMode, c: Candidate): number {
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

function percentOf(tested: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(99, Math.max(0, Math.round((100 * tested) / total)))
}

function evaluateLite(req: Req, weights: number[], computeRequired: boolean): Candidate {
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
    computeRequired,
    fxReturns: req.fxReturns,
    foreign: req.foreign,
    hedgeReturns: req.hedgeReturns,
    hedgeMode: req.hedgeMode,
    evaluationBasis: req.evaluationBasis,
    cpiLevels: req.cpiLevels,
    cpiReturns: req.cpiLevels
      ? req.cpiLevels.slice(1).map((value, i) => {
          const previous = req.cpiLevels?.[i] ?? 0
          return previous > 0 && value > 0 ? value / previous - 1 : 0
        })
      : undefined,
    cpiReference: req.cpiReference,
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
    hedgeReturns: req.hedgeReturns,
    hedgeMode: req.hedgeMode,
    evaluationBasis: req.evaluationBasis,
    cpiLevels: req.cpiLevels,
    cpiReturns: req.cpiLevels
      ? req.cpiLevels.slice(1).map((value, i) => {
          const previous = req.cpiLevels?.[i] ?? 0
          return previous > 0 && value > 0 ? value / previous - 1 : 0
        })
      : undefined,
    cpiReference: req.cpiReference,
  })
}

function insertTop(top: Candidate[], cand: Candidate, mode: OptimizeMode, keep: number): void {
  if (top.length < keep) {
    top.push(cand)
    top.sort((a, b) => score(mode, b) - score(mode, a))
    return
  }
  if (score(mode, cand) > score(mode, top[keep - 1]!)) {
    top[keep - 1] = cand
    top.sort((a, b) => score(mode, b) - score(mode, a))
  }
}

function emptyBoards(modes: OptimizeMode[]): Map<OptimizeMode, Candidate[]> {
  return new Map(modes.map((m) => [m, [] as Candidate[]]))
}

function weightKey(weights: number[]): string {
  return weights.map((w) => Math.round(w * 10_000)).join(',')
}

function uniqueSeeds(groups: Candidate[][]): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const group of groups) {
    for (const cand of group) {
      const key = weightKey(cand.weights)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(cand)
    }
  }
  return out
}

function planFineRegion(
  n: number,
  seed: Candidate,
  reqMins: number[],
  reqMaxs: number[],
): { minPct: number[]; maxPct: number[]; step: number; count: number } {
  const center = seed.weights.map((w) => Math.round(w * 100))
  const minPct = center.map((c, i) => (c === 0 ? 0 : Math.max(reqMins[i]!, c - 10)))
  const maxPct = center.map((c, i) => (c === 0 ? 0 : Math.min(reqMaxs[i]!, c + 10)))
  const b1 = clipBounds(n, 100, minPct, maxPct, 1)
  let step = 1
  let count = countAllocations(n, 100, b1.mins, b1.maxs)
  if (count > 20_000) {
    step = 2
    const b2 = clipBounds(n, 50, minPct, maxPct, 2)
    count = countAllocations(n, 50, b2.mins, b2.maxs)
  }
  return { minPct, maxPct, step, count }
}

function searchGrid(
  req: Req,
  step: number,
  minPct: number[],
  maxPct: number[],
  phase: 'coarse' | 'fine',
  keep: number,
  modes: OptimizeMode[],
  computeRequired: boolean,
  onProgress: ProgressFn,
  testedOffset: number,
  total: number,
): Map<OptimizeMode, Candidate[]> {
  const n = req.assetIds.length
  const units = Math.round(100 / step)
  const { mins, maxs } = clipBounds(n, units, minPct, maxPct, step)
  const boards = emptyBoards(modes)
  let tested = 0
  let lastPost = 0
  forEachAllocation(n, units, mins, maxs, (u) => {
    const cand = evaluateLite(req, toWeights(u, step), computeRequired)
    tested += 1
    for (const mode of modes) insertTop(boards.get(mode)!, cand, mode, keep)
    if (tested % 25 === 0) {
      const now = Date.now()
      if (now - lastPost >= 80) {
        lastPost = now
        const preview = boards.get(modes[0]!)?.[0] ?? null
        onProgress({
          phase,
          tested: testedOffset + tested,
          total,
          percent: percentOf(testedOffset + tested, total),
          best: preview,
          byMode: snapshotByMode(boards),
        })
      }
    }
  })
  onProgress({
    phase,
    tested: testedOffset + tested,
    total,
    percent: percentOf(testedOffset + tested, total),
    best: boards.get(modes[0]!)?.[0] ?? null,
    byMode: snapshotByMode(boards),
  })
  return boards
}

function snapshotByMode(boards: Map<OptimizeMode, Candidate[]>): OptimizeProgress['byMode'] {
  const out: NonNullable<OptimizeProgress['byMode']> = {}
  for (const mode of EXPLORE_MODES) {
    const top = boards.get(mode)?.[0]
    if (top) out[mode] = top
  }
  return Object.keys(out).length ? out : undefined
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

function leadersSnapshot(bestLite: Map<OptimizeMode, Candidate>): OptimizeProgress['byMode'] {
  const out: NonNullable<OptimizeProgress['byMode']> = {}
  for (const mode of EXPLORE_MODES) {
    const top = bestLite.get(mode)
    if (top) out[mode] = top
  }
  return Object.keys(out).length ? out : undefined
}

function mergeBoards(target: Map<OptimizeMode, Candidate[]>, incoming: Map<OptimizeMode, Candidate[]>, keep: number): void {
  for (const [mode, list] of incoming) {
    const dest = target.get(mode)
    if (!dest) continue
    for (const cand of list) insertTop(dest, cand, mode, keep)
  }
}

export function runOptimize(req: Req, onProgress: ProgressFn = () => {}): OptimizeResponse {
  const n = req.assetIds.length
  if (n === 0) throw new Error('no assets')
  const reverse = req.mode === 'minContribution' || req.mode === 'successRate'
  const scoreAll = req.scoreAll && !reverse
  const modes: OptimizeMode[] = scoreAll ? [...EXPLORE_MODES] : [req.mode]
  const { step, count } = pickStep(n, req.stepPct, req.mins, req.maxs, reverse)
  let note: string | null = null
  if (step !== req.stepPct) {
    note = `組み合わせが多いため粗探索を ${step}% 刻みに変更しました（${count.toLocaleString()} 通り）。`
  }

  const computeRequired = req.mode === 'minContribution'
  const estimatedFine = req.fineSearch ? Math.max(200, Math.round(count * 0.2)) : 0
  let grandTotal = count + estimatedFine
  onProgress({
    phase: 'coarse',
    tested: 0,
    total: grandTotal,
    percent: 0,
    best: null,
  })

  const coarse = searchGrid(
    req,
    step,
    req.mins,
    req.maxs,
    'coarse',
    5,
    modes,
    computeRequired,
    onProgress,
    0,
    grandTotal,
  )

  const bestLite = new Map<OptimizeMode, Candidate>()
  for (const mode of modes) {
    const top = coarse.get(mode)?.[0]
    if (!top) throw new Error('no feasible allocation')
    bestLite.set(mode, top)
  }

  let searched = count
  if (req.fineSearch) {
    const seedGroups = scoreAll
      ? EXPLORE_MODES.map((m) => (coarse.get(m) ?? []).slice(0, 2))
      : [(coarse.get(req.mode) ?? []).slice(0, 3)]
    const seeds = uniqueSeeds(seedGroups).slice(0, 4)
    const regions = seeds.map((seed) => planFineRegion(n, seed, req.mins, req.maxs))
    const fineTotal = regions.reduce((s, r) => s + r.count, 0)
    grandTotal = count + fineTotal
    onProgress({
      phase: 'fine',
      tested: count,
      total: grandTotal,
      percent: percentOf(count, grandTotal),
      best: bestLite.get(modes[0]!) ?? null,
      byMode: leadersSnapshot(bestLite),
    })

    const reportFine: ProgressFn = (p) => {
      onProgress({
        ...p,
        best: bestLite.get(modes[0]!) ?? p.best,
        byMode: leadersSnapshot(bestLite) ?? p.byMode,
      })
    }

    let offset = count
    for (const region of regions) {
      const fine = searchGrid(
        req,
        region.step,
        region.minPct,
        region.maxPct,
        'fine',
        3,
        modes,
        computeRequired,
        reportFine,
        offset,
        grandTotal,
      )
      offset += region.count
      searched += region.count
      mergeBoards(coarse, fine, 5)
      for (const mode of modes) {
        const next = coarse.get(mode)?.[0]
        if (next && (!bestLite.get(mode) || score(mode, next) >= score(mode, bestLite.get(mode)!))) {
          bestLite.set(mode, next)
        }
      }
    }
  }

  const displayMonthly = computeRequired ? bestLite.get(req.mode)!.requiredMonthly : req.monthly
  const fullCache = new Map<string, Candidate>()
  const fullOf = (weights: number[], monthly: number): Candidate => {
    const key = `${weightKey(weights)}:${monthly}`
    const hit = fullCache.get(key)
    if (hit) return hit
    const full = evaluateFull(req, weights, monthly, computeRequired)
    fullCache.set(key, full)
    return full
  }

  const best = fullOf(bestLite.get(modes[0]!)!.weights, displayMonthly)
  let byMode: OptimizeResponse['byMode']
  if (scoreAll) {
    byMode = {
      minimax: fullOf(bestLite.get('minimax')!.weights, req.monthly),
      median: fullOf(bestLite.get('median')!.weights, req.monthly),
      sharpe: fullOf(bestLite.get('sharpe')!.weights, req.monthly),
    }
  }

  const comparisons = scoreAll && byMode
    ? [
        { label: 'Worst Case', candidate: byMode.minimax },
        { label: '中央値', candidate: byMode.median },
        { label: 'Sharpe', candidate: byMode.sharpe },
        ...comparisonWeights(req).map(({ label, weights }) => ({
          label,
          candidate: fullOf(weights, req.monthly),
        })),
      ]
    : [
        { label: '最適配分', candidate: best },
        ...comparisonWeights(req).map(({ label, weights }) => ({
          label,
          candidate: fullOf(
            weights,
            computeRequired ? evaluateLite(req, weights, true).requiredMonthly : req.monthly,
          ),
        })),
      ]

  return { best, byMode, comparisons, searched, stepUsed: step, note }
}
