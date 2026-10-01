import type { AutomationSpec } from '@gmail/agent'
import type { getMessage } from '../db/messages'

type StoredMessage = NonNullable<ReturnType<typeof getMessage>>

export function matchesConditions(spec: AutomationSpec, message: StoredMessage): boolean {
  const query = spec.conditions.query?.toLowerCase()
  if (query && !`${message.subject}\n${message.bodyText}`.toLowerCase().includes(query)) return false
  if (
    spec.conditions.senders.length &&
    !spec.conditions.senders.some((sender) => message.from.toLowerCase().includes(sender.toLowerCase()))
  ) {
    return false
  }
  return true
}

export function matchesTriggerLabels(spec: AutomationSpec, labelIds: string[]): boolean {
  if (spec.trigger.type !== 'mail_event') return false
  if (spec.trigger.event === 'sent_message') return labelIds.includes('SENT')
  if (spec.trigger.event === 'new_message') {
    return !labelIds.includes('SENT') && labelIds.some((label) => spec.mailboxIds.includes(label))
  }
  return true
}
