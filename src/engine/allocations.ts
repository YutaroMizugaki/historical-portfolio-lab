export function countAllocations(
  n: number,
  units: number,
  mins: number[],
  maxs: number[],
): number {
  const cap = units + 1
  let dp = new Uint32Array(cap)
  let next = new Uint32Array(cap)
  dp[0] = 1
  for (let i = 0; i < n; i += 1) {
    next.fill(0)
    const lo = mins[i]
    const hi = maxs[i]
    for (let s = 0; s <= units; s += 1) {
      const ways = dp[s]
      if (!ways) continue
      const from = s + lo
      const to = Math.min(units, s + hi)
      for (let t = from; t <= to; t += 1) next[t] += ways
    }
    const tmp = dp
    dp = next
    next = tmp
  }
  return dp[units] || 0
}

export function forEachAllocation(
  n: number,
  units: number,
  mins: number[],
  maxs: number[],
  visit: (unitsOut: Int16Array) => void,
): void {
  const w = new Int16Array(n)
  const minRest = new Int16Array(n + 1)
  const maxRest = new Int16Array(n + 1)
  for (let i = n - 1; i >= 0; i -= 1) {
    minRest[i] = minRest[i + 1] + mins[i]
    maxRest[i] = maxRest[i + 1] + maxs[i]
  }

  const rec = (i: number, remaining: number) => {
    if (i === n - 1) {
      if (remaining >= mins[i] && remaining <= maxs[i]) {
        w[i] = remaining
        visit(w)
      }
      return
    }
    const lo = Math.max(mins[i], remaining - maxRest[i + 1])
    const hi = Math.min(maxs[i], remaining - minRest[i + 1])
    for (let u = lo; u <= hi; u += 1) {
      w[i] = u
      rec(i + 1, remaining - u)
    }
  }
  rec(0, units)
}

export function clipBounds(
  n: number,
  units: number,
  minPct: number[],
  maxPct: number[],
  stepPct: number,
): { mins: number[]; maxs: number[] } {
  const mins = minPct.map((p) => Math.max(0, Math.ceil(p / stepPct)))
  const maxs = maxPct.map((p) => Math.min(units, Math.floor(p / stepPct)))
  for (let i = 0; i < n; i += 1) {
    if (mins[i] > maxs[i]) maxs[i] = mins[i]
  }
  return { mins, maxs }
}
