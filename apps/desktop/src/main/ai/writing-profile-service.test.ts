import { describe, expect, it } from 'vitest'
import { openAgentDatabase, openDatabase } from '../db/index'
import { SqliteMailStore } from '../db/store'
import { FakeGmail } from '@gmail/gmail'
import { WritingProfileService } from './writing-profile-service'

describe('WritingProfileService', () => {
  it('builds global and relationship profiles and supports controls', async () => {
    const mailDb = openDatabase(':memory:')
    const agentDb = openAgentDatabase(':memory:')
    const store = new SqliteMailStore(mailDb)
    const gmail = new FakeGmail()
    for (const id of ['1', '2', '3']) {
      gmail.seedMessage({
        id,
        from: 'me@example.com',
        to: ['Alice <alice@example.com>'],
        bodyText: `Hi Alice,\n\nConfirmed ${id}.\n\nThanks,`,
        labelIds: ['SENT'],
      })
      store.upsertMessage(1, await gmail.getMessage(id))
    }
    const service = new WritingProfileService(mailDb, agentDb)
    const profiles = await service.rebuild(1)
    expect(profiles.map((profile) => profile.relationshipKey)).toEqual(['*', 'alice@example.com'])
    expect(service.context(1, ['alice@example.com']).examples).toHaveLength(3)
    service.setEnabled(1, 'alice@example.com', false)
    expect(service.list(1).find((profile) => profile.relationshipKey === 'alice@example.com')?.enabled).toBe(false)
    expect(JSON.parse(service.export(1)).profiles).toHaveLength(2)
    service.reset(1)
    expect(service.list(1)).toEqual([])
    mailDb.close(); agentDb.close()
  })

  it('honours message and recipient exclusions across batches', async () => {
    const mailDb = openDatabase(':memory:')
    const agentDb = openAgentDatabase(':memory:')
    const store = new SqliteMailStore(mailDb)
    const gmail = new FakeGmail()
    for (let i = 1; i <= 450; i++) {
      gmail.seedMessage({
        id: `m${i}`,
        from: 'me@example.com',
        to: [i % 2 ? 'Alice <alice@example.com>' : 'Bob <bob@example.com>'],
        bodyText: `Hi,\n\nNote ${i}.\n\nThanks,`,
        labelIds: ['SENT'],
      })
      store.upsertMessage(1, await gmail.getMessage(`m${i}`))
    }
    const insert = agentDb.prepare(
      'INSERT INTO writing_profile_exclusions (account_id, exclusion_type, exclusion_value, created_at) VALUES (1, ?, ?, 1)',
    )
    insert.run('recipient', 'bob@example.com')
    insert.run('message', 'm1')
    const profiles = await new WritingProfileService(mailDb, agentDb).rebuild(1)
    expect(profiles.map((profile) => profile.relationshipKey)).toEqual(['*', 'alice@example.com'])
    mailDb.close(); agentDb.close()
  })
})
