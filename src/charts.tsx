import { Amount } from './Amount'
import { amountPrimary, pct, signedAmount, yearLabel, ymLabel } from './format'
import type { Candidate, Currency, WindowResult } from './types'

const INK = '#1c1917'
const MUTED = '#78716c'
const GOOD = '#3f6b58'
const BAD = '#b4533a'
const LINE = '#c4a35a'

type PieItem = { label: string; weight: number; color: string }

export function AllocationDonut({ items }: { items: PieItem[] }) {
  const shown = items.filter((i) => i.weight >= 0.005)
  const r = 42
  const c = 2 * Math.PI * r
  let acc = 0
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 120 120" className="h-28 w-28 shrink-0 sm:h-36 sm:w-36">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#e7e1d4" strokeWidth="14" />
        {shown.map((item) => {
          const len = item.weight * c
          const dash = `${len} ${c - len}`
          const rot = acc * 360
          acc += item.weight
          return (
            <circle
              key={item.label}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={item.color}
              strokeWidth="14"
              strokeDasharray={dash}
              strokeLinecap="butt"
              transform={`rotate(${rot - 90} 60 60)`}
            />
          )
        })}
      </svg>
      <ul className="grid gap-2 text-sm">
        {shown.map((item) => (
          <li key={item.label} className="flex items-baseline gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: item.color }} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="text-lg font-semibold tabular-nums text-stone-900">{pct(item.weight, 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Histogram({
  values,
  target,
  currency,
}: {
  values: number[]
  target: number | null
  currency: Currency
}) {
  if (values.length === 0) return null
  const lo = Math.min(...values, target ?? Infinity)
  const hi = Math.max(...values, target ?? 0)
  const bins = Math.min(24, Math.max(8, Math.round(Math.sqrt(values.length) * 2)))
  const counts = new Array(bins).fill(0)
  const span = hi - lo || 1
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))
    counts[i] += 1
  }
  const maxC = Math.max(...counts, 1)
  const w = 640
  const h = 220
  const pad = { l: 8, r: 12, t: 28, b: 36 }
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  const bw = iw / bins
  const tx = target == null ? null : pad.l + ((target - lo) / span) * iw
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      {counts.map((c, i) => {
        const bh = (c / maxC) * ih
        const x = pad.l + i * bw
        const mid = lo + ((i + 0.5) / bins) * span
        const ok = target == null || mid >= target
        return (
          <rect
            key={i}
            x={x + 1}
            y={pad.t + ih - bh}
            width={Math.max(1, bw - 2)}
            height={bh}
            fill={ok ? GOOD : '#d6c4b8'}
            opacity={0.9}
          />
        )
      })}
      {tx != null && target != null && (
        <>
          <line x1={tx} x2={tx} y1={pad.t} y2={pad.t + ih} stroke={LINE} strokeWidth="1.5" strokeDasharray="4 3" />
          <text x={Math.min(tx + 4, w - 120)} y={18} fill={INK} fontSize="12" fontWeight="600">
            目標 {amountPrimary(target, currency)}
          </text>
        </>
      )}
      <text x={pad.l} y={h - 10} fill={MUTED} fontSize="12">
        {amountPrimary(lo, currency)}
      </text>
      <text x={w - pad.r} y={h - 10} fill={MUTED} fontSize="12" textAnchor="end">
        {amountPrimary(hi, currency)}
      </text>
    </svg>
  )
}

export function RollingBars({
  windows,
  target,
  currency,
  selected,
  onSelect,
}: {
  windows: WindowResult[]
  target: number | null
  currency: Currency
  selected: number | null
  onSelect: (i: number) => void
}) {
  if (windows.length === 0) return null
  const maxV = Math.max(...windows.map((w) => w.final), target ?? 0, 1)
  const showFx = windows.some((w) => w.fxImpact !== 0)
  return (
    <div className="grid max-h-[420px] gap-1 overflow-y-auto pr-1">
      {windows.map((win, i) => {
        const missed = target != null && !win.success
        const active = selected === i
        const width = Math.max(2, (win.final / maxV) * 100)
        return (
          <button
            key={win.start}
            type="button"
            onClick={() => onSelect(i)}
            className={`grid items-center gap-2 rounded-md px-2 py-1 text-left ${
              showFx ? 'grid-cols-[4.5rem_1fr_5.5rem_7.5rem]' : 'grid-cols-[4.5rem_1fr_7.5rem]'
            } ${active ? 'bg-emerald-950/8 ring-1 ring-emerald-900/30' : 'hover:bg-white/70'}`}
          >
            <span className="text-sm tabular-nums text-stone-600">{yearLabel(win.start)}</span>
            <span className="relative h-5 overflow-hidden rounded-sm bg-stone-200/80">
              <span
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{ width: `${width}%`, background: missed ? BAD : GOOD }}
              />
              {target != null && (
                <span
                  className="absolute inset-y-0 w-px bg-[#c4a35a]"
                  style={{ left: `${Math.min(100, (target / maxV) * 100)}%` }}
                />
              )}
            </span>
            {showFx && (
              <span
                className={`text-right text-[11px] tabular-nums ${
                  win.fxImpact < 0 ? 'text-red-800' : win.fxImpact > 0 ? 'text-emerald-900' : 'text-stone-400'
                }`}
              >
                為替 {signedAmount(win.fxImpact, currency)}
              </span>
            )}
            <span className={`text-right text-sm font-semibold tabular-nums ${missed ? 'text-red-800' : 'text-stone-900'}`}>
              {amountPrimary(win.final, currency)}
              {missed ? <span className="ml-1 text-[10px] font-medium">未達</span> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function WealthChart({
  dates,
  portfolio,
  principal,
  hedged,
  currency,
}: {
  dates: string[]
  portfolio: number[]
  principal: number[]
  hedged?: number[]
  currency: Currency
}) {
  const n = portfolio.length
  if (n < 2) return null
  const w = 640
  const h = 240
  const pad = { l: 64, r: 12, t: 20, b: 28 }
  const iw = w - pad.l - pad.r
  const ih = h - pad.t - pad.b
  const maxV = Math.max(...portfolio, ...principal, ...(hedged ?? []), 1)
  const x = (i: number) => pad.l + (i / (n - 1)) * iw
  const y = (v: number) => pad.t + ih - (v / maxV) * ih
  const line = (xs: number[]) => xs.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <path d={line(principal)} fill="none" stroke="#a8a29e" strokeWidth="1.5" strokeDasharray="4 3" />
      {hedged && hedged.length === n && (
        <path d={line(hedged)} fill="none" stroke={LINE} strokeWidth="1.8" />
      )}
      <path d={line(portfolio)} fill="none" stroke={GOOD} strokeWidth="2.2" />
      <text x={pad.l} y={14} fill={GOOD} fontSize="12" fontWeight="600">
        為替込み
      </text>
      {hedged && (
        <text x={pad.l + 72} y={14} fill={LINE} fontSize="12" fontWeight="600">
          為替ヘッジあり
        </text>
      )}
      <text x={pad.l + (hedged ? 168 : 72)} y={14} fill="#78716c" fontSize="12">
        元本
      </text>
      <text x={pad.l} y={h - 8} fill={MUTED} fontSize="12">
        {ymLabel(dates[0] ?? '')}
      </text>
      <text x={w - pad.r} y={h - 8} fill={MUTED} fontSize="12" textAnchor="end">
        {ymLabel(dates[n - 1] ?? '')}
      </text>
      <text x={pad.l - 6} y={pad.t + 4} fill={MUTED} fontSize="11" textAnchor="end">
        {amountPrimary(maxV, currency)}
      </text>
      <text x={pad.l - 6} y={pad.t + ih} fill={MUTED} fontSize="11" textAnchor="end">
        {amountPrimary(0, currency)}
      </text>
    </svg>
  )
}

export function CompareTable({
  rows,
  currency,
  reverse,
}: {
  rows: { label: string; candidate: Candidate }[]
  currency: Currency
  reverse: boolean
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-stone-200 text-left text-stone-500">
            <th className="py-2 pr-3 font-medium">配分</th>
            {reverse && <th className="py-2 pr-3 text-right font-medium">毎月</th>}
            <th className="py-2 pr-3 text-right font-medium">最悪</th>
            <th className="py-2 pr-3 text-right font-medium">よくある</th>
            {reverse ? (
              <th className="py-2 text-right font-medium">到達</th>
            ) : (
              <th className="py-2 text-right font-medium">Sharpe</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.label} className={`border-b border-stone-100 ${idx === 0 ? 'bg-white/70' : ''}`}>
              <td className="py-3 pr-3 font-medium">{row.label}</td>
              {reverse && (
                <td className="py-3 pr-3 text-right">
                  <Amount n={row.candidate.requiredMonthly} currency={currency} size="sm" exact={false} suffix="/月" />
                </td>
              )}
              <td className="py-3 pr-3 text-right">
                <Amount n={row.candidate.worst} currency={currency} size="sm" exact={false} />
              </td>
              <td className="py-3 pr-3 text-right">
                <Amount n={row.candidate.median} currency={currency} size="sm" exact={false} />
              </td>
              <td className="py-3 text-right text-base font-semibold tabular-nums">
                {reverse ? pct(row.candidate.successRate, 0) : row.candidate.sharpe.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function OutcomeRange({
  worst,
  median,
  best,
  target,
  currency,
}: {
  worst: number
  median: number
  best: number
  target: number | null
  currency: Currency
}) {
  const lo = Math.min(worst, target ?? worst)
  const hi = Math.max(best, target ?? best, 1)
  const span = hi - lo || 1
  const pos = (v: number) => `${((v - lo) / span) * 100}%`
  return (
    <div className="mt-4">
      <div className="relative h-3 rounded-full bg-stone-200">
        <div
          className="absolute inset-y-0 rounded-full bg-emerald-900/70"
          style={{ left: pos(worst), width: `${((best - worst) / span) * 100}%` }}
        />
        <div className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-2 ring-emerald-950" style={{ left: pos(median) }} />
        {target != null && (
          <div className="absolute top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-[#c4a35a]" style={{ left: pos(target) }} />
        )}
      </div>
      <div className="mt-2 flex justify-between text-xs text-stone-500">
        <span>最悪 {amountPrimary(worst, currency)}</span>
        <span>よくある {amountPrimary(median, currency)}</span>
        <span>最良 {amountPrimary(best, currency)}</span>
      </div>
    </div>
  )
}

