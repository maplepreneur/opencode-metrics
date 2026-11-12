import type { ExportData, LineRecord, PullRequestRecord, SessionAssignment, UsageRecord } from "./types.js"

export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

const PREFIX = {
  usage: "usage/v1/",
  lines: "lines/v1/",
  pr: "pr/v1/",
  assignment: "assignment/v1/",
}

function key(prefix: string, id: string): string {
  return `${prefix}${encodeURIComponent(id)}`
}

export class MetricsStore {
  constructor(private readonly storage: Storage) {}

  async usage(record: UsageRecord): Promise<void> {
    await this.storage.set(key(PREFIX.usage, record.id), record)
  }

  async removeUsage(id: string): Promise<void> {
    await this.storage.remove(key(PREFIX.usage, id))
  }

  async lines(record: LineRecord): Promise<void> {
    await this.storage.set(key(PREFIX.lines, record.id), record)
  }

  async pullRequest(record: PullRequestRecord): Promise<void> {
    await this.storage.set(key(PREFIX.pr, record.key), record)
  }

  async assign(assignment: SessionAssignment): Promise<void> {
    await this.storage.set(key(PREFIX.assignment, assignment.sessionID), assignment)
  }

  async unassign(sessionID: string): Promise<void> {
    // An empty PR key is an explicit opt-out of branch attribution.
    await this.storage.set(key(PREFIX.assignment, sessionID), {
      sessionID,
      projectID: "",
      prKey: "",
      updatedAt: Date.now(),
    } satisfies SessionAssignment)
  }

  private async scan<T>(prefix: string): Promise<T[]> {
    const values: T[] = []
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix, after, limit: 500 })
      for (const entry of page.entries) values.push(entry.value as T)
      after = page.next
    } while (after)
    return values
  }

  async export(): Promise<ExportData> {
    const [usage, lines, pullRequests, assignments] = await Promise.all([
      this.scan<UsageRecord>(PREFIX.usage),
      this.scan<LineRecord>(PREFIX.lines),
      this.scan<PullRequestRecord>(PREFIX.pr),
      this.scan<SessionAssignment>(PREFIX.assignment),
    ])
    return {
      version: 1,
      exportedAt: Date.now(),
      usage,
      lines,
      pullRequests,
      assignments,
    }
  }
}
