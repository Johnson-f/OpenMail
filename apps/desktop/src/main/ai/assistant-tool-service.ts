import {
  createActionIntent,
  labelChangesFor,
  type AssistantToolCall,
  type AssistantToolContext,
  type AssistantToolHandler,
  type AssistantToolResult,
} from '@gmail/agent'
import type { BrainTool } from '@gmail/intelligence'
import { z } from 'zod'
import type { SqliteMailStore } from '../db/store'
import type { ActionService } from './action-service'
import type { ComposeMessage, MailActionService } from './mail-action-service'

const AddressList = z.array(z.string().min(1)).max(200)
const ComposeSchema = z.object({
  to: AddressList,
  cc: AddressList.optional(),
  bcc: AddressList.optional(),
  subject: z.string().max(998),
  bodyText: z.string().max(5_000_000),
  bodyHtml: z.string().max(5_000_000).optional(),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).max(200).optional(),
})

const MessageSelection = z.object({ messageIds: z.array(z.string().min(1)).min(1).max(200) })
const LabelSelection = MessageSelection.extend({
  add: z.array(z.string()).max(50).default([]),
  remove: z.array(z.string()).max(50).default([]),
})
const ReadSelection = MessageSelection.extend({ read: z.boolean() })

const TOOL_DEFINITIONS: BrainTool[] = [
  {
    name: 'create_draft',
    description: 'Create a Gmail draft. This does not send the email.',
    parameters: composeJsonSchema(),
  },
  {
    name: 'send_email',
    description: 'Prepare an email for exact user approval before sending.',
    parameters: composeJsonSchema(),
  },
  {
    name: 'archive_messages',
    description: 'Archive specific mailbox messages by id.',
    parameters: selectionJsonSchema(),
  },
  {
    name: 'trash_messages',
    description: 'Move specific mailbox messages to Trash after user approval.',
    parameters: selectionJsonSchema(),
  },
  {
    name: 'label_messages',
    description: 'Add or remove Gmail labels on specific messages.',
    parameters: {
      ...selectionJsonSchema(),
      properties: {
        ...selectionJsonSchema().properties,
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
      },
      required: ['messageIds'],
    },
  },
  {
    name: 'mark_messages_read',
    description: 'Mark specific messages read or unread.',
    parameters: {
      ...selectionJsonSchema(),
      properties: {
        ...selectionJsonSchema().properties,
        read: { type: 'boolean' },
      },
      required: ['messageIds', 'read'],
    },
  },
]

export class AssistantToolService implements AssistantToolHandler {
  readonly definitions = TOOL_DEFINITIONS

  constructor(
    private readonly store: SqliteMailStore,
    private readonly actions: ActionService,
    private readonly mailActions: MailActionService,
    private readonly messageIdsInThreads: (accountId: number, threadIds: string[]) => string[],
  ) {}

  async execute(call: AssistantToolCall, context: AssistantToolContext): Promise<AssistantToolResult> {
    if (context.accountIds.length !== 1) {
      return result(call, 'denied', 'Select one account before requesting a mail action.')
    }
    const accountId = context.accountIds[0]!
    try {
      if (call.name === 'create_draft') {
        const message = ComposeSchema.parse(call.arguments)
        const intent = createActionIntent({
          kind: 'create_draft',
          accountId,
          arguments: { message },
          initiator: { type: 'chat', conversationId: context.conversationId },
          source: 'user_request',
        })
        const proposed = await this.actions.propose(intent)
        if (proposed.status !== 'approved') return result(call, proposed.status === 'pending' ? 'pending' : 'denied', proposed.decision.reason)
        await this.mailActions.saveDraft(accountId, undefined, message)
        this.actions.recordExecution(intent.id, 'completed', { result: 'draft_saved' })
        return result(call, 'completed', 'Draft saved to Gmail. Review it in Drafts before sending.')
      }
      if (call.name === 'send_email') {
        const message = ComposeSchema.parse(call.arguments)
        const proposed = await this.mailActions.requestSend(accountId, message, context.conversationId)
        return result(
          call,
          proposed.status === 'pending' ? 'pending' : proposed.status === 'approved' ? 'completed' : 'denied',
          proposed.status === 'pending'
            ? 'Email prepared and waiting in Approvals. Review the exact recipients and content before it sends.'
            : proposed.decision.reason,
        )
      }

      const selected = this.resolveMessageIds(call)
      if (!selected.success) {
        return result(call, 'denied', 'messageIds is required: name the specific messages for this action.')
      }
      const ids = selected.ids
      const outside = this.idsOutsideContext(accountId, ids, context)
      if (outside.length > 0) {
        return result(
          call,
          'denied',
          `Messages were not part of this conversation's retrieved mail: ${outside.slice(0, 5).join(', ')}.`,
        )
      }
      const action = actionForTool(call, ids)
      const intent = createActionIntent({
        ...action,
        accountId,
        initiator: { type: 'chat', conversationId: context.conversationId },
        source: 'user_request',
      })
      const proposed = await this.actions.propose(intent)
      if (proposed.status === 'approved') return this.executeApproved(intent.id, call)
      return result(
        call,
        proposed.status === 'pending' ? 'pending' : 'denied',
        proposed.status === 'pending'
          ? `${ids.length} message action is waiting in Approvals.`
          : proposed.decision.reason,
      )
    } catch (error) {
      return result(call, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  executeApproved(intentId: string, call?: Pick<AssistantToolCall, 'id' | 'name'>): AssistantToolResult {
    const intent = this.actions.getIntent(intentId)
    const fallback = call ?? { id: intentId, name: intent?.kind ?? 'mail_action' }
    if (!intent) return result(fallback, 'failed', 'Approved action was not found.')
    if (this.actions.status(intentId) !== 'approved') return result(fallback, 'denied', 'Action is not approved.')
    const messageIds = z.array(z.string()).parse(intent.arguments.messageIds ?? [])
    for (const messageId of messageIds) {
      if (!this.store.getMessage(intent.accountId, messageId)) {
        return result(fallback, 'denied', `Message ${messageId} is outside the approved account.`)
      }
    }
    const labels = labelChangesFor(intent.kind, intent.arguments)
    for (const messageId of messageIds) {
      this.store.enqueueOutbox(intent.accountId, messageId, labels.add, labels.remove)
    }
    this.actions.recordExecution(intent.id, 'completed', {
      messageCount: messageIds.length,
      add: labels.add,
      remove: labels.remove,
    })
    return result(fallback, 'completed', `${messageIds.length} message action queued for Gmail sync.`)
  }

  private resolveMessageIds(call: AssistantToolCall): { success: true; ids: string[] } | { success: false } {
    const schema = call.name === 'label_messages'
      ? LabelSelection
      : call.name === 'mark_messages_read'
        ? ReadSelection
        : MessageSelection
    const parsed = schema.safeParse(call.arguments)
    return parsed.success ? { success: true, ids: Array.from(new Set(parsed.data.messageIds)) } : { success: false }
  }

  private idsOutsideContext(accountId: number, ids: string[], context: AssistantToolContext): string[] {
    const allowed = new Set([
      ...context.evidence.map((item) => item.messageId),
      ...(context.referencedMessageIds ?? []),
    ])
    const unknown = ids.filter((id) => !allowed.has(id))
    if (unknown.length === 0 || !context.threadIds?.length) return unknown
    const inThreads = new Set(this.messageIdsInThreads(accountId, context.threadIds))
    return unknown.filter((id) => !inThreads.has(id))
  }
}

function actionForTool(
  call: AssistantToolCall,
  messageIds: string[],
): { kind: 'archive' | 'trash' | 'modify_labels'; arguments: Record<string, unknown> } {
  if (call.name === 'archive_messages') return { kind: 'archive', arguments: { messageIds } }
  if (call.name === 'trash_messages') return { kind: 'trash', arguments: { messageIds } }
  if (call.name === 'mark_messages_read') {
    const { read } = ReadSelection.parse(call.arguments)
    return {
      kind: 'modify_labels',
      arguments: { messageIds, add: read ? [] : ['UNREAD'], remove: read ? ['UNREAD'] : [] },
    }
  }
  if (call.name === 'label_messages') {
    const { add, remove } = LabelSelection.parse(call.arguments)
    return { kind: 'modify_labels', arguments: { messageIds, add, remove } }
  }
  throw new Error(`Unknown assistant tool: ${call.name}`)
}

function result(
  call: Pick<AssistantToolCall, 'id' | 'name'>,
  status: AssistantToolResult['status'],
  message: string,
): AssistantToolResult {
  return { callId: call.id, name: call.name, status, message }
}

function composeJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      to: { type: 'array', items: { type: 'string' } },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      bodyText: { type: 'string' },
      bodyHtml: { type: 'string' },
      threadId: { type: 'string' },
      inReplyTo: { type: 'string' },
      references: { type: 'array', items: { type: 'string' } },
    },
    required: ['to', 'subject', 'bodyText'],
  }
}

function selectionJsonSchema(): { type: string; additionalProperties: boolean; properties: Record<string, unknown>; required?: string[] } {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { messageIds: { type: 'array', items: { type: 'string' }, minItems: 1 } },
    required: ['messageIds'],
  }
}
