import type { Currency } from './types'
import { amountExact, amountPrimary } from './format'

export function Amount({
  n,
  currency,
  size = 'md',
  suffix,
  exact = true,
}: {
  n: number
  currency: Currency
  size?: 'hero' | 'lg' | 'md' | 'sm'
  suffix?: string
  exact?: boolean
}) {
  const primary = amountPrimary(n, currency)
  const secondary = amountExact(n, currency)
  const showExact = exact && secondary && secondary !== primary
  const primaryClass =
    size === 'hero'
      ? 'text-4xl font-semibold tracking-tight sm:text-5xl'
      : size === 'lg'
        ? 'text-2xl font-semibold tracking-tight'
        : size === 'md'
          ? 'text-xl font-semibold tracking-tight'
          : 'text-base font-semibold'
  return (
    <span className="inline-block">
      <span className={`tabular-nums text-stone-900 ${primaryClass}`}>
        {primary}
        {suffix ? <span className="ml-1 text-[0.55em] font-medium text-stone-500">{suffix}</span> : null}
      </span>
      {showExact && size !== 'sm' && (
        <span className="mt-0.5 block text-xs tabular-nums text-stone-500">{secondary}</span>
      )}
    </span>
  )
}
