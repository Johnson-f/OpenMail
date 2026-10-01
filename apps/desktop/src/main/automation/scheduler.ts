import { createHash, randomUUID } from 'node:crypto'
import {
  AutomationRunGraph,
  AutomationSpecSchema,
  createActionIntent,
  labelChangesFor,
  type ActionKind,
  type AutomationGrant,
  type AutomationSpec,
} from '@gmail/agent'
import type { Db } from '../db/index'
import { advanceCursor, AUTOMATION_CONSUMER, eventsAfter } from '../db/event-cursors'
import { getMessage } from '../db/messages'
import type { SqliteMailStore } from '../db/store'
import type { ActionService } from '../ai/action-service'
import { matchesConditions, matchesTriggerLabels } from './matching'
import { occurrencesBetween } from './recurrence'
import type { ComposeMessage, MailActionService } from '../ai/mail-action-service'

type Clock = { now(): number }
type VersionRow = {
  id: string
  specification_json: string
  grant_json: string
  created_at: number
  schedule_cursor: number | null
}
type MailEventRow = {
  id: number
  account_id: number
  message_id: string
  thread_id: string | null
  kind: string
  origin: string
  payload_json: string
  created_at: number
}

const REPLAY_WINDOW_MS = 7 * 86_400_000
const SKIP_GRACE_MS = 10 * 60_000
const REPLAY_LIMIT = 10
const LEASE_MS = 5 * 60_000
const RECONCILIATION_RETRY_MS = 5 * 60_000
type TriggerRow = { id: string; automation_version_id: string; payload_json: string; attempts: number }

class AwaitingReconciliationError extends Error {}

type StepResult = { kind: string; status: string }

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly mailDb: Db,
    private readonly agentDb: Db,
    private readonly store: SqliteMailStore,
    private readonly actions: ActionService,
    private readonly mailActions: MailActionService,
    private readonly graphFactory: (
      execute: (spec: AutomationSpec, trigger: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => AutomationRunGraph,
    private readonly clock: Clock = { now: () => Date.now() },
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      this.recoverExpiredLeases()
      this.dispatchMailEvents()
      this.seedSchedules()
      this.seedFollowUps()
      await this.runDue()
    } finally {
      this.running = false
    }
  }

  runManual(automationVersionId: string, payload: Record<string, unknown> = {}): string {
    return this.insertTrigger(automationVersionId, `manual:${randomUUID()}`, this.clock.now(), payload)
  }

  private activeVersions(): VersionRow[] {
    return this.agentDb
      .prepare("SELECT id, specification_json, grant_json, created_at, schedule_cursor FROM automation_versions WHERE status = 'active'")
      .all() as VersionRow[]
  }

  private dispatchMailEvents(): void {
    const events = eventsAfter(this.mailDb, AUTOMATION_CONSUMER, 100)
    const versions = this.activeVersions().flatMap((version) => {
      const spec = AutomationSpecSchema.parse(JSON.parse(version.specification_json))
      return spec.trigger.type === 'mail_event' ? [{ version, spec, event: spec.trigger.event }] : []
    })
    for (const event of events) {
      if (isArrival(event)) {
        for (const { version, spec, event: triggerEvent } of versions) {
          if (!this.shouldTrigger(version, spec, triggerEvent, event)) continue
          this.insertTrigger(
            version.id,
            `mail:${version.id}:${event.account_id}:${event.message_id}:${triggerEvent}`,
            this.clock.now(),
            { accountId: event.account_id, messageId: event.message_id, eventKind: event.kind },
          )
        }
      }
      advanceCursor(this.mailDb, AUTOMATION_CONSUMER, event.id, this.clock.now())
    }
  }

  private shouldTrigger(version: VersionRow, spec: AutomationSpec, triggerEvent: string, event: MailEventRow): boolean {
    if (!spec.accountIds.includes(event.account_id)) return false
    if (event.created_at < version.created_at - this.replayWindow(spec)) return false
    const message = getMessage(this.mailDb, event.account_id, event.message_id)
    if (!message || !matchesTriggerLabels(spec, message.labelIds) || !matchesConditions(spec, message)) return false
    if (triggerEvent === 'thread_update' && !this.threadHadEarlierMessages(event.account_id, message)) return false
    // Mail any automation sent never triggers automations: otherwise two
    // sent_message automations could answer each other until the daily cap.
    return !this.isAutomationOutput(event.account_id, message)
  }

  private replayWindow(spec: AutomationSpec): number {
    return spec.catchUp === 'bounded_replay' ? REPLAY_WINDOW_MS : 0
  }

  private threadHadEarlierMessages(accountId: number, message: NonNullable<ReturnType<typeof getMessage>>): boolean {
    const row = this.mailDb
      .prepare(
        'SELECT 1 AS found FROM messages WHERE account_id = ? AND thread_id = ? AND id != ? AND internal_date < ? LIMIT 1',
      )
      .get(accountId, message.threadId, message.id, message.internalDate)
    return row !== undefined
  }

  private isAutomationOutput(accountId: number, message: NonNullable<ReturnType<typeof getMessage>>): boolean {
    const intents = this.mailDb
      .prepare(
        `SELECT action_intent_id FROM send_ledger
         WHERE account_id = ? AND (gmail_message_id = ? OR (? != '' AND rfc_message_id = ?))`,
      )
      .all(accountId, message.id, message.messageIdHeader, message.messageIdHeader) as Array<{ action_intent_id: string }>
    return intents.some(
      ({ action_intent_id }) =>
        this.agentDb
          .prepare(
            "SELECT 1 AS found FROM action_intents WHERE id = ? AND json_extract(initiator_json, '$.type') = 'automation'",
          )
          .get(action_intent_id) !== undefined,
    )
  }

  private seedSchedules(): void {
    const now = this.clock.now()
    for (const version of this.activeVersions()) {
      const spec = AutomationSpecSchema.parse(JSON.parse(version.specification_json))
      if (spec.trigger.type !== 'schedule') continue
      const cursor = version.schedule_cursor ?? version.created_at
      if (now <= cursor) continue
      let occurrences: Date[]
      try {
        occurrences = occurrencesBetween(
          spec.trigger.rrule,
          spec.timezone,
          new Date(version.created_at),
          new Date(cursor),
          new Date(now),
        )
      } catch {
        continue
      }
      for (const occurrence of selectCatchUp(occurrences, spec.catchUp, now)) {
        this.insertTrigger(version.id, `schedule:${version.id}:${occurrence.toISOString()}`, occurrence.getTime(), {})
      }
      this.agentDb.prepare('UPDATE automation_versions SET schedule_cursor = ? WHERE id = ?').run(now, version.id)
    }
  }

  private seedFollowUps(): void {
    const now = this.clock.now()
    for (const version of this.activeVersions()) {
      const spec = AutomationSpecSchema.parse(JSON.parse(version.specification_json))
      if (spec.trigger.type !== 'follow_up') continue
      const waitMs = spec.trigger.daysWithoutReply * 86_400_000
      const placeholders = spec.accountIds.map(() => '?').join(',')
      const rows = this.mailDb
        .prepare(
          `SELECT m.account_id AS accountId, m.id AS messageId, m.thread_id AS threadId, m.internal_date AS sentAt
           FROM messages m
           JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'SENT'
           WHERE m.account_id IN (${placeholders}) AND m.internal_date <= ? AND m.internal_date >= ?
             AND NOT EXISTS (
               SELECT 1 FROM messages newer
               WHERE newer.account_id = m.account_id AND newer.thread_id = m.thread_id
                 AND newer.internal_date > m.internal_date
             )
           ORDER BY m.internal_date DESC LIMIT 100`,
        )
        .all(...spec.accountIds, now - waitMs, version.created_at - this.replayWindow(spec)) as Array<{
        accountId: number
        messageId: string
        threadId: string
        sentAt: number
      }>
      for (const row of rows) {
        const dueAt = row.sentAt + waitMs
        this.insertTrigger(version.id, `follow-up:${version.id}:${row.messageId}:${dueAt}`, dueAt, { ...row, dueAt })
      }
    }
  }

  private async runDue(): Promise<void> {
    const rows = this.agentDb
      .prepare(
        `SELECT id, automation_version_id, payload_json, attempts FROM automation_triggers
         WHERE status = 'pending' AND due_at <= ? AND available_at <= ?
         ORDER BY due_at, id LIMIT 20`,
      )
      .all(this.clock.now(), this.clock.now()) as TriggerRow[]
    for (const row of rows) await this.runTrigger(row)
  }

  private async runTrigger(trigger: TriggerRow): Promise<void> {
    const claimed = this.agentDb
      .prepare("UPDATE automation_triggers SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(this.clock.now(), trigger.id)
    if (claimed.changes === 0) return
    const version = this.agentDb
      .prepare('SELECT id, specification_json, grant_json FROM automation_versions WHERE id = ?')
      .get(trigger.automation_version_id) as VersionRow | undefined
    if (!version) return
    const spec = AutomationSpecSchema.parse(JSON.parse(version.specification_json))
    const runId = `run:${trigger.id}`
    const now = this.clock.now()
    this.agentDb
      .prepare(
        `INSERT INTO automation_runs
         (id, automation_version_id, trigger_id, status, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?)
         ON CONFLICT(trigger_id) DO UPDATE SET status = 'running', lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(runId, version.id, trigger.id, now + LEASE_MS, now, now)
    try {
      const execute = (runSpec: AutomationSpec, payload: Record<string, unknown>) =>
        this.executeSpec(runId, trigger.id, version.id, runSpec, JSON.parse(version.grant_json) as AutomationGrant, payload)
      const result = await this.graphFactory(execute).run(runId, spec, JSON.parse(trigger.payload_json))
      this.agentDb
        .prepare("UPDATE automation_runs SET status = 'completed', result_json = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), this.clock.now(), runId)
      this.agentDb.prepare("UPDATE automation_triggers SET status = 'completed', updated_at = ? WHERE id = ?").run(
        this.clock.now(),
        trigger.id,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof AwaitingReconciliationError) {
        const at = this.clock.now()
        this.agentDb
          .prepare("UPDATE automation_triggers SET status = 'pending', last_error = ?, available_at = ?, updated_at = ? WHERE id = ?")
          .run(message, at + RECONCILIATION_RETRY_MS, at, trigger.id)
        this.agentDb
          .prepare("UPDATE automation_runs SET status = 'awaiting_reconciliation', last_error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
          .run(message, at, runId)
        return
      }
      const attempts = trigger.attempts + 1
      const abandoned = attempts >= 5
      this.agentDb
        .prepare(
          `UPDATE automation_triggers SET status = ?, attempts = ?, last_error = ?, available_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(abandoned ? 'failed' : 'pending', attempts, message, this.clock.now() + 2 ** attempts * 1000, this.clock.now(), trigger.id)
      this.agentDb
        .prepare("UPDATE automation_runs SET status = 'failed', last_error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(message, this.clock.now(), runId)
      if (abandoned) {
        this.agentDb.prepare("UPDATE automation_versions SET status = 'paused' WHERE id = ?").run(version.id)
      }
    }
  }

  private async executeSpec(
    runId: string,
    triggerId: string,
    versionId: string,
    spec: AutomationSpec,
    grantInput: AutomationGrant,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const accountId = Number(payload.accountId ?? spec.accountIds[0])
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : undefined
    const source = messageId ? getMessage(this.mailDb, accountId, messageId) : null
    const grant = { ...grantInput, usedThisRun: 0, usedToday: this.actionsUsedToday(versionId) }
    const results: StepResult[] = []
    for (const [index, action] of spec.actions.entries()) {
      const completed = this.completedStep(runId, index)
      if (completed) {
        results.push(completed)
        grant.usedThisRun += 1
        continue
      }
      if (grant.usedThisRun >= spec.limits.maxPerRun) throw new Error('Automation per-run limit exceeded')
      this.renewLease(runId)
      const stepId = deterministicStepId(triggerId, index)
      let result: StepResult
      if (action.kind === 'send') {
        const message = renderCompose(action.arguments, source)
        const proposed = await this.mailActions.requestAutomationSend(accountId, message, versionId, grant, stepId)
        if (proposed.status !== 'approved') throw new Error(proposed.decision.reason)
        const sent = await this.mailActions.executeApproved(proposed.intent.id)
        if (sent.status === 'uncertain' || sent.status === 'in_progress') {
          throw new AwaitingReconciliationError(sent.error ?? `Send ${sent.status}`)
        }
        if (sent.status !== 'sent') throw new Error(sent.error ?? `Send ${sent.status}`)
        result = { kind: action.kind, status: sent.status }
      } else if (action.kind === 'create_draft' || action.kind === 'update_draft') {
        await this.mailActions.saveDraft(accountId, stepId, renderCompose(action.arguments, source))
        result = { kind: action.kind, status: 'completed' }
      } else {
        const ids = messageId ? [messageId] : stringArray(action.arguments.messageIds)
        const intent = createActionIntent({
          kind: action.kind,
          accountId,
          arguments: { ...action.arguments, messageIds: ids },
          initiator: { type: 'automation', automationVersionId: versionId },
          source: 'automation_spec',
        })
        const proposed = await this.actions.propose(intent, grant)
        if (proposed.status !== 'approved') throw new Error(proposed.decision.reason)
        for (const id of ids) this.applyMailboxAction(accountId, id, action.kind, action.arguments)
        result = { kind: action.kind, status: 'queued' }
      }
      this.completeStep(runId, index, result)
      results.push(result)
      grant.usedThisRun += 1
      grant.usedToday += 1
    }
    return { actions: results, messageId: messageId ?? null }
  }

  private completedStep(runId: string, index: number): StepResult | null {
    const row = this.agentDb
      .prepare("SELECT result_json FROM automation_run_steps WHERE run_id = ? AND step_index = ? AND status = 'completed'")
      .get(runId, index) as { result_json: string } | undefined
    return row ? (JSON.parse(row.result_json) as StepResult) : null
  }

  private completeStep(runId: string, index: number, result: StepResult): void {
    this.agentDb
      .prepare(
        `INSERT INTO automation_run_steps (run_id, step_index, kind, status, result_json, updated_at)
         VALUES (?, ?, ?, 'completed', ?, ?)
         ON CONFLICT(run_id, step_index) DO UPDATE SET status = 'completed', result_json = excluded.result_json,
           updated_at = excluded.updated_at`,
      )
      .run(runId, index, result.kind, JSON.stringify(result), this.clock.now())
  }

  private renewLease(runId: string): void {
    const now = this.clock.now()
    this.agentDb
      .prepare("UPDATE automation_runs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(now + LEASE_MS, now, runId)
  }

  private applyMailboxAction(
    accountId: number,
    messageId: string,
    kind: string,
    args: Record<string, unknown>,
  ): void {
    const { add, remove } = labelChangesFor(kind as ActionKind, args)
    this.store.enqueueOutbox(accountId, messageId, add, remove)
  }

  private actionsUsedToday(versionId: string): number {
    const start = new Date(this.clock.now())
    start.setHours(0, 0, 0, 0)
    const row = this.agentDb
      .prepare(
        `SELECT COUNT(*) AS count FROM action_intents
         WHERE json_extract(initiator_json, '$.automationVersionId') = ? AND created_at >= ?`,
      )
      .get(versionId, start.getTime()) as { count: number }
    return row.count
  }

  private insertTrigger(versionId: string, key: string, dueAt: number, payload: Record<string, unknown>): string {
    const id = randomUUID()
    const now = this.clock.now()
    this.agentDb
      .prepare(
        `INSERT INTO automation_triggers
         (id, automation_version_id, trigger_key, due_at, payload_json, status, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(trigger_key) DO NOTHING`,
      )
      .run(id, versionId, key, dueAt, JSON.stringify(payload), dueAt, now, now)
    return id
  }

  private recoverExpiredLeases(): void {
    const expired = this.agentDb
      .prepare("SELECT trigger_id FROM automation_runs WHERE status = 'running' AND lease_expires_at < ?")
      .all(this.clock.now()) as { trigger_id: string }[]
    for (const { trigger_id } of expired) {
      this.agentDb.prepare("UPDATE automation_triggers SET status = 'pending' WHERE id = ? AND status = 'running'").run(trigger_id)
    }
  }
}

function deterministicStepId(triggerId: string, stepIndex: number): string {
  const hex = createHash('sha256').update(`${triggerId}:${stepIndex}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function isArrival(event: MailEventRow): boolean {
  if (event.kind !== 'message_upserted') return false
  if (event.origin === 'local_action') return true
  if (event.origin !== 'incremental') return false
  try {
    return (JSON.parse(event.payload_json) as { type?: string }).type === 'messageAdded'
  } catch {
    return false
  }
}

function selectCatchUp(occurrences: Date[], catchUp: AutomationSpec['catchUp'], now: number): Date[] {
  if (catchUp === 'skip') return occurrences.filter((occurrence) => occurrence.getTime() >= now - SKIP_GRACE_MS)
  if (catchUp === 'run_once') return occurrences.slice(-1)
  return occurrences.slice(-REPLAY_LIMIT)
}

function renderCompose(args: Record<string, unknown>, source: ReturnType<typeof getMessage>): ComposeMessage {
  const render = (value: unknown) =>
    String(value ?? '')
      .replaceAll('{{subject}}', source?.subject ?? '')
      .replaceAll('{{from}}', source?.from ?? '')
      .replaceAll('{{body}}', source?.bodyText ?? '')
  return {
    to: stringArray(args.to).map(render),
    cc: stringArray(args.cc).map(render),
    subject: render(args.subject),
    bodyText: render(args.bodyText),
    threadId: typeof args.threadId === 'string' ? render(args.threadId) : undefined,
    attachments: [],
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
