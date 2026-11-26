// 0..23 -> "12 AM" / "9 AM" / "3 PM"; short form "12am" for tight axes.
export function hourLabel(hour: number, short = false): string {
  const suffix = hour < 12 ? 'AM' : 'PM'
  const h = hour % 12 === 0 ? 12 : hour % 12
  return short ? `${h}${suffix.toLowerCase()}` : `${h} ${suffix}`
}
