import { createHash, randomUUID } from 'node:crypto'
import { Command, END, START, StateGraph, StateSchema, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph'
import { z } from 'zod'

export const ActionKindSchema = z.enum([
  'create_draft',
  'update_draft',
  'modify_labels',
  'archive',
  'trash',
  'spam',
  'restore',
  'send',
])
export type ActionKind = z.infer<typeof ActionKindSchema>

export const ActionIntentSchema = z.object({
  id: z.string(),
  kind: ActionKindSchema,
  accountId: z.number().int().positive(),
  arguments: z.record(z.string(), z.unknown()),
  contentHash: z.string(),
  initiator: z.discriminatedUnion('type', [
    z.object({ type: z.literal('chat'), conversationId: z.string() }),
    z.object({ type: z.literal('automation'), automationVersionId: z.string() }),
  ]),
  source: z.enum(['user_request', 'automation_spec']),
  createdAt: z.number(),
  expiresAt: z.number(),
})
export type ActionIntent = z.infer<typeof ActionIntentSchema>

export type AutomationGrant = {
  accountIds: number[]
  tools: ActionKind[]
  recipientDomains: string[]
  recipients: string[]
  allowAttachments: boolean
  maxPerRun: number
  maxPerDay: number
  usedThisRun: number
  usedToday: number
  expiresAt: number
}

export type PolicyDecision = { result: 'allow' | 'ask' | 'deny'; reason: string }

export class PolicyEngine {
  decide(intent: ActionIntent, grant?: AutomationGrant): PolicyDecision {
    ActionIntentSchema.parse(intent)
    const { contentHash, ...hashInput } = intent
    if (actionHash(hashInput) !== contentHash) {
      return { result: 'deny', reason: 'Action intent content hash does not match its arguments' }
    }
    if (intent.source === 'user_request' && intent.initiator.type !== 'chat') {
      return { result: 'deny', reason: 'User requests must originate from a conversation' }
    }
    if (intent.source === 'automation_spec' && intent.initiator.type !== 'automation') {
      return { result: 'deny', reason: 'Automation actions must originate from an immutable version' }
    }
    if (intent.expiresAt <= Date.now()) return { result: 'deny', reason: 'Action intent expired' }

    if (intent.initiator.type === 'automation') return this.automationDecision(intent, grant)
    const kind = effectiveKind(intent)
    if (kind === 'create_draft' || kind === 'update_draft') {
      return { result: 'allow', reason: 'Drafting does not send mail' }
    }
    if (kind === 'send' || ['trash', 'spam', 'restore'].includes(kind)) {
      return { result: 'ask', reason: 'Sensitive actions require exact user confirmation' }
    }
    const count = actionCount(intent.arguments)
    return count <= 20
      ? { result: 'allow', reason: 'Small reversible mailbox action' }
      : { result: 'ask', reason: 'Bulk actions affecting more than 20 messages require preview' }
  }

  private automationDecision(intent: ActionIntent, grant: AutomationGrant | undefined): PolicyDecision {
    if (!grant) return { result: 'deny', reason: 'Automation has no active grant' }
    if (grant.expiresAt <= Date.now()) return { result: 'deny', reason: 'Automation grant expired' }
    if (!grant.accountIds.includes(intent.accountId)) return { result: 'deny', reason: 'Account is outside the grant' }
    if (!grant.tools.includes(effectiveKind(intent))) return { result: 'deny', reason: 'Tool is outside the grant' }
    if (grant.usedThisRun + 1 > grant.maxPerRun || grant.usedToday + 1 > grant.maxPerDay) {
      return { result: 'deny', reason: 'Automation action limit exceeded' }
    }
    if (intent.kind === 'send') {
      const recipients = recipientList(intent.arguments)
      if (recipients.length === 0) return { result: 'deny', reason: 'Send has no recipients' }
      const allowed = recipients.every(
        (recipient) =>
          grant.recipients.includes(recipient) ||
          grant.recipientDomains.includes(recipient.split('@').at(-1)?.toLowerCase() ?? ''),
      )
      if (!allowed) return { result: 'deny', reason: 'Recipient is outside the grant' }
      if (!grant.allowAttachments && attachmentCount(intent.arguments) > 0) {
        return { result: 'deny', reason: 'Attachments are outside the grant' }
      }
    }
    return { result: 'allow', reason: 'Action is covered by the immutable automation grant' }
  }
}

export function createActionIntent(input: {
  kind: ActionKind
  accountId: number
  arguments: Record<string, unknown>
  initiator: ActionIntent['initiator']
  source: ActionIntent['source']
  now?: number
  ttlMs?: number
}): ActionIntent {
  const now = input.now ?? Date.now()
  const base = {
    id: randomUUID(),
    kind: input.kind,
    accountId: input.accountId,
    arguments: input.arguments,
    initiator: input.initiator,
    source: input.source,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? 30 * 60_000),
  }
  return ActionIntentSchema.parse({ ...base, contentHash: actionHash(base) })
}

export function actionHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

const ApprovalState = new StateSchema({
  intent: ActionIntentSchema,
  decision: z.enum(['allow', 'ask', 'deny']),
  status: z.enum(['approved', 'pending', 'denied']).default('pending'),
})

export class ActionApprovalGraph {
  private readonly graph

  constructor(checkpointer: BaseCheckpointSaver) {
    const review: typeof ApprovalState.Node = (state) => {
      if (state.decision === 'allow') return { status: 'approved' }
      if (state.decision === 'deny') return { status: 'denied' }
      const approved = interrupt({ type: 'action_approval', intent: state.intent })
      return { status: approved === true ? 'approved' : 'denied' }
    }
    this.graph = new StateGraph(ApprovalState)
      .addNode('review', review)
      .addEdge(START, 'review')
      .addEdge('review', END)
      .compile({ checkpointer })
  }

  async start(intent: ActionIntent, decision: PolicyDecision): Promise<'approved' | 'pending' | 'denied'> {
    const result = (await this.graph.invoke(
      { intent, decision: decision.result },
      { configurable: { thread_id: `action:${intent.id}` } },
    )) as typeof ApprovalState.State & { __interrupt__?: unknown }
    return result.__interrupt__ ? 'pending' : result.status
  }

  async resume(intentId: string, approved: boolean): Promise<'approved' | 'denied'> {
    const result = await this.graph.invoke(new Command({ resume: approved }), {
      configurable: { thread_id: `action:${intentId}` },
    })
    return result.status as 'approved' | 'denied'
  }
}

const MAILBOX_LABEL_CHANGES: Partial<Record<ActionKind, { add: string[]; remove: string[] }>> = {
  archive: { add: [], remove: ['INBOX'] },
  trash: { add: ['TRASH'], remove: ['INBOX'] },
  spam: { add: ['SPAM'], remove: ['INBOX'] },
  restore: { add: ['INBOX'], remove: ['TRASH', 'SPAM'] },
}

/** The Gmail label delta a mailbox action applies to each of its messages. */
export function labelChangesFor(kind: ActionKind, args: Record<string, unknown>): { add: string[]; remove: string[] } {
  const fixed = MAILBOX_LABEL_CHANGES[kind]
  if (fixed) return { add: [...fixed.add], remove: [...fixed.remove] }
  if (kind !== 'modify_labels') throw new Error(`${kind} is not a mailbox label action`)
  return { add: stringList(args.add), remove: stringList(args.remove) }
}

/**
 * What an intent actually does to the mailbox. A `modify_labels` that adds
 * TRASH or SPAM is a trash or spam, and removing either is a restore, so the
 * policy cannot be sidestepped by choosing a milder action kind.
 */
export function effectiveKind(intent: Pick<ActionIntent, 'kind' | 'arguments'>): ActionKind {
  if (intent.kind !== 'modify_labels') return intent.kind
  const { add, remove } = labelChangesFor('modify_labels', intent.arguments)
  if (add.includes('TRASH')) return 'trash'
  if (add.includes('SPAM')) return 'spam'
  if (remove.includes('TRASH') || remove.includes('SPAM')) return 'restore'
  return 'modify_labels'
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function actionCount(args: Record<string, unknown>): number {
  return Array.isArray(args.messageIds) ? args.messageIds.length : 1
}

function recipientList(args: Record<string, unknown>): string[] {
  return ['to', 'cc', 'bcc'].flatMap((key) =>
    Array.isArray(args[key]) ? (args[key] as unknown[]).filter((value): value is string => typeof value === 'string') : [],
  )
}

function attachmentCount(args: Record<string, unknown>): number {
  return Array.isArray(args.attachments) ? args.attachments.length : 0
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
