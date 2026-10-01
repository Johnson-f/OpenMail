import { rrulestr } from 'rrule'

const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, found)
  }
  return found
}

function wallClockOf(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {}
  const field = (type: string) => parts[type] ?? 0
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'))
}

function offsetAt(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000
  return wallClockOf(whole, timeZone) - whole
}

export function instantToWallClock(instant: Date, timeZone: string): Date {
  return new Date(wallClockOf(instant.getTime(), timeZone) + (instant.getTime() % 1000))
}

/**
 * Converts wall-clock fields (carried in the UTC fields of `wall`) in `timeZone` to an instant.
 * A time skipped by a DST change moves forward; a time that happens twice resolves to the earlier one.
 */
export function zonedTimeToInstant(wall: Date, timeZone: string): Date {
  const wallMs = wall.getTime()
  const offsets = new Set([offsetAt(wallMs - DAY_MS, timeZone), offsetAt(wallMs + DAY_MS, timeZone)])
  const valid = [...offsets]
    .map((offset) => wallMs - offset)
    .filter((candidate) => offsetAt(candidate, timeZone) === wallMs - candidate)
  if (valid.length > 0) return new Date(Math.min(...valid))
  const before = offsetAt(wallMs - DAY_MS, timeZone)
  return new Date(wallMs - before)
}

function ruleLines(rule: string): string {
  return rule
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^DTSTART/i.test(line))
    .map((line) => line.replace(/;?TZID=[^;:]*/gi, ''))
    .join('\n')
}

export function parseRecurrence(rule: string, dtstart: Date) {
  return rrulestr(ruleLines(rule), { dtstart })
}

/** Occurrences of `rule` in (afterExclusive, untilInclusive], with wall-clock times read in `timeZone`. */
export function occurrencesBetween(
  rule: string,
  timeZone: string,
  anchor: Date,
  afterExclusive: Date,
  untilInclusive: Date,
): Date[] {
  const recurrence = parseRecurrence(rule, instantToWallClock(anchor, timeZone))
  const from = new Date(instantToWallClock(afterExclusive, timeZone).getTime() - DAY_MS)
  const to = new Date(instantToWallClock(untilInclusive, timeZone).getTime() + DAY_MS)
  return recurrence
    .between(from, to, true)
    .map((wall) => zonedTimeToInstant(wall, timeZone))
    .filter((instant) => instant > afterExclusive && instant <= untilInclusive && instant >= anchor)
    .sort((a, b) => a.getTime() - b.getTime())
}
