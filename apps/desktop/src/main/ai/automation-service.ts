import { randomUUID } from 'node:crypto'
import {
  AutomationSpecSchema,
  grantForSpec,
  privilegeExpansion,
  type AutomationBuilder,
  type AutomationSimulation,
  type AutomationSpec,
} from '@gmail/agent'
import type { Db } from '../db/index'
import { getMessage } from '../db/messages'
import { matchesConditions, matchesTriggerLabels } from '../automation/matching'

export class AutomationService {
  constructor(
    private readonly mailDb: Db,
    private readonly agentDb: Db,
    private readonly builder: AutomationBuilder,
    private readonly onActivated?: () => void,
  ) {}

  build(instruction: string, defaultAccountId: number, timezone: string): Promise<AutomationSpec> {
    return this.builder.build({ instruction, defaultAccountId, timezone })
  }

  simulate(specInput: AutomationSpec): { id: string; result: AutomationSimulation } {
    const spec = AutomationSpecSchema.parse(specInput)
    const candidates = this.matchingMessages(spec, 100)
    const result: AutomationSimulation = {
      matchedMessageIds: candidates.map((message) => message.id),
      examples: candidates.slice(0, 10).map((message) => ({
        messageId: message.id,
        subject: message.subject,
        from: message.from,
        proposedActions: spec.actions.map((action) => action.kind),
      })),
      requiredGrant: grantForSpec(spec),
      warnings: [
        ...(candidates.length >= 100 ? ['Simulation reached the 100-message preview limit'] : []),
        ...(spec.actions.some((action) => action.kind === 'send') ? ['This automation requests automatic send permission'] : []),
      ],
    }
    const id = randomUUID()
    this.agentDb
      .prepare(
        `INSERT INTO automation_simulations
         (id, automation_id, version, specification_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, spec.automationId, spec.version, JSON.stringify(spec), JSON.stringify(result), Date.now())
    return { id, result }
  }

  activate(specInput: AutomationSpec, simulationId: string): void {
    const spec = AutomationSpecSchema.parse({ ...specInput, enabled: true })
    const simulation = this.agentDb
      .prepare('SELECT specification_json FROM automation_simulations WHERE id = ? AND automation_id = ? AND version = ?')
      .get(simulationId, spec.automationId, spec.version) as { specification_json: string } | undefined
    if (!simulation) throw new Error('Automation must be simulated before activation')
    const simulated = AutomationSpecSchema.parse(JSON.parse(simulation.specification_json))
    if (JSON.stringify({ ...simulated, enabled: true }) !== JSON.stringify(spec)) {
      throw new Error('Automation changed after simulation')
    }
    const previous = this.latest(spec.automationId)
    if (previous && spec.version <= previous.version) throw new Error('Automation version must increase')
    const expansion = previous ? privilegeExpansion(previous, spec) : []
    this.agentDb
      .prepare(
        `INSERT INTO automation_versions
         (id, automation_id, version, specification_json, grant_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(randomUUID(), spec.automationId, spec.version, JSON.stringify(spec), JSON.stringify(grantForSpec(spec)), Date.now())
    if (previous) {
      this.agentDb
        .prepare("UPDATE automation_versions SET status = 'archived' WHERE automation_id = ? AND version < ?")
        .run(spec.automationId, spec.version)
    }
    this.onActivated?.()
    if (expansion.length) {
      // The matching simulation is the explicit approval artifact for this privilege-expanding version.
    }
  }

  list(): AutomationSpec[] {
    const rows = this.agentDb
      .prepare('SELECT specification_json FROM automation_versions ORDER BY created_at DESC')
      .all() as { specification_json: string }[]
    return rows.map((row) => AutomationSpecSchema.parse(JSON.parse(row.specification_json)))
  }

  records(): Array<{ versionId: string; spec: AutomationSpec; status: string }> {
    const rows = this.agentDb
      .prepare('SELECT id, specification_json, status FROM automation_versions ORDER BY created_at DESC')
      .all() as Array<{ id: string; specification_json: string; status: string }>
    return rows.map((row) => ({
      versionId: row.id,
      spec: AutomationSpecSchema.parse(JSON.parse(row.specification_json)),
      status: row.status,
    }))
  }

  setStatus(versionId: string, status: 'active' | 'paused' | 'archived'): void {
    const result = this.agentDb
      .prepare('UPDATE automation_versions SET status = ? WHERE id = ?')
      .run(status, versionId)
    if (result.changes === 0) throw new Error('Automation version was not found')
  }

  runs(versionId: string): Array<{
    id: string
    status: string
    result: unknown
    lastError: string | null
    updatedAt: number
  }> {
    const rows = this.agentDb
      .prepare(
        `SELECT id, status, result_json AS resultJson, last_error AS lastError, updated_at AS updatedAt
         FROM automation_runs WHERE automation_version_id = ? ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(versionId) as Array<{
      id: string
      status: string
      resultJson: string | null
      lastError: string | null
      updatedAt: number
    }>
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      result: row.resultJson ? JSON.parse(row.resultJson) : null,
      lastError: row.lastError,
      updatedAt: row.updatedAt,
    }))
  }

  latest(automationId: string): AutomationSpec | null {
    const row = this.agentDb
      .prepare('SELECT specification_json FROM automation_versions WHERE automation_id = ? ORDER BY version DESC LIMIT 1')
      .get(automationId) as { specification_json: string } | undefined
    return row ? AutomationSpecSchema.parse(JSON.parse(row.specification_json)) : null
  }

  private matchingMessages(spec: AutomationSpec, limit: number) {
    const placeholders = spec.accountIds.map(() => '?').join(',')
    const rows = this.mailDb
      .prepare(
        `SELECT id, account_id AS accountId FROM messages
         WHERE account_id IN (${placeholders})
         ORDER BY internal_date DESC LIMIT ?`,
      )
      .all(...spec.accountIds, limit * 3) as Array<{ id: string; accountId: number }>
    return rows
      .flatMap((row) => {
        const message = getMessage(this.mailDb, row.accountId, row.id)
        return message ? [message] : []
      })
      .filter((message) => spec.trigger.type !== 'mail_event' || matchesTriggerLabels(spec, message.labelIds))
      .filter((message) => matchesConditions(spec, message))
      .slice(0, limit)
  }
}
