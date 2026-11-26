import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { hourLabel } from '@/utils/hours'
import { ColumnChart } from './ColumnChart'
import { RankedBars } from './RankedBars'
import { niceMax } from './scale'

describe('niceMax', () => {
  it('never goes below 2, so a near-empty chart still has whole-number gridlines', () => {
    expect(niceMax(0)).toBe(2)
    expect(niceMax(1)).toBe(2)
    expect(niceMax(2)).toBe(2)
  })

  it('rounds up to a clean number whose midpoint is also whole', () => {
    expect(niceMax(3)).toBe(4)
    expect(niceMax(5)).toBe(6)
    expect(niceMax(7)).toBe(8)
    expect(niceMax(9)).toBe(10)
    expect(niceMax(11)).toBe(20)
    expect(niceMax(37)).toBe(40)
    expect(niceMax(101)).toBe(200)
    expect(niceMax(980)).toBe(1000)
    for (const v of [1, 3, 5, 11, 37, 99, 101, 640, 1234]) {
      expect(niceMax(v) / 2).toBe(Math.round(niceMax(v) / 2))
      expect(niceMax(v)).toBeGreaterThanOrEqual(v)
    }
  })

  it('survives non-finite input', () => {
    expect(niceMax(Number.NaN)).toBe(2)
    expect(niceMax(Number.POSITIVE_INFINITY)).toBe(2)
  })
})

describe('hourLabel', () => {
  it('formats midnight, noon and the rest', () => {
    expect(hourLabel(0)).toBe('12 AM')
    expect(hourLabel(9)).toBe('9 AM')
    expect(hourLabel(12)).toBe('12 PM')
    expect(hourLabel(15)).toBe('3 PM')
    expect(hourLabel(15, true)).toBe('3pm')
    expect(hourLabel(23)).toBe('11 PM')
  })
})

const DATA = [
  { key: 'a', label: 'Mon', fullLabel: 'Monday', value: 3 },
  { key: 'b', label: 'Tue', fullLabel: 'Tuesday', value: 0 },
  { key: 'c', label: 'Wed', fullLabel: 'Wednesday', value: 7 },
]

describe('ColumnChart', () => {
  it('gives every column an accessible name with its value', () => {
    render(<ColumnChart data={DATA} unit="orders" ariaLabel="Orders per day" />)
    expect(screen.getByLabelText('Monday: 3 orders')).toBeInTheDocument()
    expect(screen.getByLabelText('Tuesday: 0 orders')).toBeInTheDocument()
    expect(screen.getByLabelText('Wednesday: 7 orders')).toBeInTheDocument()
  })

  it('shows a tooltip on hover and on keyboard focus, and hides it afterwards', () => {
    render(<ColumnChart data={DATA} unit="orders" ariaLabel="Orders per day" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    const wednesday = screen.getByLabelText('Wednesday: 7 orders')
    fireEvent.pointerEnter(wednesday)
    expect(screen.getByRole('status')).toHaveTextContent('7')
    expect(screen.getByRole('status')).toHaveTextContent('Wednesday')
    fireEvent.pointerLeave(wednesday)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    fireEvent.focus(screen.getByLabelText('Monday: 3 orders'))
    expect(screen.getByRole('status')).toHaveTextContent('Monday')
    fireEvent.blur(screen.getByLabelText('Monday: 3 orders'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('labels only every n-th x tick so labels never collide', () => {
    render(<ColumnChart data={DATA} unit="orders" ariaLabel="x" labelEvery={2} />)
    expect(screen.getByText('Mon')).toBeInTheDocument()
    expect(screen.queryByText('Tue')).not.toBeInTheDocument()
    expect(screen.getByText('Wed')).toBeInTheDocument()
  })

  it('renders an all-zero series without breaking', () => {
    render(<ColumnChart data={DATA.map((d) => ({ ...d, value: 0 }))} unit="orders" ariaLabel="empty" />)
    expect(screen.getByLabelText('Monday: 0 orders')).toBeInTheDocument()
  })
})

describe('RankedBars', () => {
  it('lists each row with its figure and detail', () => {
    render(
      <RankedBars
        unit="orders"
        ariaLabel="Orders per shop"
        rows={[
          { key: '1', name: 'G Block', value: 12, detail: '₹240.00 paid' },
          { key: '2', name: 'Library', value: 0 },
        ]}
      />,
    )
    expect(screen.getByText('G Block')).toBeInTheDocument()
    expect(screen.getByText('₹240.00 paid')).toBeInTheDocument()
    expect(screen.getByText('Library')).toBeInTheDocument()
  })
})
