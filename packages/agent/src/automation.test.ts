import { describe, expect, it } from 'vitest'
import type { BrainProvider } from '@gmail/intelligence'
import { AutomationBuilder, AutomationClarificationError, grantForSpec, privilegeExpansion, type AutomationSpec } from './automation'

function brainJson(value: unknown): BrainProvider {
  return { async *stream() { yield { type: 'text_delta' as const, delta: JSON.stringify(value) } } }
}

function spec(overrides: Partial<AutomationSpec> = {}): AutomationSpec {
  return {
    automationId: 'a1', version: 1, name: 'Invoice triage', accountIds: [1], mailboxIds: ['INBOX'],
    trigger: { type: 'mail_event', event: 'new_message' },
    conditions: { query: 'invoice', senders: [], recipientDomains: [] },
    actions: [{ kind: 'modify_labels', arguments: { add: ['Finance'] } }],
    limits: { maxPerRun: 50, maxPerDay: 500 }, allowAttachments: false,
    timezone: 'Africa/Lagos', catchUp: 'run_once', enabled: false, ...overrides,
  }
}

describe('AutomationBuilder', () => {
  it('builds and validates a typed specification from brain JSON', async () => {
    const built = await new AutomationBuilder(() => brainJson(spec())).build({ instruction: 'triage invoices' })
    expect(built).toEqual(spec())
    expect(grantForSpec(built)).toMatchObject({ accountIds: [1], tools: ['modify_labels'], maxPerRun: 50 })
  })

  it('detects every material privilege expansion', () => {
    const previous = spec()
    const next = spec({
      version: 2,
      accountIds: [1, 2],
      actions: [...previous.actions, { kind: 'send', arguments: {} }],
      limits: { maxPerRun: 60, maxPerDay: 600 },
      allowAttachments: true,
      conditions: { ...previous.conditions, recipientDomains: ['example.com'] },
    })
    expect(privilegeExpansion(previous, next)).toEqual(
      expect.arrayContaining(['accounts', 'tools', 'limits', 'attachments', 'recipient_domains']),
    )
  })

  it.each(['FREQ=SECONDLY', 'FREQ=MINUTELY', 'FREQ=MINUTELY;INTERVAL=5', 'FREQ=HOURLY;BYMINUTE=0,5,10', 'FREQ=NOTARULE'])(
    'rejects the schedule %s',
    async (rrule) => {
      const brain = brainJson(spec({ trigger: { type: 'schedule', rrule } }))
      await expect(new AutomationBuilder(() => brain).build({ instruction: 'x' })).rejects.toBeInstanceOf(
        AutomationClarificationError,
      )
    },
  )

  it.each(['FREQ=DAILY;BYHOUR=9;BYMINUTE=0', 'FREQ=MINUTELY;INTERVAL=30', 'FREQ=HOURLY', 'FREQ=WEEKLY;BYDAY=MO'])(
    'accepts the schedule %s',
    async (rrule) => {
      const brain = brainJson(spec({ trigger: { type: 'schedule', rrule } }))
      const built = await new AutomationBuilder(() => brain).build({ instruction: 'x' })
      expect(built.trigger).toEqual({ type: 'schedule', rrule })
    },
  )
})
