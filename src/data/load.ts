import type { Asset, Currency, Point } from '../types'
import { exposureOf } from './exposure.ts'
import raw from './series.json' with { type: 'json' }

type Raw = {
  meta: { fetchedAt: string; notes: string[] }
  fx: { USDJPY: Point[] }
  assets: Asset[]
}

export const series = raw as unknown as Raw

function toMap(points: Point[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const [d, v] of points) m.set(d, v)
  return m
}

function monthIndex(date: string): number {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  return y * 12 + m
}

function longestRun(dates: string[]): string[] {
  if (dates.length === 0) return []
  let bestStart = 0
  let bestLen = 1
  let runStart = 0
  for (let i = 1; i <= dates.length; i += 1) {
    const broken =
      i === dates.length || monthIndex(dates[i]) !== monthIndex(dates[i - 1]) + 1
    if (broken) {
      const len = i - runStart
      if (len > bestLen) {
        bestLen = len
        bestStart = runStart
      }
      runStart = i
    }
  }
  return dates.slice(bestStart, bestStart + bestLen)
}

function returnsFromLevels(levels: number[]): number[] {
  const row = new Array<number>(Math.max(0, levels.length - 1))
  for (let t = 1; t < levels.length; t += 1) row[t - 1] = levels[t]! / levels[t - 1]! - 1
  return row
}

export function alignSelected(assets: Asset[], base: Currency) {
  const fx = toMap(series.fx.USDJPY)
  const maps = assets.map((a) => toMap(a.points))
  const exposures = assets.map((a) => exposureOf(a.id, a.currency))
  const needFx =
    assets.some((a) => a.currency !== base) || exposures.some((e) => e !== base)
  const allDates = new Set<string>()
  for (const m of maps) for (const d of m.keys()) allDates.add(d)
  if (needFx) for (const d of fx.keys()) allDates.add(d)

  const common = [...allDates]
    .filter((d) => maps.every((m) => m.has(d)) && (!needFx || fx.has(d)))
    .sort()

  const dates = longestRun(common)
  if (dates.length < 3) {
    return {
      dates: [] as string[],
      returns: [] as number[][],
      localReturns: [] as number[][],
      fxReturns: [] as number[],
      foreign: [] as boolean[],
      start: null as string | null,
      end: null as string | null,
    }
  }

  const unhedgedLevels = assets.map((asset, i) =>
    dates.map((d) => {
      const px = maps[i].get(d)!
      if (asset.currency === base) return px
      const fxPx = fx.get(d)!
      return base === 'JPY' ? px * fxPx : px / fxPx
    }),
  )

  const hedgedLevels = assets.map((_, i) => {
    const exposure = exposures[i]!
    if (exposure === base) return unhedgedLevels[i]!
    return dates.map((d) => maps[i].get(d)!)
  })

  const retDates = dates.slice(1)
  const returns = unhedgedLevels.map(returnsFromLevels)
  const localReturns = hedgedLevels.map(returnsFromLevels)
  const fxReturns = retDates.map((_, i) => {
    const a = fx.get(dates[i]!)
    const b = fx.get(dates[i + 1]!)
    if (!a || !b) return 0
    return base === 'JPY' ? b / a - 1 : a / b - 1
  })
  const foreign = exposures.map((e) => e !== base)

  return {
    dates: retDates,
    returns,
    localReturns,
    fxReturns,
    foreign,
    start: retDates[0] ?? null,
    end: retDates[retDates.length - 1] ?? null,
  }
}
