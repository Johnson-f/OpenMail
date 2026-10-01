import { describe, expect, it } from 'vitest'
import { occurrencesBetween, zonedTimeToInstant } from './recurrence'

const wall = (...fields: [number, number, number, number, number]) =>
  new Date(Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4]))
const iso = (date: Date) => date.toISOString()

describe('zonedTimeToInstant', () => {
  it('converts ordinary wall-clock times', () => {
    expect(iso(zonedTimeToInstant(wall(2026, 3, 6, 9, 0), 'America/New_York'))).toBe('2026-03-06T14:00:00.000Z')
    expect(iso(zonedTimeToInstant(wall(2026, 3, 9, 9, 0), 'America/New_York'))).toBe('2026-03-09T13:00:00.000Z')
    expect(iso(zonedTimeToInstant(wall(2026, 7, 1, 9, 0), 'Africa/Lagos'))).toBe('2026-07-01T08:00:00.000Z')
    expect(iso(zonedTimeToInstant(wall(2026, 7, 1, 9, 0), 'UTC'))).toBe('2026-07-01T09:00:00.000Z')
  })

  it('moves a time skipped by a DST change forward', () => {
    expect(iso(zonedTimeToInstant(wall(2026, 3, 8, 2, 30), 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z')
  })

  it('takes the earlier instant for a time that happens twice', () => {
    expect(iso(zonedTimeToInstant(wall(2026, 11, 1, 1, 30), 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z')
  })

  it('handles southern-hemisphere zones', () => {
    expect(iso(zonedTimeToInstant(wall(2026, 1, 15, 9, 0), 'Pacific/Auckland'))).toBe('2026-01-14T20:00:00.000Z')
    expect(iso(zonedTimeToInstant(wall(2026, 6, 15, 9, 0), 'Pacific/Auckland'))).toBe('2026-06-14T21:00:00.000Z')
  })
})

describe('occurrencesBetween', () => {
  const anchor = new Date('2026-03-05T12:00:00Z')

  it('ignores DTSTART and TZID in the rule', () => {
    const rule = 'DTSTART;TZID=Asia/Tokyo:20200101T030000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
    const found = occurrencesBetween(rule, 'America/New_York', anchor, anchor, new Date('2026-03-07T00:00:00Z'))
    expect(found.map(iso)).toEqual(['2026-03-05T14:00:00.000Z', '2026-03-06T14:00:00.000Z'])
  })

  it('treats the lower bound as exclusive and the upper bound as inclusive', () => {
    const rule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
    const found = occurrencesBetween(rule, 'UTC', anchor, new Date('2026-03-06T09:00:00Z'), new Date('2026-03-07T09:00:00Z'))
    expect(found.map(iso)).toEqual(['2026-03-07T09:00:00.000Z'])
  })
})
