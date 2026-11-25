import { describe, expect, it } from 'vitest'

import { estimateNote, estimateNotice } from './waitEstimate'

const basis = (trainingOrders: number, maeMinutes: number | null = null) => ({
  method: 'bayesian-linear-regression' as const,
  trainingOrders,
  maeMinutes,
  baselineMaeMinutes: null,
})

describe('estimateNote', () => {
  it('is upfront that a brand-new shop is on typical speeds, not learned yet', () => {
    expect(estimateNote(basis(0))).toMatch(/typical print speeds/)
    expect(estimateNote(basis(0))).toMatch(/gets sharper/)
  })

  it('says how many orders it learned from, singular and plural', () => {
    expect(estimateNote(basis(1))).toBe('AI estimate learned from 1 recent order at this shop.')
    expect(estimateNote(basis(37))).toBe('AI estimate learned from 37 recent orders at this shop.')
  })

  it('includes the measured typical error once it can be measured', () => {
    expect(estimateNote(basis(37, 1.4))).toBe(
      'AI estimate learned from 37 recent orders at this shop, typically within ±1.4 min.',
    )
  })

  it('falls back gracefully when there is no basis', () => {
    expect(estimateNote(null)).toBe('Wait is an estimate.')
  })
})

describe('estimateNotice', () => {
  it('explains a delay instead of showing a number', () => {
    const notice = estimateNotice('delayed')
    expect(notice?.title).toBe('Taking longer than usual')
    expect(notice?.body).toMatch(/updates by itself/)
  })

  it('explains an idle shop and reassures that the place in line is unchanged', () => {
    const notice = estimateNotice('stalled')
    expect(notice?.title).toBe('Waiting for the shop to start')
    expect(notice?.body).toMatch(/unchanged/)
  })

  it('shows nothing when all is normal, switched off, or not applicable', () => {
    expect(estimateNotice('normal')).toBeNull()
    expect(estimateNotice('disabled')).toBeNull()
    expect(estimateNotice(null)).toBeNull()
  })
})
