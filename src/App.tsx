import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Amount } from './Amount'
import { AllocationDonut, CompareTable, FrontierChart, Histogram, OutcomeRange, RollingBars, WealthChart } from './charts'
import { defaultTer, TOKUTEI_TAX } from './data/costs'
import { exposureOf } from './data/exposure'
import { series, alignSelected } from './data/load'
import { countAllocations, clipBounds } from './engine/allocations'
import { pickByRisk } from './engine/frontier'
import { analyzeFx } from './engine/fx'
import { rebalanceEveryMonths, simulatePath, evaluateWeights } from './engine/simulate'
import { amountPrimary, pct, signedAmount, yearLabel, ymLabel } from './format'
import { allocColor, CORE_COLORS } from './palette'
import type {
  Asset,
  AssetClass,
  Candidate,
  CostModel,
  Currency,
  EvaluationBasis,
  FrontierMap,
  HedgeMode,
  OptimizeMode,
  OptimizeProgress,
  OptimizeResponse,
  Rebalance,
  ScoreMode,
  TaxAccount,
  Workspace,
} from './types'

const PERIODS = [5, 10, 15, 20, 30] as const
const EXPLORE_MODES: { id: ScoreMode; label: string; hint: string }[] = [
  { id: 'minimax', label: 'Worst Case', hint: '最悪期間の税引後手取りを最大化' },
  { id: 'median', label: '中央値', hint: '税引後手取りの中央値を最大化' },
  { id: 'sharpe', label: 'Sharpe', hint: '信託報酬・リバランス税込みの月次リターンで計算' },
]
const SCORE_LABEL: Record<ScoreMode, string> = {
  minimax: 'Worst Case',
  median: '中央値',
  sharpe: 'Sharpe',
}
const REVERSE_MODES: { id: OptimizeMode; label: string; hint: string }[] = [
  { id: 'minContribution', label: '必要積立を最小化', hint: 'どの開始年でも目標の税引後手取りに届く月額' },
  { id: 'successRate', label: '到達率を最大化', hint: '投資条件の積立額で、目標に届いた期間の割合' },
]

function referenceMixes(ids: string[], classes: AssetClass[]): { label: string; weights: number[] }[] {
  const n = ids.length
  if (n === 0) return []
  const eqIdx = classes.map((c, i) => (c === 'equity' ? i : -1)).filter((i) => i >= 0)
  const bdIdx = classes.map((c, i) => (c === 'bond' ? i : -1)).filter((i) => i >= 0)
  const rows: { label: string; weights: number[] }[] = []
  if (eqIdx.length && bdIdx.length) {
    const w = new Array(n).fill(0)
    for (const i of eqIdx) w[i] = 0.6 / eqIdx.length
    for (const i of bdIdx) w[i] = 0.4 / bdIdx.length
    rows.push({ label: '60/40', weights: w })
  } else {
    rows.push({ label: '均等配分', weights: new Array(n).fill(1 / n) })
  }
  const sp = ids.indexOf('sp500')
  const eq = sp >= 0 ? sp : (eqIdx[0] ?? 0)
  const w100 = new Array(n).fill(0)
  w100[eq] = 1
  rows.push({ label: ids[eq] === 'sp500' ? 'S&P500 100%' : '株式 100%', weights: w100 })
  return rows
}

const DEFAULT_IDS = ['developed', 'em', 'jgb', 'ust', 'jpy_st', 'gold']
const CLASS_ORDER: AssetClass[] = ['equity', 'bond', 'reit', 'commodity', 'cash']
const CLASS_LABEL: Record<AssetClass, string> = {
  equity: '株式',
  bond: '債券',
  reit: 'REIT',
  commodity: 'コモディティ',
  cash: '現金',
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-stone-500">{label}</span>
      {children}
    </label>
  )
}

const inputClass =
  'w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-emerald-800'

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>('reverse')
  const [selected, setSelected] = useState<string[]>(DEFAULT_IDS)
  const [initial, setInitial] = useState(0)
  const [monthly, setMonthly] = useState(50_000)
  const [target, setTarget] = useState(10_000_000)
  const [years, setYears] = useState(10)
  const [customYears, setCustomYears] = useState('')
  const [currency, setCurrency] = useState<Currency>('JPY')
  const [evaluationBasis, setEvaluationBasis] = useState<EvaluationBasis>('nominal')
  const [hedgeMode, setHedgeMode] = useState<HedgeMode>('unhedged')
  const [rebalance, setRebalance] = useState<Rebalance>('annual')
  const [exploreMode, setExploreMode] = useState<ScoreMode>('minimax')
  const [reverseMode, setReverseMode] = useState<OptimizeMode>('minContribution')
  const [stepPct, setStepPct] = useState(5)
  const [fineSearch, setFineSearch] = useState(true)
  const [riskFree, setRiskFree] = useState(0)
  const [bounds, setBounds] = useState<Record<string, { min: number; max: number }>>({})
  const [taxAccount, setTaxAccount] = useState<TaxAccount>('tokutei')
  const [customTax, setCustomTax] = useState(20.315)
  const [txnCostPct, setTxnCostPct] = useState(0.05)
  const [purchaseCostPct, setPurchaseCostPct] = useState(0)
  const [terOverrides, setTerOverrides] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<OptimizeProgress | null>(null)
  const [result, setResult] = useState<OptimizeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [frontierMap, setFrontierMap] = useState<FrontierMap | null>(null)
  const [targetSigma, setTargetSigma] = useState(0)
  const workerRef = useRef<Worker | null>(null)
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const assets = series.assets
  const chosen = useMemo(
    () => selected.map((id) => assets.find((a) => a.id === id)).filter((a): a is Asset => !!a),
    [assets, selected],
  )

  const taxRate = taxAccount === 'nisa' ? 0 : taxAccount === 'tokutei' ? TOKUTEI_TAX : customTax / 100
  const costs: CostModel = useMemo(
    () => ({
      expenseRatios: chosen.map((a) => terOverrides[a.id] ?? defaultTer(a.id)),
      taxRate,
      txnCost: txnCostPct / 100,
      purchaseCost: purchaseCostPct / 100,
    }),
    [chosen, terOverrides, taxRate, txnCostPct, purchaseCostPct],
  )

  const effectiveBasis: EvaluationBasis = currency === 'JPY' ? evaluationBasis : 'nominal'
  const aligned = useMemo(
    () =>
      alignSelected(chosen, currency, {
        requireCpi: effectiveBasis === 'real',
        requireHedge: true,
      }),
    [chosen, currency, effectiveBasis],
  )
  const periodYears = customYears ? Number(customYears) || years : years
  const periodMonths = Math.round(periodYears * 12)
  const windowCount =
    aligned.dates.length >= periodMonths
      ? Math.floor((aligned.dates.length - periodMonths) / 12) + 1
      : 0

  const comboCount = useMemo(() => {
    const n = chosen.length
    if (n === 0) return 0
    const units = Math.round(100 / stepPct)
    const mins = chosen.map((a) => bounds[a.id]?.min ?? 0)
    const maxs = chosen.map((a) => bounds[a.id]?.max ?? 100)
    const b = clipBounds(n, units, mins, maxs, stepPct)
    return countAllocations(n, units, b.mins, b.maxs)
  }, [chosen, stepPct, bounds])

  const mode = workspace === 'explore' ? exploreMode : reverseMode
  const reverse = workspace === 'reverse'
  const frontier = workspace === 'frontier'

  const toggle = (id: string) => {
    setResult(null)
    setPicked(null)
    setFrontierMap(null)
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  const applyFrontierPick = (map: FrontierMap, sigma: number, withComparisons = false) => {
    const point = pickByRisk(map.frontier, sigma)
    if (!point || aligned.dates.length < periodMonths + 1) return
    const evalInput = {
      returns: aligned.localReturns,
      dates: aligned.dates,
      weights: point.weights,
      periodMonths,
      rollStep: 12,
      rebalEvery: rebalanceEveryMonths(rebalance),
      initial,
      monthly,
      target: 0,
      rfAnnual: riskFree / 100,
      costs,
      liquidate: true,
      withWindows: true,
      computeRequired: false,
      fxReturns: aligned.fxReturns,
      foreign: aligned.foreign,
      hedgeReturns: aligned.hedgeReturns,
      hedgeMode,
      evaluationBasis: effectiveBasis,
      cpiLevels: effectiveBasis === 'real' ? aligned.cpiLevels : undefined,
      cpiReturns: effectiveBasis === 'real' ? aligned.cpiReturns : undefined,
      cpiReference: effectiveBasis === 'real' ? (aligned.cpiReference ?? undefined) : undefined,
    }
    const scored = evaluateWeights(evalInput)
    setResult({
      best: scored,
      comparisons: withComparisons
        ? [
            { label: '選択配分', candidate: scored },
            ...referenceMixes(
              chosen.map((a) => a.id),
              chosen.map((a) => a.assetClass),
            ).map(({ label, weights }) => ({
              label,
              candidate: evaluateWeights({ ...evalInput, weights }),
            })),
          ]
        : [{ label: '選択配分', candidate: scored }],
      searched: map.searched,
      stepUsed: map.stepUsed,
      note: map.note,
    })
    const worstI = scored.windows.findIndex((w) => w.start === scored.worstStart)
    setPicked(worstI >= 0 ? worstI : 0)
  }

  const scheduleFrontierPick = (map: FrontierMap, sigma: number) => {
    if (pickTimer.current) clearTimeout(pickTimer.current)
    pickTimer.current = setTimeout(() => applyFrontierPick(map, sigma, true), 120)
  }

  const selectedPoint = frontierMap ? pickByRisk(frontierMap.frontier, targetSigma) : null

  const run = () => {
    if (chosen.length === 0 || aligned.dates.length < periodMonths + 1) return
    if (reverse && target <= 0) {
      setError('目標金額を入力してください')
      return
    }
    workerRef.current?.terminate()
    setBusy(true)
    setError(null)
    setResult(null)
    setPicked(null)
    if (frontier) {
      setFrontierMap(null)
      setProgress({ phase: 'coarse', tested: 0, total: comboCount, percent: 0, best: null })
      const worker = new Worker(new URL('./workers/frontier.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = worker
      worker.onmessage = (event: MessageEvent<{ type: string; result?: FrontierMap; message?: string }>) => {
        if (event.data.type === 'error') {
          setError(event.data.message ?? 'フロンティアの作成に失敗しました')
          setBusy(false)
          worker.terminate()
          return
        }
        if (event.data.type === 'done' && event.data.result) {
          const next = event.data.result
          const mid = next.frontier[Math.floor((next.frontier.length - 1) / 2)] ?? next.frontier[0]
          setFrontierMap(next)
          if (mid) {
            setTargetSigma(mid.sigma)
            applyFrontierPick(next, mid.sigma, true)
          }
          setBusy(false)
          worker.terminate()
        }
      }
      worker.onerror = () => {
        setError('Worker でエラーが発生しました')
        setBusy(false)
      }
      worker.postMessage({
        returns: aligned.localReturns,
        fxReturns: aligned.fxReturns,
        foreign: aligned.foreign,
        hedgeReturns: aligned.hedgeReturns,
        hedgeMode,
        evaluationBasis: effectiveBasis,
        cpiReturns: effectiveBasis === 'real' ? aligned.cpiReturns : undefined,
        expenseRatios: costs.expenseRatios,
        assetIds: chosen.map((a) => a.id),
        stepPct,
        mins: chosen.map((a) => bounds[a.id]?.min ?? 0),
        maxs: chosen.map((a) => bounds[a.id]?.max ?? 100),
      })
      return
    }
    const worker = new Worker(new URL('./workers/optimize.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    setProgress({ phase: 'coarse', tested: 0, total: comboCount, percent: 0, best: null })
    worker.onmessage = (
      event: MessageEvent<{ type: string } & OptimizeProgress & { result?: OptimizeResponse; message?: string }>,
    ) => {
      if (event.data.type === 'progress') {
        setProgress((prev) => ({
          ...event.data,
          percent: Math.max(prev?.percent ?? 0, event.data.percent),
        }))
        return
      }
      if (event.data.type === 'error') {
        setError(event.data.message ?? '最適化に失敗しました')
        setBusy(false)
        worker.terminate()
        return
      }
      if (event.data.type === 'done' && event.data.result) {
        const next = event.data.result
        setResult(next)
        const cand = next.byMode?.[exploreMode] ?? next.best
        const worstI = cand.windows.findIndex((w) => w.start === cand.worstStart)
        setPicked(worstI >= 0 ? worstI : 0)
        setBusy(false)
        worker.terminate()
      }
    }
    worker.onerror = () => {
      setError('Worker でエラーが発生しました')
      setBusy(false)
    }
    worker.postMessage({
      returns: aligned.localReturns,
      dates: aligned.dates,
      assetIds: chosen.map((a) => a.id),
      assetClasses: chosen.map((a) => a.assetClass),
      periodMonths,
      rollStep: 12,
      rebalanceEvery: rebalanceEveryMonths(rebalance),
      initial,
      monthly,
      target: reverse ? target : 0,
      mode,
      scoreAll: !reverse,
      stepPct,
      fineSearch,
      mins: chosen.map((a) => bounds[a.id]?.min ?? 0),
      maxs: chosen.map((a) => bounds[a.id]?.max ?? 100),
      riskFree: riskFree / 100,
      costs,
      liquidate: true,
      fxReturns: aligned.fxReturns,
      foreign: aligned.foreign,
      hedgeReturns: aligned.hedgeReturns,
      hedgeMode,
      evaluationBasis: effectiveBasis,
      cpiLevels: effectiveBasis === 'real' ? aligned.cpiLevels : undefined,
      cpiReference: effectiveBasis === 'real' ? (aligned.cpiReference ?? undefined) : undefined,
    })
  }

  const best = (!reverse && result?.byMode ? result.byMode[exploreMode] : result?.best) ?? null
  const displayMonthly = mode === 'minContribution' && best ? best.requiredMonthly : monthly
  const path = useMemo(() => {
    if (!best || picked == null || !best.windows[picked]) return null
    const start = aligned.dates.indexOf(best.windows[picked].start)
    if (start < 0) return null
    return simulatePath(
      aligned.localReturns,
      aligned.dates,
      start,
      periodMonths,
      best.weights,
      initial,
      displayMonthly,
      rebalanceEveryMonths(rebalance),
      costs,
      true,
      aligned.fxReturns,
      aligned.foreign,
      aligned.hedgeReturns,
      hedgeMode,
      effectiveBasis,
      aligned.cpiLevels,
      aligned.cpiReference ?? undefined,
    )
  }, [aligned, best, picked, periodMonths, initial, displayMonthly, rebalance, costs, hedgeMode, effectiveBasis])

  const comparisonPath = useMemo(() => {
    if (!best || picked == null || !best.windows[picked] || !aligned.localReturns.length) return null
    if (!aligned.foreign.some(Boolean)) return null
    const start = aligned.dates.indexOf(best.windows[picked].start)
    if (start < 0) return null
    return simulatePath(
      aligned.localReturns,
      aligned.dates,
      start,
      periodMonths,
      best.weights,
      initial,
      displayMonthly,
      rebalanceEveryMonths(rebalance),
      costs,
      true,
      aligned.fxReturns,
      aligned.foreign,
      aligned.hedgeReturns,
      hedgeMode === 'hedged' ? 'unhedged' : 'hedged',
      effectiveBasis,
      aligned.cpiLevels,
      aligned.cpiReference ?? undefined,
    )
  }, [aligned, best, picked, periodMonths, initial, displayMonthly, rebalance, costs, hedgeMode, effectiveBasis])

  const fxReport = useMemo(() => {
    if (!best || !aligned.localReturns.length) return null
    return analyzeFx({
      unhedgedReturns: aligned.returns,
      hedgedReturns: aligned.localReturns,
      fxReturns: aligned.fxReturns,
      hedgeReturns: aligned.hedgeReturns,
      foreign: aligned.foreign,
      weights: best.weights,
      dates: aligned.dates,
      periodMonths,
      rollStep: 12,
      rebalEvery: rebalanceEveryMonths(rebalance),
      initial,
      monthly: displayMonthly,
      target: reverse ? target : 0,
      costs,
      liquidate: true,
      evaluationBasis: effectiveBasis,
      cpiLevels: aligned.cpiLevels,
      cpiReference: aligned.cpiReference ?? undefined,
    })
  }, [aligned, best, periodMonths, rebalance, initial, displayMonthly, reverse, target, costs, effectiveBasis])

  const windowFx = useMemo(() => {
    if (!best || picked == null || !best.windows[picked]) return null
    const fx = new Map(series.fx.USDJPY)
    const win = best.windows[picked]
    const a = fx.get(win.start)
    const b = fx.get(win.end)
    if (a == null || b == null) return null
    return { start: a, end: b, change: b / a - 1 }
  }, [best, picked])

  const mixedReturnTypes = new Set(chosen.map((a) => a.returnType)).size > 1
  const taxLabel =
    taxAccount === 'nisa' ? 'NISA 0%' : taxAccount === 'tokutei' ? '特定口座 20.315%' : `税率 ${customTax}%`
  const amountBasisLabel = effectiveBasis === 'real' ? '現在の購買力' : '名目'

  return (
    <div className="min-h-svh">
      <header className="border-b border-stone-300/80 bg-[#f7f3ea]/90">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-5 py-6">
          <div>
            <p className="text-[11px] tracking-[0.22em] text-emerald-900 uppercase">Historical Portfolio Lab</p>
            <h1 className="font-serif text-3xl tracking-tight text-stone-900">どの年から始めても届く配分を探す</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-stone-600">
              リバランス時の譲渡課税・信託報酬・売買コストに加え、ドル資産は毎月の為替を円換算に入れた Rolling Backtest です。資産を選んだあと、予想リスクのバーで効率的フロンティア上の配分を選べます。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Badge>{taxLabel}</Badge>
            <Badge>信託報酬あり</Badge>
            <Badge>期末売却課税</Badge>
            <Badge>{amountBasisLabel}</Badge>
            <Badge>{hedgeMode === 'hedged' ? '為替ヘッジあり' : '為替変動込み'}</Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-6 lg:grid-cols-[360px_1fr]">
        <section className="space-y-5 lg:sticky lg:top-4 lg:self-start">
          <div className="grid grid-cols-3 gap-1 rounded-xl border border-stone-300/80 bg-[#fbf8f1] p-1">
            <button
              type="button"
              onClick={() => {
                setWorkspace('explore')
                setResult(null)
                setFrontierMap(null)
              }}
              className={`rounded-lg px-2 py-2 text-xs sm:text-sm ${workspace === 'explore' ? 'bg-emerald-950 text-amber-50' : 'text-stone-700'}`}
            >
              配分を探す
            </button>
            <button
              type="button"
              onClick={() => {
                setWorkspace('reverse')
                setResult(null)
                setFrontierMap(null)
              }}
              className={`rounded-lg px-2 py-2 text-xs sm:text-sm ${workspace === 'reverse' ? 'bg-emerald-950 text-amber-50' : 'text-stone-700'}`}
            >
              積立を逆算
            </button>
            <button
              type="button"
              onClick={() => {
                setWorkspace('frontier')
                setResult(null)
                setFrontierMap(null)
              }}
              className={`rounded-lg px-2 py-2 text-xs sm:text-sm ${workspace === 'frontier' ? 'bg-emerald-950 text-amber-50' : 'text-stone-700'}`}
            >
              リスクとリターン
            </button>
          </div>

          <Card title="資産">
            <div className="grid gap-3">
              {CLASS_ORDER.map((cls) => {
                const group = assets.filter((a) => a.assetClass === cls)
                if (!group.length) return null
                return (
                  <div key={cls}>
                    <div className="mb-1.5 text-[11px] font-medium tracking-wide text-stone-500">{CLASS_LABEL[cls]}</div>
                    <div className="flex flex-wrap gap-2">
                      {group.map((a) => {
                        const on = selected.includes(a.id)
                        const tint = CORE_COLORS[a.id]
                        return (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => toggle(a.id)}
                            className={`rounded-full border px-3 py-1 text-xs ${
                              tint
                                ? ''
                                : on
                                  ? 'border-emerald-800 bg-emerald-900 text-amber-50'
                                  : 'border-stone-300 bg-white text-stone-700 hover:border-stone-400'
                            }`}
                            style={
                              tint
                                ? on
                                  ? { background: tint, borderColor: tint, color: '#faf6ee' }
                                  : { background: `${tint}22`, borderColor: tint, color: tint }
                                : undefined
                            }
                          >
                            {tint && (
                              <span
                                className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                                style={{ background: on ? '#faf6ee' : tint }}
                              />
                            )}
                            {a.name}
                            <span className="ml-1 opacity-70">{exposureOf(a.id, a.currency) === 'USD' ? 'ドル' : '円'}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
            {mixedReturnTypes && (
              <p className="mt-2 text-xs text-amber-800">
                Price Return と Total Return が混在しています。条件の違う指数を比較している点に注意。
              </p>
            )}
          </Card>

          <Card title="投資条件">
            <div className="grid grid-cols-2 gap-3">
              <Field label="初期資産">
                <input className={inputClass} type="number" min={0} value={initial} onChange={(e) => setInitial(Number(e.target.value))} />
              </Field>
              <Field label="毎月積立額">
                <input
                  className={inputClass}
                  type="number"
                  min={0}
                  value={monthly}
                  onChange={(e) => setMonthly(Number(e.target.value))}
                />
              </Field>
              <Field label="基準通貨">
                <select
                  className={inputClass}
                  value={currency}
                  onChange={(e) => {
                    const next = e.target.value as Currency
                    setCurrency(next)
                    if (next === 'USD') setEvaluationBasis('nominal')
                    setResult(null)
                    setFrontierMap(null)
                  }}
                >
                  <option value="JPY">JPY</option>
                  <option value="USD">USD</option>
                </select>
              </Field>
              <Field label="金額の基準">
                <select
                  className={inputClass}
                  value={effectiveBasis}
                  disabled={currency !== 'JPY'}
                  onChange={(e) => {
                    setEvaluationBasis(e.target.value as EvaluationBasis)
                    setResult(null)
                    setFrontierMap(null)
                  }}
                >
                  <option value="nominal">名目金額</option>
                  <option value="real">実質（現在の購買力）</option>
                </select>
              </Field>
              <Field label="外貨">
                <select
                  className={inputClass}
                  value={hedgeMode}
                  onChange={(e) => {
                    setHedgeMode(e.target.value as HedgeMode)
                    setResult(null)
                    setFrontierMap(null)
                  }}
                >
                  <option value="unhedged">ヘッジなし</option>
                  <option value="hedged">ヘッジあり（推定コスト込）</option>
                </select>
              </Field>
              <Field label="投資期間">
                <select
                  className={inputClass}
                  value={customYears ? 'custom' : String(years)}
                  onChange={(e) => {
                    if (e.target.value === 'custom') setCustomYears(String(years))
                    else {
                      setCustomYears('')
                      setYears(Number(e.target.value))
                    }
                  }}
                >
                  {PERIODS.map((y) => (
                    <option key={y} value={y}>
                      {y}年
                    </option>
                  ))}
                  <option value="custom">Custom</option>
                </select>
              </Field>
              {customYears !== '' && (
                <Field label="年数">
                  <input className={inputClass} type="number" min={1} max={50} value={customYears} onChange={(e) => setCustomYears(e.target.value)} />
                </Field>
              )}
              <Field label="リバランス">
                <select className={inputClass} value={rebalance} onChange={(e) => setRebalance(e.target.value as Rebalance)}>
                  <option value="none">なし</option>
                  <option value="monthly">毎月</option>
                  <option value="quarterly">四半期</option>
                  <option value="semiannual">半年</option>
                  <option value="annual">年1回</option>
                </select>
              </Field>
            </div>
            {workspace === 'reverse' && reverseMode === 'minContribution' && (
              <p className="mt-2 text-xs text-stone-500">必要積立の逆算では、上の毎月積立額は使いません。結果として月額が出ます。</p>
            )}
            {workspace === 'reverse' && reverseMode === 'successRate' && (
              <p className="mt-2 text-xs text-stone-500">到達率の最大化では、上の毎月積立額を使います。</p>
            )}
            <p className="mt-3 text-xs text-stone-500">
              データ期間 {aligned.start ? `${ymLabel(aligned.start)} – ${ymLabel(aligned.end ?? '')}` : '（資産の共通期間なし）'} ／
              Rolling {windowCount} 本
              {aligned.foreign.some(Boolean)
                ? hedgeMode === 'hedged'
                  ? ' ／ 外貨資産はCIP推定ヘッジ収益を反映'
                  : ` ／ ドル資産は毎月のUSDJPYで${currency === 'JPY' ? '円' : 'ドル'}評価`
                : ''}
            </p>
            {effectiveBasis === 'real' && (
              <p className="mt-1 text-xs text-stone-500">
                入力額と結果はCPI最新月（{series.inflation?.JPY.at(-1)?.[0] ?? '不明'}）の購買力。積立額も各月のCPIで当時の名目額へ換算します。
              </p>
            )}
          </Card>

          <Card title="税金とコスト">
            <div className="grid gap-3">
              <Field label="口座">
                <select
                  className={inputClass}
                  value={taxAccount}
                  onChange={(e) => setTaxAccount(e.target.value as TaxAccount)}
                >
                  <option value="tokutei">特定口座（20.315%）</option>
                  <option value="nisa">NISA（非課税）</option>
                  <option value="custom">カスタム</option>
                </select>
              </Field>
              {taxAccount === 'custom' && (
                <Field label="税率 %">
                  <input className={inputClass} type="number" min={0} max={100} step={0.001} value={customTax} onChange={(e) => setCustomTax(Number(e.target.value))} />
                </Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="売買コスト %">
                  <input className={inputClass} type="number" min={0} step={0.01} value={txnCostPct} onChange={(e) => setTxnCostPct(Number(e.target.value))} />
                </Field>
                <Field label="積立時手数料 %">
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    step={0.01}
                    value={purchaseCostPct}
                    onChange={(e) => setPurchaseCostPct(Number(e.target.value))}
                  />
                </Field>
              </div>
              <p className="text-xs text-stone-500">
                リバランスの売りで譲渡益が出れば課税し、売買コストを差し引きます。期末に全売却した手取りで評価します。配当の都度課税は TR
                指数に内包のため未控除です。
              </p>
              {chosen.length > 0 && (
                <div className="grid gap-2">
                  <span className="text-sm text-stone-500">信託報酬（年率 %）</span>
                  {chosen.map((a, i) => {
                    const ter = (costs.expenseRatios[i] ?? defaultTer(a.id)) * 100
                    return (
                      <label key={a.id} className="flex items-center gap-2 text-xs">
                        <span className="w-36 shrink-0 truncate">{a.name}</span>
                        <input
                          className={inputClass}
                          type="number"
                          min={0}
                          step={0.001}
                          value={Number(ter.toFixed(4))}
                          onChange={(e) => setTerOverrides((prev) => ({ ...prev, [a.id]: Number(e.target.value) / 100 }))}
                        />
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          </Card>

          {workspace === 'reverse' && (
            <Card title="目標逆算">
              <div className="grid gap-3">
                <Field label={`目標金額（税引後・${amountBasisLabel}）`}>
                  <input className={inputClass} type="number" min={0} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
                </Field>
                <div className="grid gap-2">
                  {REVERSE_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setReverseMode(m.id)}
                      className={`rounded-md border px-3 py-2 text-left ${
                        reverseMode === m.id ? 'border-emerald-800 bg-emerald-950/5' : 'border-stone-200 bg-white'
                      }`}
                    >
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-xs text-stone-500">{m.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {workspace === 'frontier' && (
            <Card title="予想リスクで選ぶ">
              {frontierMap ? (
                <div className="grid gap-4">
                  <Field label={`予想リスク（年率） ${pct(targetSigma, 1)}`}>
                    <input
                      className="w-full accent-emerald-900"
                      type="range"
                      min={frontierMap.minSigma}
                      max={Math.max(frontierMap.maxSigma, frontierMap.minSigma + 1e-6)}
                      step={0.0005}
                      value={Math.min(frontierMap.maxSigma, Math.max(frontierMap.minSigma, targetSigma))}
                      onChange={(e) => {
                        const sigma = Number(e.target.value)
                        setTargetSigma(sigma)
                        scheduleFrontierPick(frontierMap, sigma)
                      }}
                      onPointerUp={(e) => applyFrontierPick(frontierMap, Number(e.currentTarget.value), true)}
                    />
                    <div className="flex justify-between text-[11px] text-stone-400">
                      <span>{pct(frontierMap.minSigma, 1)}</span>
                      <span>{pct(frontierMap.maxSigma, 1)}</span>
                    </div>
                  </Field>
                  {selectedPoint && (
                    <div className="grid gap-3">
                      <div className="rounded-lg bg-white/80 px-3 py-3">
                        <div className="text-xs text-stone-500">このリスクでの期待リターン（年率）</div>
                        <div className="text-2xl font-semibold tabular-nums">{pct(selectedPoint.mu, 1)}</div>
                      </div>
                      <AllocationDonut
                        digits={1}
                        items={chosen.map((a, i) => ({
                          label: a.name,
                          weight: selectedPoint.weights[i] ?? 0,
                          color: allocColor(a.id, i),
                        }))}
                      />
                    </div>
                  )}
                  <div className="grid gap-1.5 text-xs text-stone-600">
                    {chosen.map((a, i) => (
                      <div key={a.id} className="flex justify-between gap-2">
                        <span className="truncate">{a.name}</span>
                        <span className="tabular-nums text-stone-500">
                          {pct(frontierMap.assets[i]?.mu ?? 0, 1)} / {pct(frontierMap.assets[i]?.sigma ?? 0, 1)}
                        </span>
                      </div>
                    ))}
                    <p className="text-[11px] text-stone-400">各資産の過去平均リターン / リスク（年率）</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-stone-500">
                  資産を選んで実行すると、効率的フロンティアができます。予想リスクのバーで線上の配分がすぐ変わります。
                </p>
              )}
              <p className="mt-3 text-xs text-stone-500">
                期待値は信託報酬・為替方針込み、税引き前の月次リターンを年率換算したものです。将来の予測ではなく、選んだ共通期間の実績です。指定リスクはフロンティア線上の2点を線形補間します。
              </p>
            </Card>
          )}

          <details className="rounded-xl border border-stone-300/80 bg-[#fbf8f1] p-4">
            <summary className="cursor-pointer text-sm font-medium">Advanced Settings</summary>
            <div className="mt-3 grid gap-3">
              <Field label="Allocation Step">
                <select className={inputClass} value={stepPct} onChange={(e) => setStepPct(Number(e.target.value))}>
                  {[1, 2, 5, 10].map((s) => (
                    <option key={s} value={s}>
                      {s}%
                    </option>
                  ))}
                </select>
              </Field>
              {workspace !== 'frontier' && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={fineSearch} onChange={(e) => setFineSearch(e.target.checked)} />
                  Fine Search（上位の周辺を 1% 刻み）
                </label>
              )}
              <Field label="Risk Free Rate（年率 %）">
                <input className={inputClass} type="number" step={0.1} value={riskFree} onChange={(e) => setRiskFree(Number(e.target.value))} />
              </Field>
              {chosen.map((a) => {
                const b = bounds[a.id] ?? { min: 0, max: 100 }
                return (
                  <div key={a.id} className="grid grid-cols-2 gap-2">
                    <Field label={`${a.name} min %`}>
                      <input
                        className={inputClass}
                        type="number"
                        min={0}
                        max={100}
                        value={b.min}
                        onChange={(e) => setBounds((prev) => ({ ...prev, [a.id]: { ...b, min: Number(e.target.value) } }))}
                      />
                    </Field>
                    <Field label="max %">
                      <input
                        className={inputClass}
                        type="number"
                        min={0}
                        max={100}
                        value={b.max}
                        onChange={(e) => setBounds((prev) => ({ ...prev, [a.id]: { ...b, max: Number(e.target.value) } }))}
                      />
                    </Field>
                  </div>
                )
              })}
              <p className="text-xs text-stone-500">探索数（粗） {comboCount.toLocaleString()} 通り</p>
            </div>
          </details>

          <button
            type="button"
            onClick={run}
            disabled={busy || chosen.length === 0 || windowCount <= 0}
            className="w-full rounded-md bg-emerald-950 py-3 text-sm font-medium text-amber-50 disabled:opacity-40"
          >
            {busy
              ? frontier
                ? '地図を作成中'
                : `計算中 ${progress ? `${progress.percent}%` : ''}`
              : reverse
                ? reverseMode === 'minContribution'
                  ? '必要積立を逆算'
                  : '到達率を最大化'
                : frontier
                  ? 'リスク・リターンの配分を出す'
                  : 'シミュレーションを実行'}
          </button>
          {error && <p className="text-sm text-red-800">{error}</p>}
        </section>

        <section className="space-y-5">
          {!best && !busy && (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white/50 px-6 py-16 text-center text-stone-500">
              {reverse
                ? '目標金額を入れて逆算すると、税・信託報酬込みで必要な月額と配分が出ます。'
                : frontier
                  ? '資産を選んで実行すると、予想リスクのバーでフロンティア線上の配分を選べます。'
                  : '資産と投資条件を入れてシミュレーションすると、Worst / 中央値 / Sharpe で配分を評価できます。'}
            </div>
          )}

          {busy && progress && (
            <Card title="計算中">
              {frontier ? (
                <p className="text-sm text-stone-600">選択した資産の過去リターンから、リスクとリターンの地図を作成しています。</p>
              ) : (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <p className="text-5xl font-semibold tabular-nums tracking-tight text-stone-900">{progress.percent}%</p>
                    <p className="mb-1 text-sm text-stone-500">
                      {progress.phase === 'coarse' ? '粗探索' : '精密探索'} {progress.tested.toLocaleString()} /{' '}
                      {Math.max(progress.total, 1).toLocaleString()}
                    </p>
                  </div>
                  <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-stone-200">
                    <div
                      className="h-full rounded-full bg-emerald-900 transition-[width] duration-150"
                      style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                    />
                  </div>
                </>
              )}
              {progress.byMode && !reverse && !frontier ? (
                <div className="mt-4 grid gap-2 text-sm text-stone-700">
                  {EXPLORE_MODES.map((m) => {
                    const cand = progress.byMode?.[m.id]
                    if (!cand) return null
                    return (
                      <p key={m.id}>
                        <span className="text-stone-500">{m.label}</span>
                        {' ／ '}
                        <PreviewMix candidate={cand} names={chosen.map((a) => a.name)} />
                      </p>
                    )
                  })}
                </div>
              ) : (
                progress.best && (
                  <Preview candidate={progress.best} names={chosen.map((a) => a.name)} currency={currency} reverse={reverse} />
                )
              )}
            </Card>
          )}

          {result && best && (
            <>
              {result.note && <p className="text-xs text-amber-900">{result.note}</p>}

              {frontier && frontierMap && (
                <Card title="リスクとリターンの地図">
                  <FrontierChart
                    cloud={frontierMap.cloud}
                    frontier={frontierMap.frontier}
                    assets={frontierMap.assets}
                    assetNames={chosen.map((a) => a.name)}
                    assetColors={chosen.map((a, i) => allocColor(a.id, i))}
                    selected={selectedPoint}
                    targetSigma={targetSigma}
                    onPick={(sigma) => {
                      setTargetSigma(sigma)
                      scheduleFrontierPick(frontierMap, sigma)
                    }}
                  />
                  <p className="mt-2 text-xs text-stone-500">
                    緑の線が効率的フロンティアです。予想リスク（横軸）のバーか図を左右に動かすと、線上の配分がすぐ変わります。期待リターンはその結果です。点は探索した配分、色付きが各資産100%です。
                  </p>
                </Card>
              )}

              {!reverse && !frontier && result.byMode && (
                <div>
                  <div className="grid grid-cols-3 gap-1 rounded-xl border border-stone-300/80 bg-[#fbf8f1] p-1">
                    {EXPLORE_MODES.map((m) => {
                      const cand = result.byMode![m.id]
                      if (!cand) return null
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => {
                            setExploreMode(m.id)
                            const worstI = cand.windows.findIndex((w) => w.start === cand.worstStart)
                            setPicked(worstI >= 0 ? worstI : 0)
                          }}
                          className={`rounded-lg px-3 py-2.5 text-left ${
                            exploreMode === m.id ? 'bg-emerald-950 text-amber-50' : 'text-stone-700 hover:bg-white/70'
                          }`}
                        >
                          <div className="text-sm font-medium">{m.label}</div>
                          <div className={`mt-0.5 text-xs tabular-nums ${exploreMode === m.id ? 'text-amber-100/80' : 'text-stone-500'}`}>
                            {m.id === 'sharpe'
                              ? cand.sharpe.toFixed(2)
                              : m.id === 'minimax'
                                ? amountPrimary(cand.worst, currency)
                                : amountPrimary(cand.median, currency)}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-xs text-stone-500">同じシミュレーションを3つの基準で評価しています。タブを切り替えても再計算しません。</p>
                </div>
              )}

              <section className="rounded-xl border border-stone-300/80 bg-[#fbf8f1] p-5">
                {reverse && mode === 'minContribution' ? (
                  <div>
                    <p className="text-sm text-stone-500">どの開始年からでも目標に届く、毎月の積立（{amountBasisLabel}）</p>
                    <div className="mt-1 flex flex-wrap items-end gap-3">
                      <Amount n={best.requiredMonthly} currency={currency} size="hero" suffix="/月" />
                      <p className="mb-1 text-sm text-stone-600">
                        目標 {amountPrimary(target, currency)} ／ 到達 {pct(best.successRate, 0)}
                      </p>
                    </div>
                  </div>
                ) : reverse ? (
                  <div>
                    <p className="text-sm text-stone-500">指定した積立で、目標に届いた割合（{amountBasisLabel}）</p>
                    <div className="mt-1 flex flex-wrap items-end gap-3">
                      <p className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">{pct(best.successRate, 0)}</p>
                      <p className="mb-1 text-sm text-stone-600">
                        毎月 {amountPrimary(monthly, currency)} ／ 目標 {amountPrimary(target, currency)}
                      </p>
                    </div>
                  </div>
                ) : frontier && selectedPoint ? (
                  <div>
                    <p className="text-sm text-stone-500">フロンティア上の予想リスク（年率・税引前）</p>
                    <p className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">{pct(selectedPoint.sigma, 1)}</p>
                    <p className="mt-1 text-sm text-stone-600">
                      このリスクでの期待リターン {pct(selectedPoint.mu, 1)} ／ 下の金額は Rolling の税引後手取り
                    </p>
                  </div>
                ) : exploreMode === 'minimax' ? (
                  <div>
                    <p className="text-sm text-stone-500">最悪期間の税引後手取り（{amountBasisLabel}）</p>
                    <Amount n={best.worst} currency={currency} size="hero" />
                  </div>
                ) : exploreMode === 'sharpe' ? (
                  <div>
                    <p className="text-sm text-stone-500">Sharpe（信託報酬・リバランス税込み）</p>
                    <p className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">{best.sharpe.toFixed(2)}</p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm text-stone-500">よくある期間の税引後手取り（{amountBasisLabel}）</p>
                    <Amount n={best.median} currency={currency} size="hero" />
                  </div>
                )}

                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  <Metric
                    label="最悪"
                    hint={`${yearLabel(best.worstStart)}開始`}
                    n={best.worst}
                    currency={currency}
                    tone={reverse && best.worst + 1 < target ? 'bad' : 'ok'}
                  />
                  <Metric label="よくある（中央値）" hint="半分の期間はこれ以上" n={best.median} currency={currency} />
                  <Metric label="最良" hint={`${yearLabel(best.bestStart)}開始`} n={best.best} currency={currency} />
                </div>
                <OutcomeRange
                  worst={best.worst}
                  median={best.median}
                  best={best.best}
                  target={reverse ? target : null}
                  currency={currency}
                />
                {reverse && (
                  <p className="mt-3 text-sm text-stone-600">
                    {best.worst + 1 >= target
                      ? `最悪の${yearLabel(best.worstStart)}開始でも目標に届く`
                      : `最悪の${yearLabel(best.worstStart)}開始は目標まで ${amountPrimary(target - best.worst, currency)} 不足`}
                  </p>
                )}
              </section>

              <Card title="配分">
                <AllocationDonut
                  digits={frontier ? 1 : 0}
                  items={chosen.map((a, i) => ({
                    label: a.name,
                    weight: (frontier && selectedPoint ? selectedPoint.weights[i] : best.weights[i]) ?? 0,
                    color: allocColor(a.id, i),
                  }))}
                />
              </Card>

              {fxReport && (
                <Card title="為替リスク">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg bg-white/80 px-3 py-3">
                      <div className="text-xs text-stone-500">外貨の比率</div>
                      <div className="text-2xl font-semibold tabular-nums">{pct(fxReport.foreignWeight, 0)}</div>
                    </div>
                    <div className="rounded-lg bg-white/80 px-3 py-3">
                      <div className="text-xs text-stone-500">為替の振れ（年率）</div>
                      <div className="text-2xl font-semibold tabular-nums">{pct(fxReport.fxVol, 0)}</div>
                      <div className="mt-1 text-xs text-stone-500">USDJPY の過去ボラティリティ</div>
                    </div>
                    <div className="rounded-lg bg-white/80 px-3 py-3">
                      <div className="text-xs text-stone-500">よくある期間の為替寄与</div>
                      <div className="text-2xl font-semibold tabular-nums">{signedAmount(fxReport.medianFxImpact, currency)}</div>
                      <div className="mt-1 text-xs text-stone-500">ヘッジなし − ヘッジあり</div>
                    </div>
                    <div className="rounded-lg bg-white/80 px-3 py-3">
                      <div className="text-xs text-stone-500">推定ヘッジコスト（年率）</div>
                      <div className="text-2xl font-semibold tabular-nums">{pct(fxReport.hedgeCostAnnual, 1)}</div>
                      <div className="mt-1 text-xs text-stone-500">
                        中央期間の累計 {amountPrimary(fxReport.hedgeCostPaidMedian, currency)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-stone-200 text-left text-stone-500">
                          <th className="py-2 pr-3 font-medium" />
                          <th className="py-2 pr-3 text-right font-medium">最悪</th>
                          <th className="py-2 pr-3 text-right font-medium">よくある</th>
                          <th className="py-2 text-right font-medium">ボラ</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-stone-100">
                          <td className="py-2 pr-3 font-medium">
                            ヘッジなし{hedgeMode === 'unhedged' ? '（選択中）' : ''}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{amountPrimary(fxReport.unhedgedWorst, currency)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{amountPrimary(fxReport.unhedgedMedian, currency)}</td>
                          <td className="py-2 text-right tabular-nums">{pct(fxReport.unhedgedVol, 0)}</td>
                        </tr>
                        <tr>
                          <td className="py-2 pr-3 font-medium">
                            為替ヘッジあり{hedgeMode === 'hedged' ? '（選択中）' : ''}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{amountPrimary(fxReport.hedgedWorst, currency)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{amountPrimary(fxReport.hedgedMedian, currency)}</td>
                          <td className="py-2 text-right tabular-nums">{pct(fxReport.hedgedVol, 0)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-3 text-sm text-stone-600">
                    {fxReport.worstFxImpact < 0
                      ? `円高が一番効いたのは${yearLabel(fxReport.worstFxStart)}開始。為替だけで ${signedAmount(fxReport.worstFxImpact, currency)}。`
                      : 'この配分では、最悪期間でも為替はマイナスに効いていません。'}
                    年率リターンはヘッジなし {pct(fxReport.unhedgedReturn, 1)}、ヘッジあり {pct(fxReport.hedgedReturn, 1)}。
                    為替との相関 {fxReport.fxCorr.toFixed(2)}。
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    ヘッジありは日米1年公的金利差から算出したCIP推定です。通貨ベーシス、フォワードの売買スプレッド、実際のロール価格は含みません。
                  </p>
                </Card>
              )}

              <Card title={`いくらで終わったか（税引後・${amountBasisLabel}）`}>
                <Histogram
                  values={best.windows.map((w) => w.final)}
                  target={reverse ? target : null}
                  currency={currency}
                />
                <p className="mt-1 text-xs text-stone-500">期末に全売却した手取りです。選択した為替方針を反映、単位は万円。</p>
              </Card>

              <Card title={`開始年ごとの手取り（${amountBasisLabel}）`}>
                <p className="mb-2 text-xs text-stone-500">
                  行をクリックすると、その期間の推移を表示します。金額は選択した為替方針と{amountBasisLabel}を反映。
                  {best.windows.some((w) => w.fxImpact !== 0) ? ' 「為替」はヘッジなしとヘッジありの税引後差額です。' : ''}
                </p>
                <RollingBars
                  windows={best.windows}
                  target={reverse ? target : null}
                  currency={currency}
                  selected={picked}
                  onSelect={setPicked}
                />
              </Card>

              {path && picked != null && best.windows[picked] && (
                <Card title={`${yearLabel(best.windows[picked].start)}開始の推移`}>
                  <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Metric label="税引後手取り" n={best.windows[picked].afterTax} currency={currency} />
                    <Metric label="売却前の評価額" n={best.windows[picked].market} currency={currency} />
                    <Metric label="払った税" n={best.windows[picked].taxPaid} currency={currency} />
                    {hedgeMode === 'hedged' && best.windows[picked].hedgeCostPaid > 0 && (
                      <Metric
                        label="推定ヘッジコスト"
                        n={best.windows[picked].hedgeCostPaid}
                        currency={currency}
                      />
                    )}
                    <div className="rounded-lg bg-white/80 px-3 py-3">
                      <div className="text-xs text-stone-500">最大下落</div>
                      <div className="text-xl font-semibold tabular-nums">{pct(path.maxDrawdown, 1)}</div>
                    </div>
                    {best.windows[picked].fxImpact !== 0 && (
                      <div
                        className={`rounded-lg px-3 py-3 ${best.windows[picked].fxImpact < 0 ? 'bg-red-50' : 'bg-white/80'}`}
                      >
                        <div className="text-xs text-stone-500">為替の寄与</div>
                        <div className="text-2xl font-semibold tabular-nums">
                          {signedAmount(best.windows[picked].fxImpact, currency)}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">ヘッジなし − ヘッジあり</div>
                      </div>
                    )}
                  </div>
                  <WealthChart
                    dates={path.dates}
                    portfolio={path.portfolio}
                    principal={path.principal}
                    hedged={comparisonPath?.portfolio}
                    currency={currency}
                    primaryLabel={hedgeMode === 'hedged' ? 'ヘッジあり' : 'ヘッジなし'}
                    comparisonLabel={hedgeMode === 'hedged' ? 'ヘッジなし' : 'ヘッジあり'}
                  />
                  {windowFx && (
                    <p className="mt-2 text-xs text-stone-500">
                      この期間のドル円 {windowFx.start.toFixed(1)} → {windowFx.end.toFixed(1)}（{pct(windowFx.change, 1)}）。緑の線が選択中の為替方針です。
                    </p>
                  )}
                </Card>
              )}

              <Card title="他の配分と比べる">
                <CompareTable
                  rows={result.comparisons}
                  currency={currency}
                  reverse={reverse}
                  highlight={frontier ? '選択配分' : !reverse ? SCORE_LABEL[exploreMode] : '最適配分'}
                />
              </Card>

              <Card title="系列と前提">
                <ul className="grid gap-2 text-xs leading-relaxed text-stone-600">
                  {chosen.map((a, i) => (
                    <li key={a.id}>
                      <span className="font-medium text-stone-800">{a.name}</span>
                      <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5">
                        {a.returnType === 'total' ? 'Total Return' : 'Price Return'}
                      </span>
                      <span className="ml-2">TER {(costs.expenseRatios[i]! * 100).toFixed(3)}%</span>
                      <div>{a.source}</div>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-stone-500">
                  過去の到達は将来を保証しません。評価は{amountBasisLabel}、外貨は
                  {hedgeMode === 'hedged' ? 'CIP推定ヘッジコスト込み' : '毎月のUSDJPY込み'}。{taxLabel}。売買 {txnCostPct}% / 積立手数料 {purchaseCostPct}% 。
                  損失の翌年繰越は未反映。データ取得日 {series.meta.fetchedAt}。探索 {result.searched.toLocaleString()} 配分。
                  {frontier
                    ? ' 期待リターンとリスクは共通期間の月次リターン（信託報酬・為替方針込み、税引き前）を年率換算した実績であり、将来の予測ではありません。'
                    : ''}
                </p>
                {effectiveBasis === 'real' && series.inflation && (
                  <p className="mt-1 text-xs text-stone-500">
                    CPI: {series.inflation.source} 基準 {series.inflation.base}。金額は最新月の購買力へ換算。
                  </p>
                )}
                {hedgeMode === 'hedged' && series.fx.hedgeSource && (
                  <p className="mt-1 text-xs text-stone-500">為替ヘッジ: {series.fx.hedgeSource}</p>
                )}
              </Card>
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-stone-300/80 bg-[#fbf8f1] p-4 shadow-[0_1px_0_rgba(28,25,23,0.04)]">
      <h2 className="mb-3 font-serif text-lg text-stone-900">{title}</h2>
      {children}
    </section>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-stone-300 bg-white px-2.5 py-1 text-stone-600">{children}</span>
}

function Metric({
  label,
  n,
  currency,
  hint,
  tone = 'ok',
}: {
  label: string
  n: number
  currency: Currency
  hint?: string
  tone?: 'ok' | 'bad'
}) {
  return (
    <div className={`rounded-lg px-3 py-3 ${tone === 'bad' ? 'bg-red-50' : 'bg-white/80'}`}>
      <div className="text-xs text-stone-500">{label}</div>
      <Amount n={n} currency={currency} size="lg" />
      {hint && <div className="mt-1 text-xs text-stone-500">{hint}</div>}
    </div>
  )
}

function mixLabel(candidate: Candidate, names: string[]): string {
  return candidate.weights
    .map((w, i) => (w >= 0.005 ? `${names[i]} ${pct(w, 0)}` : null))
    .filter(Boolean)
    .join(' / ')
}

function PreviewMix({ candidate, names }: { candidate: Candidate; names: string[] }) {
  return <>{mixLabel(candidate, names)}</>
}

function Preview({
  candidate,
  names,
  currency,
  reverse,
}: {
  candidate: Candidate
  names: string[]
  currency: Currency
  reverse: boolean
}) {
  return (
    <p className="mt-2 text-sm text-stone-700">
      暫定 {mixLabel(candidate, names)}
      {reverse
        ? ` ／ 毎月 ${amountPrimary(candidate.requiredMonthly, currency)}`
        : ` ／ よくある ${amountPrimary(candidate.median, currency)}`}
    </p>
  )
}
