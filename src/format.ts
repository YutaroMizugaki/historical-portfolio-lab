import type { Currency } from './types'

export function money(n: number, currency: Currency): string {
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat(currency === 'JPY' ? 'ja-JP' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(n)
}

/** Glanceable amount: 1,425万円 / $142,500 */
export function amountPrimary(n: number, currency: Currency): string {
  if (!Number.isFinite(n)) return '—'
  if (currency === 'JPY') {
    if (Math.abs(n) < 10_000) return `${Math.round(n).toLocaleString('ja-JP')}円`
    const man = n / 10_000
    const digits = Math.abs(man) >= 100 ? 0 : 1
    return `${man.toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: 0 })}万円`
  }
  if (Math.abs(n) >= 1_000_000) {
    return `$${(n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`
  }
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export function amountExact(n: number, currency: Currency): string {
  if (!Number.isFinite(n)) return ''
  if (currency === 'JPY') return `${Math.round(n).toLocaleString('ja-JP')}円`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export function signedAmount(n: number, currency: Currency): string {
  const abs = amountPrimary(Math.abs(n), currency)
  if (n > 0) return `+${abs}`
  if (n < 0) return `−${abs}`
  return abs
}

export function pct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

export function ymLabel(ym: string): string {
  if (!ym) return '—'
  return ym.replace('-', '/')
}

export function yearLabel(ym: string): string {
  if (!ym) return '—'
  return `${ym.slice(0, 4)}年`
}
