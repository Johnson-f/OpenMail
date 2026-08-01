import { describe, it, expect } from 'vitest'
import { displayName } from './messages'

describe('displayName', () => {
  it('prefers the display name over the address', () => {
    expect(displayName('Ameet Rai <a@x.com>')).toBe('Ameet Rai')
  })

  it('strips the quotes RFC syntax requires around a name with a comma', () => {
    expect(displayName('"Doe, John" <j@x.com>')).toBe('Doe, John')
  })

  it('keeps parenthetical suffixes, which senders use meaningfully', () => {
    expect(displayName('"Ameet Rai (JIRA)" <a@x.com>')).toBe('Ameet Rai (JIRA)')
  })

  it('falls back to the address when there is no display name', () => {
    expect(displayName('<a@x.com>')).toBe('a@x.com')
    expect(displayName('a@x.com')).toBe('a@x.com')
  })

  it('trims surrounding whitespace', () => {
    expect(displayName('  Ameet Rai  <a@x.com>  ')).toBe('Ameet Rai')
  })

  it('returns empty string for an empty header rather than throwing', () => {
    expect(displayName('')).toBe('')
  })
})
