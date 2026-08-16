export type AssetClass = 'equity' | 'bond' | 'cash' | 'commodity' | 'reit'
export type Region = 'japan' | 'us' | 'developed' | 'world'
export type Currency = 'JPY' | 'USD'
export type ReturnType = 'price' | 'total'
export type OptimizeMode = 'minimax' | 'minContribution' | 'successRate' | 'median' | 'sharpe'
export type ScoreMode = 'minimax' | 'median' | 'sharpe'
export type Rebalance = 'none' | 'monthly' | 'quarterly' | 'semiannual' | 'annual'
export type Workspace = 'explore' | 'reverse' | 'frontier'
export type TaxAccount = 'tokutei' | 'nisa' | 'custom'
export type EvaluationBasis = 'nominal' | 'real'
export type HedgeMode = 'unhedged' | 'hedged'

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
  fx: {
    USDJPY: Point[]
    hedgeReturnJPY?: Point[]
    hedgeSource?: string
  }
  inflation?: {
    JPY: Point[]
    base: string
    source: string
  }
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
  hedgeCostPaid: number
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
  scoreAll?: boolean
  stepPct: number
  fineSearch: boolean
  mins: number[]
  maxs: number[]
  riskFree: number
  costs: CostModel
  liquidate: boolean
  fxReturns: number[]
  foreign: boolean[]
  hedgeReturns?: number[]
  hedgeMode?: HedgeMode
  evaluationBasis?: EvaluationBasis
  cpiLevels?: number[]
  cpiReference?: number
}

export type OptimizeProgress = {
  phase: 'coarse' | 'fine'
  tested: number
  total: number
  percent: number
  best: Candidate | null
  byMode?: Partial<Record<ScoreMode, Candidate>>
}

export type OptimizeResponse = {
  best: Candidate
  byMode?: Record<ScoreMode, Candidate>
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
  hedgeCostPaid: number
}

export type RiskReturnPoint = {
  weights: number[]
  mu: number
  sigma: number
}

export type FrontierMap = {
  assets: { mu: number; sigma: number }[]
  frontier: RiskReturnPoint[]
  cloud: RiskReturnPoint[]
  minMu: number
  maxMu: number
  minSigma: number
  maxSigma: number
  searched: number
  stepUsed: number
  note: string | null
}

export type FrontierRequest = {
  returns: number[][]
  fxReturns: number[]
  foreign: boolean[]
  hedgeReturns: number[]
  hedgeMode: HedgeMode
  evaluationBasis: EvaluationBasis
  cpiReturns?: number[]
  expenseRatios: number[]
  assetIds: string[]
  stepPct: number
  mins: number[]
  maxs: number[]
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
  unhedgedWorst: number
  unhedgedMedian: number
  unhedgedBest: number
  hedgedWorst: number
  hedgedMedian: number
  hedgedBest: number
  hedgeCostAnnual: number
  hedgeCostPaidMedian: number
}
