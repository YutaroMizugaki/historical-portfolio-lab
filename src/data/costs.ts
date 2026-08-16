/** Annual expense ratios (信託報酬, 税込目安) for typical Japan-listed index funds / ETFs. */
export const DEFAULT_TER: Record<string, number> = {
  n225: 0.00121,
  topix: 0.000858,
  sp500: 0.0009375,
  world: 0.0005775,
  developed: 0.0009889,
  jgb: 0.00132,
  devbond: 0.00154,
  ust: 0.0015,
  jpy_cash: 0,
  gold: 0.0044,
  usreit: 0.0012,
  jreit: 0.0022,
  em: 0.001518,
  ussmall: 0.00198,
  nasdaq: 0.000998,
  oil: 0.0085,
  jpy_st: 0,
}

export const TOKUTEI_TAX = 0.20315

export function defaultTer(id: string): number {
  return DEFAULT_TER[id] ?? 0.001
}
