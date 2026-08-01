import { describe, it, expect } from 'vitest'
import { splitAddresses } from './client'

describe('splitAddresses', () => {
  it('splits plain comma-separated addresses', () => {
    expect(splitAddresses('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com'])
  })

  it('keeps a quoted display name containing a comma intact', () => {
    expect(splitAddresses('"Doe, John" <j@x.com>, b@y.com')).toEqual([
      '"Doe, John" <j@x.com>',
      'b@y.com',
    ])
  })

  it('handles several quoted names with commas', () => {
    expect(
      splitAddresses('"Smith, Jane" <j@a.com>, "Wu, Li" <l@b.com>'),
    ).toEqual(['"Smith, Jane" <j@a.com>', '"Wu, Li" <l@b.com>'])
  })

  it('does not split on a comma inside angle brackets', () => {
    expect(splitAddresses('Group <a@x.com,b@x.com>, c@y.com')).toEqual([
      'Group <a@x.com,b@x.com>',
      'c@y.com',
    ])
  })

  it('respects a backslash-escaped quote in a display name', () => {
    expect(splitAddresses('"He said \\"hi\\", really" <h@x.com>, b@y.com')).toEqual([
      '"He said \\"hi\\", really" <h@x.com>',
      'b@y.com',
    ])
  })

  it('returns an empty list for an empty header', () => {
    expect(splitAddresses('')).toEqual([])
    expect(splitAddresses('   ')).toEqual([])
  })

  it('drops trailing separators rather than emitting blanks', () => {
    expect(splitAddresses('a@x.com,')).toEqual(['a@x.com'])
  })
})
