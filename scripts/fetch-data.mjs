#!/usr/bin/env node
/**
 * Bundle public monthly series into src/data/series.json.
 * Sources are attributed on each asset; see UI notes.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'src/data/series.json')
const UA = 'historical-portfolio-lab/0.1 (research; local backtest)'

async function fetchBuf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function fetchText(url, encoding = 'utf8') {
  const buf = await fetchBuf(url)
  if (encoding === 'utf8') return buf.toString('utf8')
  return new TextDecoder(encoding).decode(buf)
}

function ym(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`
}

function parseCsv(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
}

function returnsToLevels(monthlyReturns) {
  const levels = []
  if (monthlyReturns.length === 0) return levels
  const first = monthlyReturns[0][0]
  const [fy, fm] = first.split('-').map(Number)
  const prevM = fm === 1 ? 12 : fm - 1
  const prevY = fm === 1 ? fy - 1 : fy
  let level = 100
  levels.push([ym(prevY, prevM), level])
  for (const [date, r] of monthlyReturns) {
    level *= 1 + r
    if (Number.isFinite(level) && level > 0) levels.push([date, Number(level.toPrecision(12))])
  }
  return levels
}

function ffill(rows, idx) {
  let last = null
  return rows.map((row) => {
    const v = Number(row[idx])
    if (Number.isFinite(v) && v !== 0) last = v
    return last
  })
}

function bondReturn(yPrev, yNow) {
  const y0 = yPrev / 100
  const y1 = yNow / 100
  const duration = 8.8
  return y0 / 12 - duration * (y1 - y0)
}

function parseTfNikkeiMonth(raw) {
  const [ys, ms] = raw.trim().split('.')
  const month = ms === '1' ? 10 : Number(ms)
  return ym(Number(ys), month)
}

function parseMofDate(raw) {
  const m = /^([MTSHR])(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim())
  if (!m) return null
  const era = { M: 1867, T: 1911, S: 1925, H: 1988, R: 2018 }
  const year = era[m[1]] + Number(m[2])
  return { ym: ym(year, Number(m[3])), day: Number(m[4]) }
}

function unzipFirstCsv(url) {
  const zipPath = join(tmpdir(), `hpl-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`)
  execFileSync('curl', ['-fsSL', '-A', UA, '-o', zipPath, url], { stdio: 'pipe' })
  const listing = execFileSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf8' })
  const name = listing
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('__MACOSX'))
  const text = execFileSync('unzip', ['-p', zipPath, name], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return text
}

function splitRow(line) {
  if (line.includes(',')) return line.split(',').map((s) => s.trim())
  return line.trim().split(/\s+/)
}

function parseFrenchIndustryMonthly(text, colName) {
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && !/Average Value Weight(?:ed)? Returns -- Monthly/i.test(lines[i])) i += 1
  if (i >= lines.length) throw new Error('French industry monthly section not found')
  i += 1
  const header = splitRow(lines[i] ?? '')
  const idx = header.findIndex((h) => h.replace(/\s+/g, '') === colName)
  if (idx < 0) throw new Error(`French industry column not found: ${colName} in ${header.join('|')}`)
  const dataOffset = header[0] === '' || /^\d{6}$/.test(header[0]) ? 0 : 1
  i += 1
  const monthly = []
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) break
    const parts = splitRow(line)
    const key = parts[0]
    if (!/^\d{6}$/.test(key)) break
    const v = Number(parts[idx + dataOffset])
    if (!Number.isFinite(v) || v <= -99) continue
    monthly.push([`${key.slice(0, 4)}-${key.slice(4, 6)}`, v / 100])
  }
  return monthly
}

function parseFrenchIndustry(text, colName) {
  return returnsToLevels(parseFrenchIndustryMonthly(text, colName))
}

function equalBlendMonthly(seriesList) {
  const maps = seriesList.map((rows) => new Map(rows))
  const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort()
  return dates.map((d) => [d, maps.reduce((s, m) => s + m.get(d), 0) / maps.length])
}

function monthDelta(a, b) {
  const [y0, m0] = a.split('-').map(Number)
  const [y1, m1] = b.split('-').map(Number)
  return y1 * 12 + m1 - (y0 * 12 + m0)
}

function isMonthlySeries(points) {
  if (points.length < 24) return false
  let ok = 0
  for (let i = 1; i < points.length; i += 1) {
    if (monthDelta(points[i - 1][0], points[i][0]) === 1) ok += 1
  }
  return ok / (points.length - 1) >= 0.9
}

async function yahooMonthEnd(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=max`
  try {
    const json = JSON.parse(await fetchText(url))
    const r = json.chart?.result?.[0]
    const ts = r?.timestamp
    const close = r?.indicators?.adjclose?.[0]?.adjclose ?? r?.indicators?.quote?.[0]?.close
    if (!ts || !close) return []
    const byMonth = new Map()
    for (let i = 0; i < ts.length; i += 1) {
      if (close[i] == null || !(close[i] > 0)) continue
      const d = new Date(ts[i] * 1000)
      byMonth.set(ym(d.getUTCFullYear(), d.getUTCMonth() + 1), close[i])
    }
    return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  } catch {
    return []
  }
}

async function yahooMonthly(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&range=max`
  try {
    const json = JSON.parse(await fetchText(url))
    const r = json.chart?.result?.[0]
    const ts = r?.timestamp
    const close = r?.indicators?.adjclose?.[0]?.adjclose ?? r?.indicators?.quote?.[0]?.close
    if (!ts || !close) return []
    const points = []
    for (let i = 0; i < ts.length; i += 1) {
      if (close[i] == null || !(close[i] > 0)) continue
      const d = new Date(ts[i] * 1000)
      points.push([ym(d.getUTCFullYear(), d.getUTCMonth() + 1), close[i]])
    }
    return points
  } catch {
    return []
  }
}

async function stooqMonthly(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=m`
  try {
    const rows = parseCsv(await fetchText(url)).slice(1)
    return rows
      .map((r) => [r[0].slice(0, 7), Number(r[4] || r[1])])
      .filter(([, v]) => Number.isFinite(v) && v > 0)
  } catch {
    return []
  }
}

function parseFrenchMarket(text) {
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && !/Mkt-RF/i.test(lines[i])) i += 1
  if (i >= lines.length) throw new Error('French header not found')
  i += 1
  const monthly = []
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) break
    const parts = line.split(/[,\s]+/).filter(Boolean)
    const key = parts[0]
    if (!/^\d{6}$/.test(key)) break
    const mktRf = Number(parts[1])
    const rf = Number(parts[parts.length - 1])
    if (!Number.isFinite(mktRf) || !Number.isFinite(rf) || mktRf <= -99 || rf <= -99) continue
    monthly.push([`${key.slice(0, 4)}-${key.slice(4, 6)}`, (mktRf + rf) / 100])
  }
  return returnsToLevels(monthly)
}

function mapFromPairs(pairs) {
  const m = new Map()
  for (const [d, v] of pairs) m.set(d, Number(v))
  return m
}

function blendLevels(aPairs, bPairs, wa, wb, bToAFx = null) {
  const a = mapFromPairs(aPairs)
  const b = mapFromPairs(bPairs)
  const fx = bToAFx ? mapFromPairs(bToAFx) : null
  const dates = [...a.keys()]
    .filter((d) => b.has(d) && (!fx || fx.has(d)))
    .sort()
  if (dates.length < 3) return []
  const monthly = []
  for (let i = 1; i < dates.length; i += 1) {
    const d0 = dates[i - 1]
    const d1 = dates[i]
    const ra = a.get(d1) / a.get(d0) - 1
    let rb = b.get(d1) / b.get(d0) - 1
    if (fx) {
      const fx0 = fx.get(d0)
      const fx1 = fx.get(d1)
      if (!fx0 || !fx1) continue
      rb = (b.get(d1) / fx1) / (b.get(d0) / fx0) - 1
    }
    monthly.push([d1, wa * ra + wb * rb])
  }
  return returnsToLevels(monthly)
}

const assets = []

function addAsset(a) {
  a.points = a.points.filter(([, v]) => Number.isFinite(v) && v > 0)
  if (a.points.length < 24) {
    console.warn('skip short series', a.id, a.points.length)
    return
  }
  assets.push(a)
}

console.log('Downloading public series…')

const [spCsv, goldCsv, fxCsv, nikkeiOld, nikkeiNew, jgbText, oilCsv] = await Promise.all([
  fetchText('https://raw.githubusercontent.com/datasets/s-and-p-500/master/data/data.csv'),
  fetchText('https://raw.githubusercontent.com/datasets/gold-prices/master/data/monthly.csv'),
  fetchText('https://raw.githubusercontent.com/datasets/exchange-rates/master/data/monthly.csv'),
  fetchText('https://topforeignstocks.com/wp-content/uploads/2013/03/Japan-Nikkei-225-mothly.csv'),
  fetchText('https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_monthly_jp.csv', 'shift_jis'),
  fetchText('https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv', 'shift_jis'),
  fetchText('https://raw.githubusercontent.com/datasets/oil-prices/master/data/brent-monthly.csv'),
])

const frenchDev = unzipFirstCsv(
  'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Developed_3_Factors_CSV.zip',
)
const frenchDevExUs = unzipFirstCsv(
  'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Developed_ex_US_3_Factors_CSV.zip',
)
const frenchJapan = unzipFirstCsv(
  'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Japan_3_Factors_CSV.zip',
)
const french49 = unzipFirstCsv(
  'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/49_Industry_Portfolios_CSV.zip',
)
const frenchEm = unzipFirstCsv(
  'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Emerging_5_Factors_CSV.zip',
)
const frenchMe = unzipFirstCsv(
  'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Portfolios_Formed_on_ME_CSV.zip',
)

const spRows = parseCsv(spCsv)
const spHeader = spRows[0]
const spData = spRows.slice(1).filter((r) => r[0] && Number(r[1]) > 0)
const spDateIdx = 0
const spPxIdx = spHeader.indexOf('SP500')
const spDivIdx = spHeader.indexOf('Dividend')
const spRateIdx = spHeader.indexOf('Long Interest Rate')
const divs = ffill(spData, spDivIdx)
const rates = ffill(spData, spRateIdx)

const spTr = []
const usBond = []
for (let i = 1; i < spData.length; i += 1) {
  const date = spData[i][spDateIdx].slice(0, 7)
  const px0 = Number(spData[i - 1][spPxIdx])
  const px1 = Number(spData[i][spPxIdx])
  const div = (divs[i] ?? divs[i - 1] ?? 0) / 12
  if (px0 > 0 && px1 > 0) spTr.push([date, (px1 - px0 + div) / px0])
  const y0 = rates[i - 1]
  const y1 = rates[i]
  if (y0 != null && y1 != null) usBond.push([date, bondReturn(y0, y1)])
}

const spLevels = returnsToLevels(spTr)
const usBondLevels = returnsToLevels(usBond)

const goldLevels = parseCsv(goldCsv)
  .slice(1)
  .map((r) => [r[0].slice(0, 7), Number(r[1])])
  .filter(([, v]) => v > 0)

const oilLevels = parseCsv(oilCsv)
  .slice(1)
  .map((r) => [r[0].slice(0, 7), Number(r[1])])
  .filter(([, v]) => v > 0)

const fxLevels = parseCsv(fxCsv)
  .slice(1)
  .filter((r) => r[1] === 'Japan')
  .map((r) => [r[0].slice(0, 7), Number(r[2])])
  .filter(([, v]) => v > 0)

const nikkeiMap = new Map()
for (const line of nikkeiOld.split(/\r?\n/)) {
  const m = line.match(/^(\d{4}\.\d{1,2}),,\s*([0-9.]+)/)
  if (!m) continue
  nikkeiMap.set(parseTfNikkeiMonth(m[1]), Number(m[2]))
}
for (const line of nikkeiNew.split(/\r?\n/)) {
  const m = line.match(/"?(\d{4})\/(\d{2})\/(\d{2})"?\s*,\s*"?([0-9.]+)/)
  if (!m) continue
  nikkeiMap.set(ym(Number(m[1]), Number(m[2])), Number(m[4]))
}

const japanFfLevels = parseFrenchMarket(frenchJapan)
const japanFf = mapFromPairs(japanFfLevels)
const nikkeiDates = [...nikkeiMap.keys()].sort()
const nikkeiFilled = new Map(nikkeiMap)
for (let i = 1; i < nikkeiDates.length; i += 1) {
  const prev = nikkeiDates[i - 1]
  const next = nikkeiDates[i]
  const [py, pm] = prev.split('-').map(Number)
  const [ny, nm] = next.split('-').map(Number)
  const gap = ny * 12 + nm - (py * 12 + pm)
  if (gap <= 1) continue
  let cursorY = py
  let cursorM = pm
  let level = nikkeiMap.get(prev)
  for (let g = 1; g < gap; g += 1) {
    cursorM += 1
    if (cursorM > 12) {
      cursorM = 1
      cursorY += 1
    }
    const d = ym(cursorY, cursorM)
    const prevD = ym(cursorM === 1 ? cursorY - 1 : cursorY, cursorM === 1 ? 12 : cursorM - 1)
    const a = japanFf.get(prevD)
    const b = japanFf.get(d)
    if (a && b && a > 0) level *= b / a
    nikkeiFilled.set(d, level)
  }
}
const nikkeiLevels = [...nikkeiFilled.entries()].sort((a, b) => a[0].localeCompare(b[0]))

const jgbMonthEnd = new Map()
for (const line of jgbText.split(/\r?\n/)) {
  const cols = line.split(',')
  const parsed = parseMofDate(cols[0] ?? '')
  if (!parsed) continue
  const y10 = Number(cols[10])
  if (!Number.isFinite(y10)) continue
  jgbMonthEnd.set(parsed.ym, y10)
}
const jgbYields = [...jgbMonthEnd.entries()].sort((a, b) => a[0].localeCompare(b[0]))
const jgbTr = []
for (let i = 1; i < jgbYields.length; i += 1) {
  jgbTr.push([jgbYields[i][0], bondReturn(jgbYields[i - 1][1], jgbYields[i][1])])
}
const jgbLevels = returnsToLevels(jgbTr)

const jgb1yMonthEnd = new Map()
for (const line of jgbText.split(/\r?\n/)) {
  const cols = line.split(',')
  const parsed = parseMofDate(cols[0] ?? '')
  if (!parsed) continue
  const y1 = Number(cols[1])
  const y2 = Number(cols[2])
  const y = Number.isFinite(y1) ? y1 : Number.isFinite(y2) ? y2 : null
  if (y == null) continue
  jgb1yMonthEnd.set(parsed.ym, y)
}
const jgb1yYields = [...jgb1yMonthEnd.entries()].sort((a, b) => a[0].localeCompare(b[0]))
if (jgb1yYields.length) {
  let [y, m] = jgb1yYields[0][0].split('-').map(Number)
  const [ey, em] = jgb1yYields.at(-1)[0].split('-').map(Number)
  let last = jgb1yYields[0][1]
  while (y * 12 + m <= ey * 12 + em) {
    const d = ym(y, m)
    if (jgb1yMonthEnd.has(d)) last = jgb1yMonthEnd.get(d)
    else jgb1yMonthEnd.set(d, last)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
}
const jgb1yFilled = [...jgb1yMonthEnd.entries()].sort((a, b) => a[0].localeCompare(b[0]))
const jpyStTr = []
for (let i = 1; i < jgb1yFilled.length; i += 1) {
  jpyStTr.push([jgb1yFilled[i][0], jgb1yFilled[i - 1][1] / 100 / 12])
}
const jpyStLevels = returnsToLevels(jpyStTr)

const developed = parseFrenchMarket(frenchDev)
const developedExUs = parseFrenchMarket(frenchDevExUs)
const emerging = parseFrenchMarket(frenchEm)
const usSmall = parseFrenchIndustry(frenchMe, 'Lo30')
const world = blendLevels(spLevels, developedExUs, 0.6, 0.4)
const developedBonds = blendLevels(usBondLevels, jgbLevels, 0.7, 0.3, fxLevels)

const cashStart = '1970-01'
const cashEnd = '2026-08'
const cash = []
{
  let level = 100
  let [y, m] = cashStart.split('-').map(Number)
  const [ey, em] = cashEnd.split('-').map(Number)
  while (y * 12 + m <= ey * 12 + em) {
    cash.push([ym(y, m), level])
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
}

addAsset({
  id: 'n225',
  symbol: 'NKY',
  name: '日経225',
  assetClass: 'equity',
  region: 'japan',
  currency: 'JPY',
  returnType: 'price',
  source: 'Nikkei monthly close (historical compilation + official monthly). 2014-06〜2015-12 は日本市場リターンで補完。',
  points: nikkeiLevels,
})

addAsset({
  id: 'topix',
  symbol: 'TOPIX',
  name: 'TOPIX相当（日本市場）',
  assetClass: 'equity',
  region: 'japan',
  currency: 'USD',
  returnType: 'total',
  source: 'Ken French Japan market (Mkt-RF + RF), USD. JPY換算は Unhedged。',
  points: japanFfLevels,
})

addAsset({
  id: 'sp500',
  symbol: 'SPX',
  name: 'S&P500',
  assetClass: 'equity',
  region: 'us',
  currency: 'USD',
  returnType: 'total',
  source: 'Shiller S&P 500 (price + dividend/12). 直近の配当は前方補完。',
  points: spLevels,
})

addAsset({
  id: 'world',
  symbol: 'ACWI',
  name: '全世界株式',
  assetClass: 'equity',
  region: 'world',
  currency: 'USD',
  returnType: 'total',
  source: 'S&P500 60% + Developed ex-US (Ken French) 40%。新興国は未反映。',
  points: world,
})

addAsset({
  id: 'developed',
  symbol: 'DEV',
  name: '先進国株式',
  assetClass: 'equity',
  region: 'developed',
  currency: 'USD',
  returnType: 'total',
  source: 'Ken French Developed market (Mkt-RF + RF).',
  points: developed,
})

addAsset({
  id: 'em',
  symbol: 'EM',
  name: '新興国株式',
  assetClass: 'equity',
  region: 'world',
  currency: 'USD',
  returnType: 'total',
  source: 'Ken French Emerging Markets 5 Factors の Mkt-RF + RF。USD、配当込み。1989〜。',
  points: emerging,
})

addAsset({
  id: 'ussmall',
  symbol: 'IWM',
  name: '米国小型株',
  assetClass: 'equity',
  region: 'us',
  currency: 'USD',
  returnType: 'total',
  source: 'Ken French Portfolios Formed on ME の Lo 30（時価総額下位30%、value-weighted monthly total return, USD）。',
  points: usSmall,
})

addAsset({
  id: 'jgb',
  symbol: 'JGB10',
  name: '日本国債',
  assetClass: 'bond',
  region: 'japan',
  currency: 'JPY',
  returnType: 'total',
  source: '財務省 国債金利情報 10年。Duration 8.8 の定数満期近似トータルリターン。',
  points: jgbLevels,
})

addAsset({
  id: 'devbond',
  symbol: 'WGBI',
  name: '先進国債券',
  assetClass: 'bond',
  region: 'developed',
  currency: 'USD',
  returnType: 'total',
  source: '米国10年TR 70% + 日本国債TR 30% の月次リターン合成。',
  points: developedBonds,
})

addAsset({
  id: 'ust',
  symbol: 'US10Y',
  name: '米国債',
  assetClass: 'bond',
  region: 'us',
  currency: 'USD',
  returnType: 'total',
  source: 'Shiller long interest rate から 10年定数満期債券TRを近似。',
  points: usBondLevels,
})

addAsset({
  id: 'jpy_cash',
  symbol: 'CASH',
  name: '円預金',
  assetClass: 'cash',
  region: 'japan',
  currency: 'JPY',
  returnType: 'total',
  source: 'MVP: 0% / 0 vol。金利ゼロの比較用。',
  points: cash,
})

addAsset({
  id: 'jpy_st',
  symbol: 'JPY1Y',
  name: '円短期金利',
  assetClass: 'cash',
  region: 'japan',
  currency: 'JPY',
  returnType: 'total',
  source: '財務省 国債金利情報の1年（欠落時は2年）。前月末利回り/12 の短期金利近似。価格変動は未反映。',
  points: jpyStLevels,
})

addAsset({
  id: 'gold',
  symbol: 'XAU',
  name: '金',
  assetClass: 'commodity',
  region: 'world',
  currency: 'USD',
  returnType: 'price',
  source: 'datahub/datasets gold-prices monthly USD.',
  points: goldLevels,
})

addAsset({
  id: 'oil',
  symbol: 'BRENT',
  name: '原油',
  assetClass: 'commodity',
  region: 'world',
  currency: 'USD',
  returnType: 'price',
  source: 'datahub/datasets oil-prices Brent monthly USD。スポット価格（Price Return）。ロールコスト・保管コストは未反映。',
  points: oilLevels,
})

const usReitLevels = parseFrenchIndustry(french49, 'RlEst')
addAsset({
  id: 'usreit',
  symbol: 'VNQ',
  name: '米国リート',
  assetClass: 'reit',
  region: 'us',
  currency: 'USD',
  returnType: 'total',
  source:
    'Ken French 49 Industry Portfolios の RlEst（value-weighted monthly total return, USD）。REITに加え米不動産株を含む。配当込み。',
  points: usReitLevels,
})

let jreitLevels = await yahooMonthly('1343.T')
let jreitSource = 'NEXT FUNDS 東証REIT指数連動上場投信（1343）Yahoo Finance 月次調整後終値。分配金再投資込み。'
if (jreitLevels.length < 24) {
  jreitLevels = await yahooMonthly('1597.T')
  jreitSource = 'MAXIS トピックス・リート上場投信（1597）Yahoo Finance 月次調整後終値。分配金再投資込み。'
}
let jreitReturn = 'total'
if (jreitLevels.length < 24) {
  jreitLevels = await stooqMonthly('1343.jp')
  jreitSource = '東証REIT連動ETF（1343）Stooq 月次終値。分配金再投資は未反映の可能性あり。'
  jreitReturn = 'price'
}
addAsset({
  id: 'jreit',
  symbol: 'TSE REIT',
  name: '東証REIT',
  assetClass: 'reit',
  region: 'japan',
  currency: 'JPY',
  returnType: jreitReturn,
  source: jreitSource,
  points: jreitLevels,
})

let nasdaqLevels = await yahooMonthEnd('^NDX')
let nasdaqSource = 'NASDAQ-100（^NDX）Yahoo Finance 週次終値を月末化。Price Return。'
let nasdaqReturn = 'price'
if (!isMonthlySeries(nasdaqLevels)) {
  nasdaqLevels = await stooqMonthly('^ndx')
  nasdaqSource = 'NASDAQ-100（^ndx）Stooq 月次終値。Price Return。'
  nasdaqReturn = 'price'
}
if (!isMonthlySeries(nasdaqLevels)) {
  const tech = equalBlendMonthly([
    parseFrenchIndustryMonthly(french49, 'Hardw'),
    parseFrenchIndustryMonthly(french49, 'Softw'),
    parseFrenchIndustryMonthly(french49, 'Chips'),
  ])
  nasdaqLevels = returnsToLevels(tech)
  nasdaqSource =
    'NASDAQ指数の月次が取れなかったため、Ken French 49業種の Hardw / Softw / Chips を均等合成（米ハイテク株 TR）。NASDAQ-100そのものではない。'
  nasdaqReturn = 'total'
}
addAsset({
  id: 'nasdaq',
  symbol: 'NDX',
  name: 'NASDAQ相当',
  assetClass: 'equity',
  region: 'us',
  currency: 'USD',
  returnType: nasdaqReturn,
  source: nasdaqSource,
  points: nasdaqLevels,
})

const payload = {
  meta: {
    fetchedAt: new Date().toISOString().slice(0, 10),
    notes: [
      '外国資産は基準通貨へ Unhedged 換算する。',
      '売買コスト 0%、税引前、名目リターン。',
      '指数によって Price Return / Total Return が異なる。画面の表示を確認すること。',
    ],
  },
  fx: { USDJPY: fxLevels },
  assets,
}

mkdirSync(join(ROOT, 'src/data'), { recursive: true })
writeFileSync(OUT, JSON.stringify(payload))
const bytes = Buffer.byteLength(JSON.stringify(payload))
console.log(`Wrote ${OUT} (${(bytes / 1024).toFixed(1)} KB, ${assets.length} assets)`)
for (const a of assets) {
  console.log(`  ${a.id.padEnd(12)} ${a.points[0][0]} → ${a.points.at(-1)[0]}  n=${a.points.length}`)
}
console.log(`  USDJPY       ${fxLevels[0][0]} → ${fxLevels.at(-1)[0]}  n=${fxLevels.length}`)
