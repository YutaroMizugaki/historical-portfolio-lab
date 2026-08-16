import { series, alignSelected } from '../src/data/load.ts'
import { evaluateWeights } from '../src/engine/simulate.ts'
import { countAllocations, clipBounds } from '../src/engine/allocations.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const zeroCost = { expenseRatios: [0], taxRate: 0, txnCost: 0, purchaseCost: 0 }

const cash = series.assets.find((a) => a.id === 'jpy_cash')
assert(cash, 'cash asset')
const aligned = alignSelected([cash!], 'JPY')
assert(aligned.dates.length > 120, `cash dates ${aligned.dates.length}`)

const w = evaluateWeights({
  returns: aligned.returns,
  dates: aligned.dates,
  weights: [1],
  periodMonths: 120,
  rollStep: 12,
  rebalEvery: 12,
  initial: 0,
  monthly: 0,
  target: 10_000_000,
  rfAnnual: 0,
  costs: zeroCost,
  liquidate: true,
  withWindows: true,
  computeRequired: true,
})
assert(Math.abs(w.requiredMonthly - Math.ceil(10_000_000 / 120)) <= 1, `required ${w.requiredMonthly}`)
assert(w.windows.length > 0, 'windows')

const w2 = evaluateWeights({
  ...{
    returns: aligned.returns,
    dates: aligned.dates,
    weights: [1],
    periodMonths: 120,
    rollStep: 12,
    rebalEvery: 12,
    initial: 0,
    monthly: w.requiredMonthly,
    target: 10_000_000,
    rfAnnual: 0,
    costs: zeroCost,
    liquidate: true,
    withWindows: true,
    computeRequired: false,
  },
})
assert(w2.successRate === 1, `cash success ${w2.successRate}`)
assert(w2.worst >= 10_000_000, `cash worst ${w2.worst}`)

const taxed = evaluateWeights({
  returns: aligned.returns,
  dates: aligned.dates,
  weights: [1],
  periodMonths: 120,
  rollStep: 12,
  rebalEvery: 12,
  initial: 0,
  monthly: 0,
  target: 10_000_000,
  rfAnnual: 0,
  costs: { expenseRatios: [0], taxRate: 0.20315, txnCost: 0, purchaseCost: 0 },
  liquidate: true,
  withWindows: false,
  computeRequired: true,
})
assert(taxed.requiredMonthly === w.requiredMonthly, `cash tax should not change required, ${taxed.requiredMonthly}`)

const n = 3
const { mins, maxs } = clipBounds(n, 20, [0, 0, 0], [100, 100, 100], 5)
const c = countAllocations(n, 20, mins, maxs)
assert(c === 231, `3-asset 5% count ${c}`)

const usreit = series.assets.find((a) => a.id === 'usreit')
assert(usreit?.assetClass === 'reit', 'usreit asset class')
assert((usreit?.points.length ?? 0) > 200, `usreit points ${usreit?.points.length}`)

for (const id of ['em', 'ussmall', 'nasdaq', 'oil', 'jpy_st'] as const) {
  const a = series.assets.find((x) => x.id === id)
  assert(a, `missing asset ${id}`)
  assert((a?.points.length ?? 0) > 24, `${id} points ${a?.points.length}`)
}

const mix = alignSelected(
  series.assets.filter((a) => a.id === 'sp500' || a.id === 'devbond'),
  'JPY',
)
assert(mix.returns.length === 2, '2 series')
assert(mix.foreign.length === 2, 'foreign flags')
assert(mix.fxReturns.length === mix.dates.length, 'fx returns aligned')
assert(mix.fxReturns.some((r) => r !== 0), 'fx moves')

const noFee = evaluateWeights({
  returns: mix.returns,
  dates: mix.dates,
  weights: [0.6, 0.4],
  periodMonths: 120,
  rollStep: 12,
  rebalEvery: 12,
  initial: 0,
  monthly: 50_000,
  target: 0,
  rfAnnual: 0,
  costs: { expenseRatios: [0, 0], taxRate: 0, txnCost: 0, purchaseCost: 0 },
  liquidate: true,
  withWindows: false,
  computeRequired: false,
})
const withFee = evaluateWeights({
  returns: mix.returns,
  dates: mix.dates,
  weights: [0.6, 0.4],
  periodMonths: 120,
  rollStep: 12,
  rebalEvery: 12,
  initial: 0,
  monthly: 50_000,
  target: 0,
  rfAnnual: 0,
  costs: { expenseRatios: [0.0009375, 0.00154], taxRate: 0.20315, txnCost: 0.0005, purchaseCost: 0 },
  liquidate: true,
  withWindows: false,
  computeRequired: false,
})
assert(withFee.median < noFee.median, `costs should reduce median ${withFee.median} vs ${noFee.median}`)

const mixFx = evaluateWeights({
  returns: mix.localReturns,
  dates: mix.dates,
  weights: [0.6, 0.4],
  periodMonths: 120,
  rollStep: 12,
  rebalEvery: 12,
  initial: 0,
  monthly: 50_000,
  target: 0,
  rfAnnual: 0,
  costs: { expenseRatios: [0, 0], taxRate: 0, txnCost: 0, purchaseCost: 0 },
  liquidate: true,
  withWindows: true,
  computeRequired: false,
  fxReturns: mix.fxReturns,
  foreign: mix.foreign,
})
const mixNoFx = evaluateWeights({
  returns: mix.localReturns,
  dates: mix.dates,
  weights: [0.6, 0.4],
  periodMonths: 120,
  rollStep: 12,
  rebalEvery: 12,
  initial: 0,
  monthly: 50_000,
  target: 0,
  rfAnnual: 0,
  costs: { expenseRatios: [0, 0], taxRate: 0, txnCost: 0, purchaseCost: 0 },
  liquidate: true,
  withWindows: true,
  computeRequired: false,
})
assert(mixFx.median !== mixNoFx.median, 'FX should move median')
assert(Math.abs(mixFx.median - noFee.median) / noFee.median < 0.002, `explicit FX vs pre-converted ${mixFx.median} vs ${noFee.median}`)
assert(mixFx.windows.some((w) => w.fxImpact !== 0), 'window fx impact')

console.log('smoke ok', {
  cashRequired: w.requiredMonthly,
  windows: w.windows.length,
  mixStart: mix.start,
  mixEnd: mix.end,
  mixN: mix.dates.length,
  medianNoFee: Math.round(noFee.median),
  medianWithCosts: Math.round(withFee.median),
})
