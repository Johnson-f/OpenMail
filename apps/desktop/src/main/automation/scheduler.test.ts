import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import {
  ActionApprovalGraph,
  AutomationRunGraph,
  PolicyEngine,
  type AutomationSpec,
} from '@gmail/agent'
import { FakeGmail } from '@gmail/gmail'
import { openAgentDatabase, openDatabase } from '../db/index'
import { readCursor } from '../db/event-cursors'
import { SqliteMailStore } from '../db/store'
import { ActionService } from '../ai/action-service'
import { MailActionService } from '../ai/mail-action-service'
import { AutomationScheduler } from './scheduler'
import type { StoredMessage } from '@gmail/core'

const spec: AutomationSpec = {
  automationId: 'a1', version: 1, name: 'Archive newsletters', accountIds: [1], mailboxIds: ['INBOX'],
  trigger: { type: 'mail_event', event: 'new_message' },
  conditions: { query: 'newsletter', senders: [], recipientDomains: [] },
  actions: [{ kind: 'archive', arguments: {} }], limits: { maxPerRun: 50, maxPerDay: 500 },
  allowAttachments: false, timezone: 'Africa/Lagos', catchUp: 'run_once', enabled: true,
}

describe('AutomationScheduler', () => {
  it('deduplicates a mail trigger and queues its granted action once', async () => {
    const mailDb = openDatabase(':memory:')
    const agentDb = openAgentDatabase(':memory:')
    const store = new SqliteMailStore(mailDb)
    const gmail = new FakeGmail()
    gmail.seedMessage({ id: 'm1', subject: 'Weekly newsletter', labelIds: ['INBOX'] })
    store.upsertMessage(1, await gmail.getMessage('m1'), { eventKey: 'event:1', origin: 'incremental', payload: { type: 'messageAdded' } })
    const checkpointer = new MemorySaver()
    const actions = new ActionService(agentDb, new PolicyEngine(), new ActionApprovalGraph(checkpointer))
    const mailActions = new MailActionService(mailDb, store, () => gmail, actions)
    agentDb
      .prepare(
        `INSERT INTO automation_versions
         (id, automation_id, version, specification_json, grant_json, status, created_at)
         VALUES ('v1', 'a1', 1, ?, ?, 'active', 1)`,
      )
      .run(JSON.stringify(spec), JSON.stringify({
        accountIds: [1], tools: ['archive'], recipientDomains: [], recipients: [], allowAttachments: false,
        maxPerRun: 50, maxPerDay: 500, usedThisRun: 0, usedToday: 0, expiresAt: Number.MAX_SAFE_INTEGER,
      }))
    const clock = { now: () => 10_000 }
    const scheduler = new AutomationScheduler(
      mailDb, agentDb, store, actions, mailActions,
      (execute) => new AutomationRunGraph(execute, checkpointer), clock,
    )

    await scheduler.tick()
    await scheduler.tick()

    expect(store.pendingOutbox(1)).toHaveLength(1)
    expect((agentDb.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE status = 'completed'").get() as { count: number }).count).toBe(1)
    mailDb.close(); agentDb.close()
  })

  describe('triggers', () => {
    const DAY = 86_400_000
    const noopGraph = () => ({ run: async () => ({}) }) as unknown as AutomationRunGraph

    function setup(overrides: Partial<AutomationSpec>, createdAt: number, startAt = createdAt) {
      const mailDb = openDatabase(':memory:')
      const agentDb = openAgentDatabase(':memory:')
      const store = new SqliteMailStore(mailDb)
      const checkpointer = new MemorySaver()
      const actions = new ActionService(agentDb, new PolicyEngine(), new ActionApprovalGraph(checkpointer))
      const mailActions = new MailActionService(mailDb, store, () => new FakeGmail(), actions)
      const merged = { ...spec, ...overrides }
      agentDb
        .prepare(
          `INSERT INTO automation_versions
           (id, automation_id, version, specification_json, grant_json, status, created_at)
           VALUES ('v1', 'a1', 1, ?, '{}', 'active', ?)`,
        )
        .run(JSON.stringify(merged), createdAt)
      const clock = { value: startAt, now() { return this.value } }
      const scheduler = new AutomationScheduler(mailDb, agentDb, store, actions, mailActions, noopGraph, clock)
      const triggers = () =>
        agentDb.prepare('SELECT trigger_key AS key, due_at AS dueAt FROM automation_triggers ORDER BY due_at').all() as Array<{
          key: string
          dueAt: number
        }>
      return { mailDb, agentDb, store, scheduler, clock, triggers }
    }

    function message(id: string, over: Partial<StoredMessage> = {}): StoredMessage {
      return {
        id, threadId: id, from: 'a@example.com', to: ['me@example.com'], cc: [], subject: 'Weekly newsletter',
        snippet: '', bodyText: '', bodyHtml: '', internalDate: 1_000, labelIds: ['INBOX'], messageIdHeader: `${id}@x`,
        inReplyTo: '', references: [], attachments: [], ...over,
      }
    }

    const arrival = (key: string) => ({ eventKey: key, origin: 'incremental' as const, payload: { type: 'messageAdded' } })

    it('ignores label changes and fires once per arriving message', async () => {
      const env = setup({}, 1)
      env.store.upsertMessage(1, message('m1'), arrival('e1'))
      await env.scheduler.tick()
      expect(env.triggers()).toHaveLength(1)
      expect(env.triggers()[0]?.key).toBe('mail:v1:1:m1:new_message')

      env.store.upsertMessage(1, message('m1', { labelIds: [] }), { eventKey: 'e2', origin: 'incremental', payload: { type: 'labelRemoved' } })
      env.store.upsertMessage(1, message('m1'), arrival('e3'))
      await env.scheduler.tick()
      expect(env.triggers()).toHaveLength(1)

      env.store.upsertMessage(1, message('m2', { labelIds: ['INBOX'] }), { eventKey: 'e4', origin: 'incremental', payload: { type: 'labelRemoved' } })
      await env.scheduler.tick()
      expect(env.triggers()).toHaveLength(1)
      env.mailDb.close(); env.agentDb.close()
    })

    it('advances the dispatch cursor and does not re-dispatch consumed events', async () => {
      const env = setup({}, 1)
      env.store.upsertMessage(1, message('m1'), arrival('e1'))
      env.store.upsertMessage(1, message('m2'), arrival('e2'))
      await env.scheduler.tick()
      expect(readCursor(env.mailDb, 'automation-dispatch')).toBe(2)
      await env.scheduler.tick()
      await env.scheduler.tick()
      expect(env.triggers()).toHaveLength(2)
      env.mailDb.close(); env.agentDb.close()
    })

    it('does not match mail outside the configured mailboxes or backfill events', async () => {
      const env = setup({}, 1)
      env.store.upsertMessage(1, message('m1', { labelIds: ['CATEGORY_PROMOTIONS'] }), arrival('e1'))
      env.store.upsertMessage(1, message('m2'), { eventKey: 'e2', origin: 'backfill', payload: { type: 'messageAdded' } })
      await env.scheduler.tick()
      expect(env.triggers()).toHaveLength(0)
      env.mailDb.close(); env.agentDb.close()
    })

    it('ignores events from before activation', async () => {
      const env = setup({}, 5_000)
      env.store.upsertMessage(1, message('m1'), arrival('e1'))
      env.mailDb.prepare('UPDATE mail_events SET created_at = 4_000').run()
      await env.scheduler.tick()
      expect(env.triggers()).toHaveLength(0)
      env.mailDb.close(); env.agentDb.close()
    })

    it('replays up to seven days before activation for bounded_replay', async () => {
      const env = setup({ catchUp: 'bounded_replay' }, 10 * DAY)
      env.store.upsertMessage(1, message('m1'), arrival('e1'))
      env.store.upsertMessage(1, message('m2'), arrival('e2'))
      env.mailDb.prepare("UPDATE mail_events SET created_at = ? WHERE event_key = 'e1'").run(10 * DAY - 6 * DAY)
      env.mailDb.prepare("UPDATE mail_events SET created_at = ? WHERE event_key = 'e2'").run(10 * DAY - 8 * DAY)
      await env.scheduler.tick()
      expect(env.triggers().map((t) => t.key)).toEqual(['mail:v1:1:m1:new_message'])
      env.mailDb.close(); env.agentDb.close()
    })

    it('does not trigger on mail sent by any automation, only on mail the user sent', async () => {
      const env = setup({ trigger: { type: 'mail_event', event: 'sent_message' }, conditions: { senders: [], recipientDomains: [] } }, 1)
      const insertLedger = env.mailDb.prepare(
        `INSERT INTO send_ledger (operation_id, action_intent_id, account_id, rfc_message_id, content_hash, status, gmail_message_id, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'h', 'sent', ?, 1, 1)`,
      )
      const insertIntent = env.agentDb.prepare(
        `INSERT INTO action_intents (id, kind, account_id, arguments_json, content_hash, initiator_json, status, created_at, updated_at)
         VALUES (?, 'send', 1, '{}', 'h', ?, 'executed', 1, 1)`,
      )
      insertLedger.run('op1', 'i1', 'own@x', 's1')
      insertIntent.run('i1', JSON.stringify({ type: 'automation', automationVersionId: 'v1' }))
      insertLedger.run('op2', 'i2', 'user@x', 's2')
      insertIntent.run('i2', JSON.stringify({ type: 'chat', conversationId: 'compose' }))
      insertLedger.run('op3', 'i3', 'other-automation@x', 's3')
      insertIntent.run('i3', JSON.stringify({ type: 'automation', automationVersionId: 'v-other' }))
      env.store.upsertMessage(1, message('s1', { labelIds: ['SENT'], messageIdHeader: 'own@x' }), { eventKey: 'local-send:op1', origin: 'local_action' })
      env.store.upsertMessage(1, message('s2', { labelIds: ['SENT'], messageIdHeader: 'user@x' }), { eventKey: 'local-send:op2', origin: 'local_action' })
      env.store.upsertMessage(1, message('s3', { labelIds: ['SENT'], messageIdHeader: 'other-automation@x' }), { eventKey: 'local-send:op3', origin: 'local_action' })
      await env.scheduler.tick()
      expect(env.triggers().map((t) => t.key)).toEqual(['mail:v1:1:s2:sent_message'])
      env.mailDb.close(); env.agentDb.close()
    })

    it('triggers thread_update only for replies in existing threads', async () => {
      const env = setup({ trigger: { type: 'mail_event', event: 'thread_update' } }, 1)
      env.store.upsertMessage(1, message('t1', { threadId: 't', internalDate: 1_000 }), arrival('e1'))
      env.store.upsertMessage(1, message('t2', { threadId: 't', internalDate: 2_000 }), arrival('e2'))
      await env.scheduler.tick()
      expect(env.triggers().map((t) => t.key)).toEqual(['mail:v1:1:t2:thread_update'])
      env.mailDb.close(); env.agentDb.close()
    })

    const nyDaily = {
      trigger: { type: 'schedule' as const, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
      timezone: 'America/New_York',
    }

    it('fires a 9:00 local schedule at the right instant across a DST change', async () => {
      const env = setup(nyDaily, Date.UTC(2026, 2, 5, 12))
      for (let at = Date.UTC(2026, 2, 5, 12); at <= Date.UTC(2026, 2, 9, 15); at += 3_600_000) {
        env.clock.value = at
        await env.scheduler.tick()
      }
      expect(env.triggers().map((t) => new Date(t.dueAt).toISOString())).toEqual([
        '2026-03-05T14:00:00.000Z',
        '2026-03-06T14:00:00.000Z',
        '2026-03-07T14:00:00.000Z',
        '2026-03-08T13:00:00.000Z',
        '2026-03-09T13:00:00.000Z',
      ])
      env.mailDb.close(); env.agentDb.close()
    })

    it('creates one trigger across 1,000 ticks in a day', async () => {
      const start = Date.UTC(2026, 2, 5, 12)
      const env = setup(nyDaily, start)
      for (let i = 0; i <= 1_000; i++) {
        env.clock.value = start + Math.floor((i * DAY) / 1_000)
        await env.scheduler.tick()
      }
      expect(env.triggers()).toHaveLength(1)
      env.mailDb.close(); env.agentDb.close()
    })

    it('fires a plain daily rule once a day, not every tick', async () => {
      const start = Date.UTC(2026, 2, 5, 12)
      const env = setup({ trigger: { type: 'schedule', rrule: 'FREQ=DAILY' }, timezone: 'UTC' }, start)
      for (let at = start; at <= start + 3 * DAY; at += 3_600_000) {
        env.clock.value = at
        await env.scheduler.tick()
      }
      expect(env.triggers()).toHaveLength(3)
      env.mailDb.close(); env.agentDb.close()
    })

    describe('catch-up after a 3-day sleep', () => {
      const created = Date.UTC(2026, 2, 1, 12)
      const daily = { trigger: { type: 'schedule' as const, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }, timezone: 'UTC' }

      it('skip drops missed occurrences', async () => {
        const env = setup({ ...daily, catchUp: 'skip' }, created, Date.UTC(2026, 2, 4, 12))
        await env.scheduler.tick()
        expect(env.triggers()).toHaveLength(0)
        env.mailDb.close(); env.agentDb.close()
      })

      it('skip still runs an occurrence from the last ten minutes', async () => {
        const env = setup({ ...daily, catchUp: 'skip' }, created, Date.UTC(2026, 2, 4, 9, 5))
        await env.scheduler.tick()
        expect(env.triggers().map((t) => new Date(t.dueAt).toISOString())).toEqual(['2026-03-04T09:00:00.000Z'])
        env.mailDb.close(); env.agentDb.close()
      })

      it('run_once runs only the latest occurrence', async () => {
        const env = setup({ ...daily, catchUp: 'run_once' }, created, Date.UTC(2026, 2, 4, 12))
        await env.scheduler.tick()
        expect(env.triggers().map((t) => new Date(t.dueAt).toISOString())).toEqual(['2026-03-04T09:00:00.000Z'])
        env.mailDb.close(); env.agentDb.close()
      })

      it('bounded_replay runs every missed occurrence up to ten', async () => {
        const env = setup({ ...daily, catchUp: 'bounded_replay' }, created, Date.UTC(2026, 2, 4, 12))
        await env.scheduler.tick()
        expect(env.triggers()).toHaveLength(3)
        const later = setup({ ...daily, catchUp: 'bounded_replay' }, created, Date.UTC(2026, 2, 30, 12))
        await later.scheduler.tick()
        expect(later.triggers()).toHaveLength(10)
        env.mailDb.close(); env.agentDb.close(); later.mailDb.close(); later.agentDb.close()
      })
    })

    describe('follow-ups', () => {
      const created = Date.UTC(2026, 5, 1)
      const followUp = { trigger: { type: 'follow_up' as const, daysWithoutReply: 1 } }

      it('ignores mail sent before activation', async () => {
        const env = setup(followUp, created, created + 5 * DAY)
        for (let i = 0; i < 50; i++) {
          env.store.upsertMessage(1, message(`old${i}`, { labelIds: ['SENT'], internalDate: created - 10 * DAY + i }))
        }
        await env.scheduler.tick()
        expect(env.triggers()).toHaveLength(0)
        env.mailDb.close(); env.agentDb.close()
      })

      it('fires at the computed due time for mail sent after activation', async () => {
        const sentAt = created + 3_600_000
        const env = setup(followUp, created, sentAt + 3_600_000)
        env.store.upsertMessage(1, message('new1', { labelIds: ['SENT'], internalDate: sentAt }))
        await env.scheduler.tick()
        expect(env.triggers()).toHaveLength(0)
        env.clock.value = sentAt + DAY + 1
        await env.scheduler.tick()
        expect(env.triggers()).toEqual([{ key: `follow-up:v1:new1:${sentAt + DAY}`, dueAt: sentAt + DAY }])
        env.mailDb.close(); env.agentDb.close()
      })
    })
  })

  describe('step journal', () => {
    const DAY = 86_400_000
    const sendStep = { kind: 'send' as const, arguments: { to: ['bob@example.com'], subject: 'Hi', bodyText: 'Hello' } }
    const draftStep = { kind: 'create_draft' as const, arguments: { to: ['bob@example.com'], subject: 'Draft', bodyText: 'Body' } }
    const archiveStep = { kind: 'archive' as const, arguments: {} }

    async function setup(actions: AutomationSpec['actions']) {
      const mailDb = openDatabase(':memory:')
      const agentDb = openAgentDatabase(':memory:')
      const store = new SqliteMailStore(mailDb)
      const gmail = new FakeGmail()
      gmail.seedMessage({ id: 'm1', subject: 'Weekly newsletter', labelIds: ['INBOX'] })
      store.upsertMessage(1, await gmail.getMessage('m1'))
      const checkpointer = new MemorySaver()
      const actionService = new ActionService(agentDb, new PolicyEngine(), new ActionApprovalGraph(checkpointer))
      const mailActions = new MailActionService(mailDb, store, () => gmail, actionService)
      const manual: AutomationSpec = { ...spec, trigger: { type: 'schedule', rrule: 'FREQ=YEARLY' }, actions }
      agentDb
        .prepare(
          `INSERT INTO automation_versions
           (id, automation_id, version, specification_json, grant_json, status, created_at)
           VALUES ('v1', 'a1', 1, ?, ?, 'active', ?)`,
        )
        .run(
          JSON.stringify(manual),
          JSON.stringify({
            accountIds: [1], tools: ['send', 'archive', 'create_draft'], recipientDomains: ['example.com'], recipients: [],
            allowAttachments: false, maxPerRun: 50, maxPerDay: 500, usedThisRun: 0, usedToday: 0,
            expiresAt: Number.MAX_SAFE_INTEGER,
          }),
          DAY,
        )
      const clock = { value: 10 * DAY, now() { return this.value } }
      const scheduler = new AutomationScheduler(
        mailDb, agentDb, store, actionService, mailActions,
        (execute) => new AutomationRunGraph(execute, checkpointer), clock,
      )
      const triggerId = scheduler.runManual('v1', { accountId: 1, messageId: 'm1' })
      const trigger = () =>
        agentDb.prepare('SELECT status, attempts, available_at AS availableAt FROM automation_triggers WHERE id = ?').get(triggerId) as {
          status: string
          attempts: number
          availableAt: number
        }
      const run = () =>
        agentDb.prepare('SELECT status FROM automation_runs WHERE trigger_id = ?').get(triggerId) as { status: string }
      const close = () => { mailDb.close(); agentDb.close() }
      return { mailDb, agentDb, store, gmail, scheduler, clock, trigger, run, close }
    }

    it('does not resend when a later step fails and the trigger is retried', async () => {
      const env = await setup([sendStep, archiveStep])
      const enqueue = vi.spyOn(env.store, 'enqueueOutbox').mockImplementationOnce(() => {
        throw new Error('label step failed')
      })
      await env.scheduler.tick()
      expect(env.trigger().status).toBe('pending')
      expect(env.trigger().attempts).toBe(1)
      env.clock.value += 60_000
      await env.scheduler.tick()

      expect(enqueue).toHaveBeenCalledTimes(2)
      expect(env.gmail.sendCount).toBe(1)
      expect(env.store.pendingOutbox(1)).toHaveLength(1)
      expect(env.run().status).toBe('completed')
      env.close()
    })

    it('does not repeat a completed step after an expired lease', async () => {
      const env = await setup([sendStep, archiveStep])
      vi.spyOn(env.store, 'enqueueOutbox').mockImplementationOnce(() => {
        throw new Error('crash')
      })
      await env.scheduler.tick()
      const stepUpdatedAt = () =>
        (env.agentDb.prepare('SELECT updated_at AS at FROM automation_run_steps WHERE step_index = 0').get() as { at: number }).at
      const before = stepUpdatedAt()
      env.agentDb.prepare("UPDATE automation_triggers SET status = 'running'").run()
      env.agentDb.prepare("UPDATE automation_runs SET status = 'running', lease_expires_at = ?").run(env.clock.value)
      env.clock.value += 120_000
      await env.scheduler.tick()

      expect(env.gmail.sendCount).toBe(1)
      expect(stepUpdatedAt()).toBe(before)
      expect(env.run().status).toBe('completed')
      env.close()
    })

    it('renews the lease for five minutes before each step', async () => {
      const env = await setup([draftStep, archiveStep])
      const leases: number[] = []
      vi.spyOn(env.store, 'enqueueOutbox').mockImplementationOnce(() => {
        leases.push((env.agentDb.prepare('SELECT lease_expires_at AS at FROM automation_runs').get() as { at: number }).at)
        return 0 as never
      })
      await env.scheduler.tick()
      expect(leases).toEqual([env.clock.value + 5 * 60_000])
      env.close()
    })

    it('updates the same draft when a draft step repeats', async () => {
      const env = await setup([draftStep])
      const create = vi.spyOn(env.gmail, 'createDraft')
      const update = vi.spyOn(env.gmail, 'updateDraft')
      await env.scheduler.tick()
      env.agentDb.prepare('DELETE FROM automation_run_steps').run()
      env.agentDb.prepare("UPDATE automation_triggers SET status = 'pending', available_at = 0").run()
      await env.scheduler.tick()

      expect(create).toHaveBeenCalledTimes(1)
      expect(update).toHaveBeenCalledTimes(1)
      expect(env.mailDb.prepare('SELECT COUNT(*) AS count FROM local_drafts').get()).toEqual({ count: 1 })
      env.close()
    })

    it('waits for reconciliation after an uncertain send without spending an attempt or resending', async () => {
      const env = await setup([sendStep])
      env.gmail.failNextSendAfterAccept(new Error('connection reset'))
      await env.scheduler.tick()

      expect(env.run().status).toBe('awaiting_reconciliation')
      expect(env.trigger()).toEqual({ status: 'pending', attempts: 0, availableAt: env.clock.value + 5 * 60_000 })
      expect(env.gmail.sendCount).toBe(1)

      env.clock.value += 60_000
      await env.scheduler.tick()
      expect(env.gmail.sendCount).toBe(1)

      env.clock.value += 5 * 60_000
      await env.scheduler.tick()
      expect(env.gmail.sendCount).toBe(1)
      expect(env.trigger().attempts).toBe(0)
      env.close()
    })
  })
})
