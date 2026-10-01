import { randomUUID } from 'node:crypto'
import type { StoredMessage } from '@gmail/core'
import { buildWritingProfile, profilePrompt, type WritingProfile } from '@gmail/agent'
import type { Db } from '../db/index'
import { getMessage } from '../db/messages'

const REBUILD_BATCH_SIZE = 200

export type WritingProfileRecord = {
  relationshipKey: string
  version: number
  enabled: boolean
  profile: WritingProfile
}

export class WritingProfileService {
  constructor(
    private readonly mailDb: Db,
    private readonly agentDb: Db,
  ) {}

  async rebuild(accountId: number): Promise<WritingProfileRecord[]> {
    const ids = this.mailDb
      .prepare(
        `SELECT DISTINCT m.id FROM messages m
         JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id
         WHERE m.account_id = ? AND ml.label_id = 'SENT'
         ORDER BY m.internal_date DESC`,
      )
      .all(accountId) as { id: string }[]
    const exclusions = this.exclusions(accountId)
    const messages: StoredMessage[] = []
    for (let start = 0; start < ids.length; start += REBUILD_BATCH_SIZE) {
      for (const { id } of ids.slice(start, start + REBUILD_BATCH_SIZE)) {
        const message = getMessage(this.mailDb, accountId, id)
        if (message && !exclusions.has(`message:${id}`)) messages.push(message)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    const profiles: Array<{ key: string; profile: WritingProfile }> = [
      { key: '*', profile: buildWritingProfile(messages) },
    ]
    const byRecipient = new Map<string, typeof messages>()
    for (const message of messages) {
      for (const recipient of message.to) {
        const key = normalizeAddress(recipient)
        if (!key || exclusions.has(`recipient:${key}`)) continue
        const group = byRecipient.get(key) ?? []
        group.push(message)
        byRecipient.set(key, group)
      }
    }
    for (const [key, group] of byRecipient) profiles.push({ key, profile: buildWritingProfile(group) })

    this.agentDb.transaction(() => {
      for (const { key, profile } of profiles) this.save(accountId, key, profile)
    })()
    return this.list(accountId)
  }

  list(accountId: number): WritingProfileRecord[] {
    const rows = this.agentDb
      .prepare(
        `SELECT relationship_key AS relationshipKey, version, profile_json AS profileJson, enabled
         FROM writing_profiles WHERE account_id = ? ORDER BY relationship_key, version DESC`,
      )
      .all(accountId) as Array<{ relationshipKey: string; version: number; profileJson: string; enabled: number }>
    const seen = new Set<string>()
    return rows.flatMap((row) => {
      if (seen.has(row.relationshipKey)) return []
      seen.add(row.relationshipKey)
      return [{
        relationshipKey: row.relationshipKey,
        version: row.version,
        enabled: row.enabled === 1,
        profile: JSON.parse(row.profileJson) as WritingProfile,
      }]
    })
  }

  setEnabled(accountId: number, relationshipKey: string, enabled: boolean): void {
    this.agentDb
      .prepare('UPDATE writing_profiles SET enabled = ?, updated_at = ? WHERE account_id = ? AND relationship_key = ?')
      .run(enabled ? 1 : 0, Date.now(), accountId, relationshipKey)
  }

  reset(accountId: number): void {
    this.agentDb.prepare('DELETE FROM writing_profiles WHERE account_id = ?').run(accountId)
    this.agentDb.prepare('DELETE FROM writing_profile_edits WHERE account_id = ?').run(accountId)
  }

  recordEdit(accountId: number, recipients: string[], before: string, after: string): void {
    const key = normalizeAddress(recipients[0] ?? '') || '*'
    this.agentDb
      .prepare(
        `INSERT INTO writing_profile_edits
         (account_id, relationship_key, before_text, after_text, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(accountId, key, before, after, Date.now())
  }

  context(accountId: number, recipients: string[]): { prompt: string; examples: string[] } {
    const profiles = this.list(accountId).filter((record) => record.enabled)
    const global = profiles.find((record) => record.relationshipKey === '*')?.profile ?? buildWritingProfile([])
    const relationship = profiles.find((record) =>
      recipients.some((recipient) => normalizeAddress(recipient) === record.relationshipKey),
    )?.profile
    const examples = this.sentExamples(accountId, recipients, 3)
    const relationshipKey = normalizeAddress(recipients[0] ?? '') || '*'
    const edits = this.agentDb
      .prepare(
        `SELECT after_text AS afterText FROM writing_profile_edits
         WHERE account_id = ? AND relationship_key IN (?, '*')
         ORDER BY created_at DESC LIMIT 3`,
      )
      .all(accountId, relationshipKey) as Array<{ afterText: string }>
    const editPrompt = edits.length
      ? ` Recent accepted user edits are authoritative style signals: ${edits.map((edit) => JSON.stringify(edit.afterText)).join(' ')}`
      : ''
    return { prompt: `${profilePrompt(global, relationship)}${editPrompt}`, examples }
  }

  export(accountId: number): string {
    return JSON.stringify({ version: 1, accountId, profiles: this.list(accountId) }, null, 2)
  }

  private save(accountId: number, relationshipKey: string, profile: WritingProfile): void {
    const previous = this.agentDb
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM writing_profiles WHERE account_id = ? AND relationship_key = ?')
      .get(accountId, relationshipKey) as { version: number }
    const now = Date.now()
    this.agentDb
      .prepare(
        `INSERT INTO writing_profiles
         (id, account_id, relationship_key, version, profile_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(randomUUID(), accountId, relationshipKey, previous.version + 1, JSON.stringify(profile), now, now)
  }

  private sentExamples(accountId: number, recipients: string[], limit: number): string[] {
    const keys = new Set(recipients.map(normalizeAddress).filter(Boolean))
    const rows = this.mailDb
      .prepare(
        `SELECT m.id FROM messages m
         JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'SENT'
         WHERE m.account_id = ? ORDER BY m.internal_date DESC LIMIT 100`,
      )
      .all(accountId) as { id: string }[]
    return rows.flatMap(({ id }) => {
      const message = getMessage(this.mailDb, accountId, id)
      return message && message.to.some((recipient) => keys.has(normalizeAddress(recipient))) ? [message.bodyText] : []
    }).slice(0, limit)
  }

  private exclusions(accountId: number): Set<string> {
    const rows = this.agentDb
      .prepare('SELECT exclusion_type AS type, exclusion_value AS value FROM writing_profile_exclusions WHERE account_id = ?')
      .all(accountId) as Array<{ type: string; value: string }>
    return new Set(rows.map((row) => `${row.type}:${row.value}`))
  }
}

function normalizeAddress(value: string): string {
  return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase()
}
