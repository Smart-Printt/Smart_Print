// Smallest "nice" axis maximum >= value, from {2,4,6,8,10} x 10^k, so the
// middle gridline is a whole number too (counts never show 0.5 orders).
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 2) return 2
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 4, 6, 8, 10]) {
    if (step * magnitude >= value) return Math.max(step * magnitude, 2)
  }
  return 10 * magnitude
}
