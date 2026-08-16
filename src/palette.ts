/** Colors for the long-horizon core six, keyed by asset id. */
export const CORE_COLORS: Record<string, string> = {
  developed: '#2f6f5e',
  em: '#3d8ea8',
  jgb: '#6b7c8a',
  ust: '#3f5c8a',
  jpy_st: '#a8a29e',
  gold: '#c9a227',
}

export function allocColor(id: string, index: number): string {
  return CORE_COLORS[id] ?? ALLOC_COLORS[index % ALLOC_COLORS.length]!
}

export const ALLOC_COLORS = [
  '#3f6b58',
  '#c4a35a',
  '#4c6b8a',
  '#b4533a',
  '#6b5b8a',
  '#7a8f4c',
  '#8a5a3c',
  '#2f4f4f',
  '#9a7b4f',
  '#5c6e58',
  '#6a7c8a',
  '#a67c52',
  '#4f6f8a',
  '#8c6b4a',
  '#5a7a6a',
  '#7b5e78',
  '#6e7a4e',
]
