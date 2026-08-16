import type { Currency } from '../types'

/** Economic currency exposure (not the quote currency of the raw series). */
export function exposureOf(id: string, quote: Currency): Currency {
  const map: Record<string, Currency> = {
    n225: 'JPY',
    topix: 'JPY',
    sp500: 'USD',
    world: 'USD',
    developed: 'USD',
    jgb: 'JPY',
    devbond: 'USD',
    ust: 'USD',
    jpy_cash: 'JPY',
    gold: 'USD',
    usreit: 'USD',
    jreit: 'JPY',
    em: 'USD',
    ussmall: 'USD',
    nasdaq: 'USD',
    oil: 'USD',
    jpy_st: 'JPY',
  }
  return map[id] ?? quote
}
