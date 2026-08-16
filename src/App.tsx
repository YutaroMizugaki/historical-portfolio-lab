import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Amount } from './Amount'
import { AllocationDonut, CompareTable, Histogram, OutcomeRange, RollingBars, WealthChart } from './charts'
import { defaultTer, TOKUTEI_TAX } from './data/costs'
import { exposureOf } from './data/exposure'
import { series, alignSelected } from './data/load'
import { countAllocations, clipBounds } from './engine/allocations'
import { analyzeFx } from './engine/fx'
import { rebalanceEveryMonths, simulatePath } from './engine/simulate'
import { amountPrimary, pct, signedAmount, yearLabel, ymLabel } from './format'
import { allocColor, CORE_COLORS } from './palette'
import type {
  Asset,
  AssetClass,
  Candidate,
  CostModel,
  Currency,
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
  const workerRef = useRef<Worker | null>(null)

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

  const aligned = useMemo(() => alignSelected(chosen, currency), [chosen, currency])
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

  const toggle = (id: string) => {
    setResult(null)
    setPicked(null)
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  const run = () => {
    if (chosen.length === 0 || aligned.dates.length < periodMonths + 1) return
    if (reverse && target <= 0) {
      setError('目標金額を入力してください')
      return
    }
    workerRef.current?.terminate()
    const worker = new Worker(new URL('./workers/optimize.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    setBusy(true)
    setError(null)
    setProgress({ phase: 'coarse', tested: 0, total: comboCount, percent: 0, best: null })
    setResult(null)
    setPicked(null)
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
    )
  }, [aligned, best, picked, periodMonths, initial, displayMonthly, rebalance, costs])

  const hedgedPath = useMemo(() => {
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
    )
  }, [aligned, best, picked, periodMonths, initial, displayMonthly, rebalance, costs])

  const fxReport = useMemo(() => {
    if (!best || !aligned.localReturns.length) return null
    return analyzeFx({
      unhedgedReturns: aligned.returns,
      hedgedReturns: aligned.localReturns,
      fxReturns: aligned.fxReturns,
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
    })
  }, [aligned, best, periodMonths, rebalance, initial, displayMonthly, reverse, target, costs])

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

  return (
    <div className="min-h-svh">
      <header className="border-b border-stone-300/80 bg-[#f7f3ea]/90">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-5 py-6">
          <div>
            <p className="text-[11px] tracking-[0.22em] text-emerald-900 uppercase">Historical Portfolio Lab</p>
            <h1 className="font-serif text-3xl tracking-tight text-stone-900">どの年から始めても届く配分を探す</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-stone-600">
              リバランス時の譲渡課税・信託報酬・売買コストに加え、ドル資産は毎月の為替を円換算に入れた Rolling Backtest です。目標金額からの積立逆算は別機能です。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Badge>{taxLabel}</Badge>
            <Badge>信託報酬あり</Badge>
            <Badge>期末売却課税</Badge>
            <Badge>為替変動込み</Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-6 lg:grid-cols-[360px_1fr]">
        <section className="space-y-5 lg:sticky lg:top-4 lg:self-start">
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-stone-300/80 bg-[#fbf8f1] p-1">
            <button
              type="button"
              onClick={() => {
                setWorkspace('explore')
                setResult(null)
              }}
              className={`rounded-lg px-3 py-2 text-sm ${workspace === 'explore' ? 'bg-emerald-950 text-amber-50' : 'text-stone-700'}`}
            >
              配分を探す
            </button>
            <button
              type="button"
              onClick={() => {
                setWorkspace('reverse')
                setResult(null)
              }}
              className={`rounded-lg px-3 py-2 text-sm ${workspace === 'reverse' ? 'bg-emerald-950 text-amber-50' : 'text-stone-700'}`}
            >
              目標から積立を逆算
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
                <select className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                  <option value="JPY">JPY</option>
                  <option value="USD">USD</option>
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
                ? ` ／ ドル資産は毎月のUSDJPYで${currency === 'JPY' ? '円' : 'ドル'}評価`
                : ''}
            </p>
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
                <Field label="目標金額（期末の税引後手取り）">
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
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={fineSearch} onChange={(e) => setFineSearch(e.target.checked)} />
                Fine Search（上位の周辺を 1% 刻み）
              </label>
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
              ? `計算中 ${progress ? `${progress.percent}%` : ''}`
              : reverse
                ? reverseMode === 'minContribution'
                  ? '必要積立を逆算'
                  : '到達率を最大化'
                : 'シミュレーションを実行'}
          </button>
          {error && <p className="text-sm text-red-800">{error}</p>}
        </section>

        <section className="space-y-5">
          {!best && !busy && (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white/50 px-6 py-16 text-center text-stone-500">
              {reverse
                ? '目標金額を入れて逆算すると、税・信託報酬込みで必要な月額と配分が出ます。'
                : '資産と投資条件を入れてシミュレーションすると、Worst / 中央値 / Sharpe で配分を評価できます。'}
            </div>
          )}

          {busy && progress && (
            <Card title="計算中">
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
              {progress.byMode && !reverse ? (
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

              {!reverse && result.byMode && (
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
                    <p className="text-sm text-stone-500">どの開始年からでも目標に届く、毎月の積立</p>
                    <div className="mt-1 flex flex-wrap items-end gap-3">
                      <Amount n={best.requiredMonthly} currency={currency} size="hero" suffix="/月" />
                      <p className="mb-1 text-sm text-stone-600">
                        目標 {amountPrimary(target, currency)} ／ 到達 {pct(best.successRate, 0)}
                      </p>
                    </div>
                  </div>
                ) : reverse ? (
                  <div>
                    <p className="text-sm text-stone-500">指定した積立で、目標に届いた割合</p>
                    <div className="mt-1 flex flex-wrap items-end gap-3">
                      <p className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">{pct(best.successRate, 0)}</p>
                      <p className="mb-1 text-sm text-stone-600">
                        毎月 {amountPrimary(monthly, currency)} ／ 目標 {amountPrimary(target, currency)}
                      </p>
                    </div>
                  </div>
                ) : exploreMode === 'minimax' ? (
                  <div>
                    <p className="text-sm text-stone-500">最悪期間の税引後手取り</p>
                    <Amount n={best.worst} currency={currency} size="hero" />
                  </div>
                ) : exploreMode === 'sharpe' ? (
                  <div>
                    <p className="text-sm text-stone-500">Sharpe（信託報酬・リバランス税込み）</p>
                    <p className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">{best.sharpe.toFixed(2)}</p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm text-stone-500">よくある期間の税引後手取り</p>
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
                  items={chosen.map((a, i) => ({
                    label: a.name,
                    weight: best.weights[i] ?? 0,
                    color: allocColor(a.id, i),
                  }))}
                />
              </Card>

              {fxReport && (
                <Card title="為替リスク">
                  <div className="grid gap-3 sm:grid-cols-3">
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
                          <td className="py-2 pr-3 font-medium">ヘッジなし（実際）</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{amountPrimary(best.worst, currency)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{amountPrimary(best.median, currency)}</td>
                          <td className="py-2 text-right tabular-nums">{pct(fxReport.unhedgedVol, 0)}</td>
                        </tr>
                        <tr>
                          <td className="py-2 pr-3 font-medium">為替ヘッジあり</td>
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
                    ヘッジありは現地通貨リターンの完全ヘッジ近似です。ヘッジコスト・ロールコストは未計上。探索も推移も毎月の為替を掛けています。
                  </p>
                </Card>
              )}

              <Card title="いくらで終わったか（税引後）">
                <Histogram
                  values={best.windows.map((w) => w.final)}
                  target={reverse ? target : null}
                  currency={currency}
                />
                <p className="mt-1 text-xs text-stone-500">期末に全売却した手取りです。為替込み、単位は万円。</p>
              </Card>

              <Card title="開始年ごとの手取り">
                <p className="mb-2 text-xs text-stone-500">
                  行をクリックすると、その期間の推移を表示します。金額は為替込み。
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
                    hedged={hedgedPath?.portfolio}
                    currency={currency}
                  />
                  {windowFx && (
                    <p className="mt-2 text-xs text-stone-500">
                      この期間のドル円 {windowFx.start.toFixed(1)} → {windowFx.end.toFixed(1)}（{pct(windowFx.change, 1)}）。緑の線が為替込みの評価額です。
                    </p>
                  )}
                </Card>
              )}

              <Card title="他の配分と比べる">
                <CompareTable
                  rows={result.comparisons}
                  currency={currency}
                  reverse={reverse}
                  highlight={!reverse ? SCORE_LABEL[exploreMode] : '最適配分'}
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
                  過去の到達は将来を保証しません。ドル資産は毎月のUSDJPYを反映。{taxLabel}。売買 {txnCostPct}% / 積立手数料 {purchaseCostPct}% 。
                  損失の翌年繰越は未反映。データ取得日 {series.meta.fetchedAt}。探索 {result.searched.toLocaleString()} 配分。
                </p>
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
