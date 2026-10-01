import type { ActionIntent, AutomationGrant, PolicyDecision } from '@gmail/agent'
import { ActionApprovalGraph, ActionIntentSchema, PolicyEngine } from '@gmail/agent'
import type { Db } from '../db/index'

export type PendingAction = { intent: ActionIntent; decision: PolicyDecision; status: string }

export class ActionService {
  constructor(
    private readonly db: Db,
    private readonly policy: PolicyEngine,
    private readonly approvals: ActionApprovalGraph,
  ) {}

  async propose(intent: ActionIntent, grant?: AutomationGrant): Promise<PendingAction> {
    ActionIntentSchema.parse(intent)
    const decision = this.policy.decide(intent, grant)
    this.persist(intent, decision, 'proposed')
    const status = await this.approvals.start(intent, decision)
    this.setStatus(intent.id, status)
    this.audit(intent.id, `policy_${decision.result}`, { reason: decision.reason, status })
    return { intent, decision, status }
  }

  listPending(): PendingAction[] {
    this.expireStale()
    const rows = this.db
      .prepare("SELECT * FROM action_intents WHERE status = 'pending' ORDER BY created_at")
      .all() as Array<{
      id: string
      kind: string
      account_id: number
      arguments_json: string
      content_hash: string
      initiator_json: string
      expires_at: number
      created_at: number
    }>
    return rows.map((row) => ({
      intent: ActionIntentSchema.parse({
        id: row.id,
        kind: row.kind,
        accountId: row.account_id,
        arguments: JSON.parse(row.arguments_json),
        contentHash: row.content_hash,
        initiator: JSON.parse(row.initiator_json),
        source: JSON.parse(row.initiator_json).type === 'chat' ? 'user_request' : 'automation_spec',
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }),
      decision: { result: 'ask', reason: 'Awaiting user review' },
      status: 'pending',
    }))
  }

  getIntent(intentId: string): ActionIntent | null {
    const row = this.db.prepare('SELECT * FROM action_intents WHERE id = ?').get(intentId) as
      | {
          id: string
          kind: string
          account_id: number
          arguments_json: string
          content_hash: string
          initiator_json: string
          status: string
          expires_at: number
          created_at: number
        }
      | undefined
    if (!row) return null
    const initiator = JSON.parse(row.initiator_json) as ActionIntent['initiator']
    return ActionIntentSchema.parse({
      id: row.id,
      kind: row.kind,
      accountId: row.account_id,
      arguments: JSON.parse(row.arguments_json),
      contentHash: row.content_hash,
      initiator,
      source: initiator.type === 'chat' ? 'user_request' : 'automation_spec',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    })
  }

  status(intentId: string): string | null {
    return (this.db.prepare('SELECT status FROM action_intents WHERE id = ?').get(intentId) as
      | { status: string }
      | undefined)?.status ?? null
  }

  recordExecution(
    intentId: string,
    status: 'completed' | 'failed' | 'uncertain',
    details: unknown = {},
  ): void {
    this.setStatus(intentId, status)
    this.audit(intentId, `execution_${status}`, details)
  }

  async review(intentId: string, expectedHash: string, approved: boolean): Promise<'approved' | 'denied'> {
    const claimed = this.db
      .prepare(
        `UPDATE action_intents SET status = 'reviewing', updated_at = ?
         WHERE id = ? AND status = 'pending' AND content_hash = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(Date.now(), intentId, expectedHash, Date.now())
    if (claimed.changes !== 1) throw this.reviewRejection(intentId, expectedHash)
    let status: 'approved' | 'denied'
    try {
      status = await this.approvals.resume(intentId, approved)
    } catch (error) {
      this.setStatus(intentId, 'pending')
      throw error
    }
    this.setStatus(intentId, status)
    this.audit(intentId, approved ? 'approved' : 'rejected', {})
    return status
  }

  private reviewRejection(intentId: string, expectedHash: string): Error {
    const row = this.db
      .prepare('SELECT content_hash, status, expires_at FROM action_intents WHERE id = ?')
      .get(intentId) as { content_hash: string; status: string; expires_at: number | null } | undefined
    if (!row) return new Error('Action intent was not found')
    if (row.status !== 'pending') return new Error('Action intent is no longer pending')
    if (row.content_hash !== expectedHash) return new Error('Action content changed after review began')
    return new Error('Action intent has expired')
  }

  private expireStale(): void {
    const now = Date.now()
    const stale = this.db
      .prepare("SELECT id FROM action_intents WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as Array<{ id: string }>
    for (const { id } of stale) {
      const changed = this.db
        .prepare("UPDATE action_intents SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(now, id)
      if (changed.changes === 1) this.audit(id, 'expired', {})
    }
  }

  private persist(intent: ActionIntent, decision: PolicyDecision, status: string): void {
    this.db
      .prepare(
        `INSERT INTO action_intents
         (id, kind, account_id, arguments_json, content_hash, initiator_json, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.id,
        intent.kind,
        intent.accountId,
        JSON.stringify(intent.arguments),
        intent.contentHash,
        JSON.stringify(intent.initiator),
        status,
        intent.expiresAt,
        intent.createdAt,
        Date.now(),
      )
    this.audit(intent.id, 'proposed', { decision })
  }

  private setStatus(intentId: string, status: string): void {
    this.db.prepare('UPDATE action_intents SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), intentId)
  }

  private audit(intentId: string, eventType: string, details: unknown): void {
    this.db
      .prepare(
        'INSERT INTO audit_events (action_intent_id, event_type, details_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(intentId, eventType, JSON.stringify(details), Date.now())
  }
}
