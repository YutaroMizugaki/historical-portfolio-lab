import type { CostModel, EvaluationBasis, HedgeMode, PathResult, Rebalance, WindowResult } from '../types.ts'

export function rebalanceEveryMonths(r: Rebalance): number {
  if (r === 'monthly') return 1
  if (r === 'quarterly') return 3
  if (r === 'semiannual') return 6
  if (r === 'annual') return 12
  return 0
}

function sum(values: Float64Array): number {
  let s = 0
  for (let i = 0; i < values.length; i += 1) s += values[i]
  return s
}

function buy(values: Float64Array, basis: Float64Array, i: number, pay: number, purchaseCost: number): number {
  if (pay <= 0) return 0
  const fee = pay * purchaseCost
  const invested = pay - fee
  values[i] += invested
  basis[i] += pay
  return fee
}

function rebalanceTaxed(
  values: Float64Array,
  basis: Float64Array,
  weights: Float64Array,
  taxRate: number,
  txnCost: number,
): { tax: number; fees: number } {
  const n = values.length
  let total = 0
  for (let i = 0; i < n; i += 1) total += values[i]
  if (total <= 0) return { tax: 0, fees: 0 }

  let realized = 0
  let cash = 0
  let fees = 0

  for (let i = 0; i < n; i += 1) {
    const target = total * weights[i]
    if (values[i] <= target) continue
    const sellAmt = values[i] - target
    const frac = sellAmt / values[i]
    const soldBasis = basis[i] * frac
    realized += sellAmt - soldBasis
    const fee = sellAmt * txnCost
    fees += fee
    values[i] -= sellAmt
    basis[i] -= soldBasis
    cash += sellAmt - fee
  }

  const tax = realized > 0 ? realized * taxRate : 0
  cash -= tax
  if (cash < 0) cash = 0

  let holdings = 0
  for (let i = 0; i < n; i += 1) holdings += values[i]
  const newTotal = holdings + cash
  for (let i = 0; i < n; i += 1) {
    const target = newTotal * weights[i]
    if (values[i] >= target) continue
    let pay = target - values[i]
    if (pay > cash) pay = cash
    if (pay <= 0) continue
    const fee = pay * txnCost
    fees += fee
    values[i] += pay - fee
    basis[i] += pay
    cash -= pay
  }
  if (cash > 1e-9) {
    let m = 0
    for (let i = 1; i < n; i += 1) if (weights[i] > weights[m]!) m = i
    values[m] += cash
    basis[m] += cash
  }
  return { tax, fees }
}

function growHoldings(
  values: Float64Array,
  returns: number[][],
  t: number,
  costs: CostModel,
  fxReturns: number[] | undefined,
  foreign: boolean[] | undefined,
  hedgeReturns: number[] | undefined,
  hedgeMode: HedgeMode,
): { fxPnl: number; hedgeCost: number } {
  let fxPnl = 0
  let hedgeCost = 0
  for (let i = 0; i < values.length; i += 1) {
    const loc = returns[i]![t]!
    const foreignAsset = Boolean(foreign?.[i])
    const fxR = foreignAsset
      ? hedgeMode === 'hedged'
        ? (hedgeReturns?.[t] ?? 0)
        : (fxReturns?.[t] ?? 0)
      : 0
    const afterLocal = values[i] * (1 + loc)
    const ter = costs.expenseRatios[i] ?? 0
    const afterTer = ter > 0 ? afterLocal * (1 - ter / 12) : afterLocal
    const afterFx = afterTer * (1 + fxR)
    fxPnl += afterFx - afterTer
    if (foreignAsset && hedgeMode === 'hedged' && fxR < 0) hedgeCost += -afterTer * fxR
    values[i] = afterFx
  }
  return { fxPnl, hedgeCost }
}

function liquidate(values: Float64Array, basis: Float64Array, taxRate: number, txnCost: number): {
  afterTax: number
  tax: number
  fees: number
} {
  let market = 0
  let realized = 0
  for (let i = 0; i < values.length; i += 1) {
    market += values[i]
    realized += values[i] - basis[i]
  }
  const fees = market * txnCost
  const tax = realized > 0 ? realized * taxRate : 0
  return { afterTax: Math.max(0, market - tax - fees), tax, fees }
}

export type RunConfig = {
  returns: number[][]
  weights: Float64Array
  t0: number
  horizon: number
  initial: number
  contrib: number
  rebalEvery: number
  costs: CostModel
  liquidateEnd: boolean
  dates?: string[]
  recordPath?: boolean
  values: Float64Array
  basis: Float64Array
  fxReturns?: number[]
  foreign?: boolean[]
  hedgeReturns?: number[]
  hedgeMode?: HedgeMode
  evaluationBasis?: EvaluationBasis
  cpiLevels?: number[]
  cpiReference?: number
}

export function runWindow(cfg: RunConfig): {
  market: number
  afterTax: number
  maxDrawdown: number
  taxPaid: number
  feePaid: number
  fxPnl: number
  hedgeCostPaid: number
  path: PathResult | null
} {
  const { returns, weights, t0, horizon, initial, contrib, rebalEvery, costs, values, basis } = cfg
  const n = weights.length
  values.fill(0)
  basis.fill(0)
  let taxPaid = 0
  let feePaid = 0
  let fxPnl = 0
  let hedgeCostPaid = 0
  const real = cfg.evaluationBasis === 'real'
  const cpiReference = cfg.cpiReference ?? 0
  const inputScale = (index: number) => {
    const cpi = cfg.cpiLevels?.[index] ?? 0
    return real && cpi > 0 && cpiReference > 0 ? cpi / cpiReference : 1
  }
  const outputScale = (index: number) => {
    const cpi = cfg.cpiLevels?.[index] ?? 0
    return real && cpi > 0 && cpiReference > 0 ? cpiReference / cpi : 1
  }
  const initialNominal = initial * inputScale(t0)

  for (let i = 0; i < n; i += 1) {
    feePaid += buy(values, basis, i, initialNominal * weights[i], costs.purchaseCost) * outputScale(t0)
  }

  const outDates: string[] = []
  const portfolio: number[] = []
  const principal: number[] = []
  if (cfg.recordPath && cfg.dates) {
    outDates.push(t0 === 0 ? cfg.dates[0]! : cfg.dates[t0 - 1] ?? cfg.dates[0]!)
    portfolio.push(sum(values) * outputScale(t0))
    principal.push(initial)
  }

  let peak = sum(values) * outputScale(t0)
  let maxDrawdown = 0
  let paid = initial

  for (let t = 0; t < horizon; t += 1) {
    const valueIndex = t0 + t + 1
    const growth = growHoldings(
      values,
      returns,
      t0 + t,
      costs,
      cfg.fxReturns,
      cfg.foreign,
      cfg.hedgeReturns,
      cfg.hedgeMode ?? 'unhedged',
    )
    fxPnl += growth.fxPnl * outputScale(valueIndex)
    hedgeCostPaid += growth.hedgeCost * outputScale(valueIndex)
    if (contrib > 0) {
      const contributionNominal = contrib * inputScale(valueIndex)
      for (let i = 0; i < n; i += 1) {
        feePaid +=
          buy(values, basis, i, contributionNominal * weights[i], costs.purchaseCost) * outputScale(valueIndex)
      }
      paid += contrib
    }
    if (rebalEvery > 0 && (t + 1) % rebalEvery === 0) {
      const r = rebalanceTaxed(values, basis, weights, costs.taxRate, costs.txnCost)
      taxPaid += r.tax * outputScale(valueIndex)
      feePaid += r.fees * outputScale(valueIndex)
    }
    const total = sum(values) * outputScale(valueIndex)
    if (total > peak) peak = total
    if (peak > 0) {
      const dd = total / peak - 1
      if (dd < maxDrawdown) maxDrawdown = dd
    }
    if (cfg.recordPath && cfg.dates) {
      outDates.push(cfg.dates[t0 + t]!)
      portfolio.push(total)
      principal.push(paid)
    }
  }

  const endIndex = t0 + horizon
  const marketNominal = sum(values)
  const market = marketNominal * outputScale(endIndex)
  let afterTax = market
  if (cfg.liquidateEnd) {
    const end = liquidate(values, basis, costs.taxRate, costs.txnCost)
    afterTax = end.afterTax * outputScale(endIndex)
    taxPaid += end.tax * outputScale(endIndex)
    feePaid += end.fees * outputScale(endIndex)
  }

  const path: PathResult | null = cfg.recordPath
    ? { dates: outDates, portfolio, principal, maxDrawdown, market, afterTax, taxPaid, feePaid, fxPnl, hedgeCostPaid }
    : null
  return { market, afterTax, maxDrawdown, taxPaid, feePaid, fxPnl, hedgeCostPaid, path }
}

function reportedFinal(market: number, afterTax: number, liquidateEnd: boolean): number {
  return liquidateEnd ? afterTax : market
}

export function windowSucceeds(
  returns: number[][],
  weights: Float64Array,
  t0: number,
  horizon: number,
  initial: number,
  contrib: number,
  rebalEvery: number,
  costs: CostModel,
  liquidateEnd: boolean,
  target: number,
  values: Float64Array,
  basis: Float64Array,
  fxReturns?: number[],
  foreign?: boolean[],
  hedgeReturns?: number[],
  hedgeMode: HedgeMode = 'unhedged',
  evaluationBasis: EvaluationBasis = 'nominal',
  cpiLevels?: number[],
  cpiReference?: number,
): boolean {
  const r = runWindow({
    returns,
    weights,
    t0,
    horizon,
    initial,
    contrib,
    rebalEvery,
    costs,
    liquidateEnd,
    values,
    basis,
    fxReturns,
    foreign,
    hedgeReturns,
    hedgeMode,
    evaluationBasis,
    cpiLevels,
    cpiReference,
  })
  return reportedFinal(r.market, r.afterTax, liquidateEnd) + 1e-6 >= target
}

export function minMonthlyContribution(
  returns: number[][],
  weightsArr: number[],
  periodMonths: number,
  rollStep: number,
  rebalEvery: number,
  initial: number,
  target: number,
  costs: CostModel,
  liquidateEnd: boolean,
  fxReturns?: number[],
  foreign?: boolean[],
  hedgeReturns?: number[],
  hedgeMode: HedgeMode = 'unhedged',
  evaluationBasis: EvaluationBasis = 'nominal',
  cpiLevels?: number[],
  cpiReference?: number,
): number {
  const n = weightsArr.length
  const weights = Float64Array.from(weightsArr)
  const values = new Float64Array(n)
  const basis = new Float64Array(n)
  const tLen = returns[0]?.length ?? 0

  const allHit = (contrib: number) => {
    for (let t0 = 0; t0 + periodMonths <= tLen; t0 += rollStep) {
      if (
        !windowSucceeds(
          returns,
          weights,
          t0,
          periodMonths,
          initial,
          contrib,
          rebalEvery,
          costs,
          liquidateEnd,
          target,
          values,
          basis,
          fxReturns,
          foreign,
          hedgeReturns,
          hedgeMode,
          evaluationBasis,
          cpiLevels,
          cpiReference,
        )
      ) {
        return false
      }
    }
    return true
  }

  if (target <= 0 || allHit(0)) return 0

  let hi = Math.max(1, Math.ceil(((Math.max(target - initial, 0) * (1 + costs.taxRate)) / periodMonths) * 1.5))
  let guard = 0
  while (!allHit(hi) && guard < 24) {
    hi *= 2
    guard += 1
  }
  if (!allHit(hi)) return Number.POSITIVE_INFINITY

  let lo = 0
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (allHit(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

export function simulatePath(
  returns: number[][],
  dates: string[],
  t0: number,
  horizon: number,
  weightsArr: number[],
  initial: number,
  contrib: number,
  rebalEvery: number,
  costs: CostModel,
  liquidateEnd: boolean,
  fxReturns?: number[],
  foreign?: boolean[],
  hedgeReturns?: number[],
  hedgeMode: HedgeMode = 'unhedged',
  evaluationBasis: EvaluationBasis = 'nominal',
  cpiLevels?: number[],
  cpiReference?: number,
): PathResult {
  const n = weightsArr.length
  const r = runWindow({
    returns,
    weights: Float64Array.from(weightsArr),
    t0,
    horizon,
    initial,
    contrib,
    rebalEvery,
    costs,
    liquidateEnd,
    dates,
    recordPath: true,
    values: new Float64Array(n),
    basis: new Float64Array(n),
    fxReturns,
    foreign,
    hedgeReturns,
    hedgeMode,
    evaluationBasis,
    cpiLevels,
    cpiReference,
  })
  return r.path!
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export function sharpeOfWeights(
  returns: number[][],
  weights: Float64Array,
  rebalEvery: number,
  rfAnnual: number,
  costs: CostModel,
  fxReturns?: number[],
  foreign?: boolean[],
  hedgeReturns?: number[],
  hedgeMode: HedgeMode = 'unhedged',
  cpiReturns?: number[],
  evaluationBasis: EvaluationBasis = 'nominal',
): number {
  const n = weights.length
  const tLen = returns[0]?.length ?? 0
  if (tLen < 2) return 0
  const values = new Float64Array(n)
  const basis = new Float64Array(n)
  for (let i = 0; i < n; i += 1) buy(values, basis, i, weights[i], costs.purchaseCost)
  const rf = (1 + rfAnnual) ** (1 / 12) - 1
  const excess = new Float64Array(tLen)
  let prev = sum(values)
  for (let t = 0; t < tLen; t += 1) {
    growHoldings(values, returns, t, costs, fxReturns, foreign, hedgeReturns, hedgeMode)
    if (rebalEvery > 0 && (t + 1) % rebalEvery === 0) {
      rebalanceTaxed(values, basis, weights, costs.taxRate, costs.txnCost)
    }
    const total = sum(values)
    let r = prev <= 0 ? 0 : total / prev - 1
    if (evaluationBasis === 'real') r = (1 + r) / (1 + (cpiReturns?.[t] ?? 0)) - 1
    excess[t] = r - rf
    prev = total
  }
  let mean = 0
  for (let t = 0; t < tLen; t += 1) mean += excess[t]
  mean /= tLen
  let varr = 0
  for (let t = 0; t < tLen; t += 1) {
    const x = excess[t] - mean
    varr += x * x
  }
  varr /= Math.max(1, tLen - 1)
  const sd = Math.sqrt(varr)
  if (sd < 1e-14) return mean > 0 ? 99 : mean < 0 ? -99 : 0
  return (mean * 12) / (sd * Math.sqrt(12))
}

export type EvaluateInput = {
  returns: number[][]
  dates: string[]
  weights: number[]
  periodMonths: number
  rollStep: number
  rebalEvery: number
  initial: number
  monthly: number
  target: number
  rfAnnual: number
  costs: CostModel
  liquidate: boolean
  withWindows: boolean
  computeRequired: boolean
  fxReturns?: number[]
  foreign?: boolean[]
  hedgeReturns?: number[]
  hedgeMode?: HedgeMode
  evaluationBasis?: EvaluationBasis
  cpiLevels?: number[]
  cpiReturns?: number[]
  cpiReference?: number
}

export function evaluateWeights(input: EvaluateInput): {
  weights: number[]
  worst: number
  median: number
  best: number
  successRate: number
  requiredMonthly: number
  sharpe: number
  worstStart: string
  bestStart: string
  windows: WindowResult[]
} {
  const n = input.weights.length
  const weights = Float64Array.from(input.weights)
  const tLen = input.returns[0]?.length ?? 0
  const values = new Float64Array(n)
  const basis = new Float64Array(n)
  const requiredMonthly = input.computeRequired
    ? minMonthlyContribution(
        input.returns,
        input.weights,
        input.periodMonths,
        input.rollStep,
        input.rebalEvery,
        input.initial,
        input.target,
        input.costs,
        input.liquidate,
        input.fxReturns,
        input.foreign,
        input.hedgeReturns,
        input.hedgeMode,
        input.evaluationBasis,
        input.cpiLevels,
        input.cpiReference,
      )
    : 0
  const contrib = input.computeRequired ? requiredMonthly : input.monthly
  const hasFx = Boolean(input.foreign?.some(Boolean) && input.fxReturns?.length)

  const finals: number[] = []
  const windows: WindowResult[] = []
  let worst = Infinity
  let best = -Infinity
  let worstStart = input.dates[0] ?? ''
  let bestStart = input.dates[0] ?? ''
  let hits = 0

  for (let t0 = 0; t0 + input.periodMonths <= tLen; t0 += input.rollStep) {
    const r = runWindow({
      returns: input.returns,
      weights,
      t0,
      horizon: input.periodMonths,
      initial: input.initial,
      contrib: Number.isFinite(contrib) ? contrib : 0,
      rebalEvery: input.rebalEvery,
      costs: input.costs,
      liquidateEnd: input.liquidate,
      values,
      basis,
      fxReturns: input.fxReturns,
      foreign: input.foreign,
      hedgeReturns: input.hedgeReturns,
      hedgeMode: input.hedgeMode,
      evaluationBasis: input.evaluationBasis,
      cpiLevels: input.cpiLevels,
      cpiReference: input.cpiReference,
    })
    const final = reportedFinal(r.market, r.afterTax, input.liquidate)
    finals.push(final)
    const start = input.dates[t0] ?? ''
    if (final < worst) {
      worst = final
      worstStart = start
    }
    if (final > best) {
      best = final
      bestStart = start
    }
    const success = input.target > 0 && final + 1e-6 >= input.target
    if (success) hits += 1
    if (input.withWindows) {
      let fxImpact = 0
      if (hasFx) {
        const oppositeMode: HedgeMode = input.hedgeMode === 'hedged' ? 'unhedged' : 'hedged'
        const opposite = runWindow({
          returns: input.returns,
          weights,
          t0,
          horizon: input.periodMonths,
          initial: input.initial,
          contrib: Number.isFinite(contrib) ? contrib : 0,
          rebalEvery: input.rebalEvery,
          costs: input.costs,
          liquidateEnd: input.liquidate,
          values,
          basis,
          fxReturns: input.fxReturns,
          foreign: input.foreign,
          hedgeReturns: input.hedgeReturns,
          hedgeMode: oppositeMode,
          evaluationBasis: input.evaluationBasis,
          cpiLevels: input.cpiLevels,
          cpiReference: input.cpiReference,
        })
        const oppositeFinal = reportedFinal(opposite.market, opposite.afterTax, input.liquidate)
        fxImpact = input.hedgeMode === 'hedged' ? oppositeFinal - final : final - oppositeFinal
      }
      windows.push({
        start,
        end: input.dates[t0 + input.periodMonths - 1] ?? start,
        final,
        market: r.market,
        afterTax: r.afterTax,
        requiredMonthly,
        success,
        maxDrawdown: r.maxDrawdown,
        taxPaid: r.taxPaid,
        feePaid: r.feePaid,
        fxImpact,
        hedgeCostPaid: r.hedgeCostPaid,
      })
    }
  }

  return {
    weights: input.weights,
    worst: Number.isFinite(worst) ? worst : 0,
    median: median(finals),
    best: Number.isFinite(best) ? best : 0,
    successRate: finals.length && input.target > 0 ? hits / finals.length : 0,
    requiredMonthly,
    sharpe: sharpeOfWeights(
      input.returns,
      weights,
      input.rebalEvery,
      input.rfAnnual,
      input.costs,
      input.fxReturns,
      input.foreign,
      input.hedgeReturns,
      input.hedgeMode,
      input.cpiReturns,
      input.evaluationBasis,
    ),
    worstStart,
    bestStart,
    windows,
  }
}
