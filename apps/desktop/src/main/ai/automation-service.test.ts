import { describe, expect, it } from 'vitest'
import type { AutomationSpec } from '@gmail/agent'
import { AutomationBuilder } from '@gmail/agent'
import { FakeGmail } from '@gmail/gmail'
import { openAgentDatabase, openDatabase } from '../db/index'
import { SqliteMailStore } from '../db/store'
import { AutomationService } from './automation-service'

const spec: AutomationSpec = {
  automationId: 'a1', version: 1, name: 'Invoices', accountIds: [1], mailboxIds: ['INBOX'],
  trigger: { type: 'mail_event', event: 'new_message' },
  conditions: { query: 'invoice', senders: [], recipientDomains: [] },
  actions: [{ kind: 'modify_labels', arguments: { add: ['Finance'] } }],
  limits: { maxPerRun: 50, maxPerDay: 500 }, allowAttachments: false,
  timezone: 'Africa/Lagos', catchUp: 'run_once', enabled: false,
}

describe('AutomationService', () => {
  it('simulates without mutations and requires the exact simulation before activation', async () => {
    const mailDb = openDatabase(':memory:')
    const agentDb = openAgentDatabase(':memory:')
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', subject: 'Invoice 3817', bodyText: 'Due Friday' })
    const store = new SqliteMailStore(mailDb)
    store.upsertMessage(1, await gmail.getMessage('m1'))
    const service = new AutomationService(mailDb, agentDb, new AutomationBuilder(() => ({ async *stream() {} })))

    const simulation = service.simulate(spec)
    expect(simulation.result.matchedMessageIds).toEqual(['m1'])
    expect(mailDb.prepare('SELECT label_id FROM message_labels WHERE message_id = ?').all('m1')).toEqual([{ label_id: 'INBOX' }])
    expect(() => service.activate(spec, 'missing')).toThrow(/simulated/)
    service.activate(spec, simulation.id)
    expect(service.list()).toHaveLength(1)
    mailDb.close(); agentDb.close()
  })

  it('simulates only messages in the configured mailboxes and skips sent mail for new_message', async () => {
    const mailDb = openDatabase(':memory:')
    const agentDb = openAgentDatabase(':memory:')
    const store = new SqliteMailStore(mailDb)
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'inbox', subject: 'Invoice 1', labelIds: ['INBOX'] })
    gmail.seedMessage({ id: 'archived', subject: 'Invoice 2', labelIds: [] })
    gmail.seedMessage({ id: 'sent', subject: 'Invoice 3', labelIds: ['SENT'] })
    for (const id of ['inbox', 'archived', 'sent']) store.upsertMessage(1, await gmail.getMessage(id))
    const service = new AutomationService(mailDb, agentDb, new AutomationBuilder(() => ({ async *stream() {} })))

    expect(service.simulate(spec).result.matchedMessageIds).toEqual(['inbox'])
    const sentSpec = { ...spec, trigger: { type: 'mail_event' as const, event: 'sent_message' as const } }
    expect(service.simulate(sentSpec).result.matchedMessageIds).toEqual(['sent'])
    mailDb.close(); agentDb.close()
  })
})
