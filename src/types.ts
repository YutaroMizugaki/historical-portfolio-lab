export type AssetClass = 'equity' | 'bond' | 'cash' | 'commodity' | 'reit'
export type Region = 'japan' | 'us' | 'developed' | 'world'
export type Currency = 'JPY' | 'USD'
export type ReturnType = 'price' | 'total'
export type OptimizeMode = 'minimax' | 'minContribution' | 'successRate' | 'median' | 'sharpe'
export type Rebalance = 'none' | 'monthly' | 'quarterly' | 'semiannual' | 'annual'
export type Workspace = 'explore' | 'reverse'
export type TaxAccount = 'tokutei' | 'nisa' | 'custom'

export type Point = readonly [date: string, value: number]

export type Asset = {
  id: string
  symbol: string
  name: string
  assetClass: AssetClass
  region: Region
  currency: Currency
  returnType: ReturnType
  source: string
  points: Point[]
}

export type SeriesFile = {
  meta: { fetchedAt: string; notes: string[] }
  fx: { USDJPY: Point[] }
  assets: Asset[]
}

export type CostModel = {
  expenseRatios: number[]
  taxRate: number
  txnCost: number
  purchaseCost: number
}

export type WindowResult = {
  start: string
  end: string
  final: number
  market: number
  afterTax: number
  requiredMonthly: number
  success: boolean
  maxDrawdown: number
  taxPaid: number
  feePaid: number
  fxImpact: number
}

export type Candidate = {
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
}

export type OptimizeRequest = {
  returns: number[][]
  dates: string[]
  assetIds: string[]
  periodMonths: number
  rollStep: number
  rebalanceEvery: number
  initial: number
  monthly: number
  target: number
  mode: OptimizeMode
  stepPct: number
  fineSearch: boolean
  mins: number[]
  maxs: number[]
  riskFree: number
  costs: CostModel
  liquidate: boolean
  fxReturns: number[]
  foreign: boolean[]
}

export type OptimizeProgress = {
  phase: 'coarse' | 'fine'
  tested: number
  total: number
  best: Candidate | null
}

export type OptimizeResponse = {
  best: Candidate
  comparisons: { label: string; candidate: Candidate }[]
  searched: number
  stepUsed: number
  note: string | null
}

export type PathResult = {
  dates: string[]
  portfolio: number[]
  principal: number[]
  maxDrawdown: number
  market: number
  afterTax: number
  taxPaid: number
  feePaid: number
  fxPnl: number
}

export type FxReport = {
  foreignWeight: number
  fxVol: number
  unhedgedVol: number
  hedgedVol: number
  fxCorr: number
  unhedgedReturn: number
  hedgedReturn: number
  medianFxImpact: number
  worstFxImpact: number
  worstFxStart: string
  hedgedWorst: number
  hedgedMedian: number
  hedgedBest: number
}
