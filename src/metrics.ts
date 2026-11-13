import { basename } from "node:path"
import type {
  DayMetrics,
  ExportData,
  LineRecord,
  Metrics,
  ModelGroupMetrics,
  ModelMetrics,
  Price,
  ProjectMetrics,
  PullRequestMetrics,
  Report,
  ReportFilter,
  SessionAssignment,
  TokenUsage,
  UsageRecord,
} from "./types.js"

export const EMPTY_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

export function normalizeTokens(value: unknown): TokenUsage {
  const tokens = (value ?? {}) as Partial<TokenUsage>
  return {
    input: number(tokens.input),
    output: number(tokens.output),
    reasoning: number(tokens.reasoning),
    cache: {
      read: number(tokens.cache?.read),
      write: number(tokens.cache?.write),
    },
  }
}

export function totalTokens(tokens: TokenUsage): number {
  // Reasoning is reported separately by OpenCode. Cache remains separate to
  // avoid presenting cached tokens as fresh input tokens.
  return tokens.input + tokens.output + tokens.reasoning
}

export function estimateCost(tokens: TokenUsage, prices: Price | undefined): number | undefined {
  if (!prices) return undefined
  const cost =
    (tokens.input * prices.input +
      (tokens.output + tokens.reasoning) * prices.output +
      tokens.cache.read * prices.cacheRead +
      tokens.cache.write * prices.cacheWrite) /
    1_000_000
  return Number.isFinite(cost) ? cost : undefined
}

interface Bucket {
  cost: number
  reportedCost: number
  estimatedCost: number
  estimatedUsed: boolean
  reportedUsed: boolean
  tokens: TokenUsage
  linesAdded: number
  linesDeleted: number
  sessions: Set<string>
  steps: number
  prs: Set<string>
  pricingSources: Set<string>
}

function bucket(): Bucket {
  return {
    cost: 0,
    reportedCost: 0,
    estimatedCost: 0,
    estimatedUsed: false,
    reportedUsed: false,
    tokens: normalizeTokens(undefined),
    linesAdded: 0,
    linesDeleted: 0,
    sessions: new Set(),
    steps: 0,
    prs: new Set(),
    pricingSources: new Set(),
  }
}

function effectiveCost(record: UsageRecord): { cost: number; estimated: boolean } {
  if (record.cost > 0 || record.estimatedCost === undefined) {
    return { cost: number(record.cost), estimated: false }
  }
  return { cost: number(record.estimatedCost), estimated: record.estimatedCost > 0 }
}

function addUsage(target: Bucket, record: UsageRecord, prKey?: string): void {
  const effective = effectiveCost(record)
  target.cost += effective.cost
  target.reportedCost += number(record.cost)
  target.estimatedCost += number(record.estimatedCost)
  target.estimatedUsed ||= effective.estimated
  target.reportedUsed ||= record.cost > 0
  target.tokens.input += number(record.tokens.input)
  target.tokens.output += number(record.tokens.output)
  target.tokens.reasoning += number(record.tokens.reasoning)
  target.tokens.cache.read += number(record.tokens.cache?.read)
  target.tokens.cache.write += number(record.tokens.cache?.write)
  target.sessions.add(record.sessionID)
  target.steps++
  if (record.pricingSource && record.estimatedCost !== undefined) {
    target.pricingSources.add(`${record.pricingSource.kind}:${record.pricingSource.providerID}/${record.pricingSource.modelID}`)
  }
  if (prKey) target.prs.add(prKey)
}

function addLines(target: Bucket, record: LineRecord, prKey?: string): void {
  for (const file of record.files) {
    target.linesAdded += number(file.additions)
    target.linesDeleted += number(file.deletions)
  }
  target.sessions.add(record.sessionID)
  if (prKey) target.prs.add(prKey)
}

function finish(value: Bucket): Metrics {
  const linesChanged = value.linesAdded + value.linesDeleted
  return {
    cost: value.cost,
    reportedCost: value.reportedCost,
    estimatedCost: value.estimatedCost,
    costBasis: value.estimatedUsed && value.reportedUsed ? "mixed" : value.estimatedUsed ? "estimated" : value.reportedUsed ? "reported" : "zero",
    inputTokens: value.tokens.input,
    outputTokens: value.tokens.output,
    reasoningTokens: value.tokens.reasoning,
    cacheReadTokens: value.tokens.cache.read,
    cacheWriteTokens: value.tokens.cache.write,
    totalTokens: totalTokens(value.tokens),
    linesAdded: value.linesAdded,
    linesDeleted: value.linesDeleted,
    linesChanged,
    costPerLine: linesChanged > 0 ? value.cost / linesChanged : null,
    costPerAddedLine: value.linesAdded > 0 ? value.cost / value.linesAdded : null,
    sessions: value.sessions.size,
    steps: value.steps,
    prs: value.prs.size,
  }
}

function inRange(created: number, filter: ReportFilter): boolean {
  return (!filter.from || created >= filter.from) && (!filter.to || created <= filter.to)
}

function selectedProject(projectID: string, filter: ReportFilter): boolean {
  return !filter.projectID || projectID === filter.projectID
}

/**
 * Prefer one net turn diff over gross per-tool diffs for the same turn. Empty
 * turn records are meaningful: they suppress stale fallback tool records.
 */
export function selectLineRecords(records: LineRecord[]): LineRecord[] {
  const turns = new Map<string, LineRecord[]>()
  for (const record of records) {
    const key = `${record.sessionID}\0${record.turnID}`
    const list = turns.get(key) ?? []
    list.push(record)
    turns.set(key, list)
  }
  return [...turns.values()].flatMap((list) => {
    const turnDiffs = list.filter((record) => record.kind === "turn")
    return turnDiffs.length > 0 ? turnDiffs.slice(-1) : list
  })
}

export function prKey(projectID: string, number: number): string {
  return `${projectID}#${number}`
}

interface Attribution {
  pr?: ExportData["pullRequests"][number]
  manual: boolean
}

export function aggregate(data: ExportData, filter: ReportFilter = {}, now = Date.now()): Report {
  const assignments = new Map<string, SessionAssignment>()
  for (const assignment of data.assignments) assignments.set(assignment.sessionID, assignment)

  const pullRequests = new Map(data.pullRequests.map((pr) => [pr.key, pr]))
  const byBranch = new Map<string, ExportData["pullRequests"]>()
  for (const pr of data.pullRequests) {
    const key = `${pr.projectID}\0${pr.branch}`
    const list = byBranch.get(key) ?? []
    list.push(pr)
    byBranch.set(key, list)
  }
  for (const list of byBranch.values()) {
    list.sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))
  }

  function attribution(record: UsageRecord | LineRecord): Attribution {
    const assigned = assignments.get(record.sessionID)
    if (assigned) {
      if (!assigned.prKey) return { manual: false }
      const pr = pullRequests.get(assigned.prKey)
      if (pr && selectedProject(pr.projectID, filter)) return { pr, manual: true }
      return { manual: false }
    }
    if (!record.branch) return { manual: false }
    const pr = byBranch.get(`${record.projectID}\0${record.branch}`)?.[0]
    return { pr, manual: false }
  }

  const totals = bucket()
  const unassigned = bucket()
  const projects = new Map<string, Bucket>()
  const models = new Map<string, Bucket>()
  const modelGroups = new Map<string, Bucket>()
  const prBuckets = new Map<string, {
    bucket: Bucket
    manual: boolean
    branch: boolean
    models: Map<string, Bucket>
    variants: Map<string, Bucket>
  }>()
  const days = new Map<string, Bucket>()

  function prBucket(key: string): { bucket: Bucket; manual: boolean; branch: boolean; models: Map<string, Bucket>; variants: Map<string, Bucket> } {
    const existing = prBuckets.get(key)
    if (existing) return existing
    const created = { bucket: bucket(), manual: false, branch: false, models: new Map<string, Bucket>(), variants: new Map<string, Bucket>() }
    prBuckets.set(key, created)
    return created
  }

  for (const record of data.usage) {
    if (!inRange(record.created, filter) || !selectedProject(record.projectID, filter)) continue
    const linked = attribution(record)
    const key = linked.pr?.key
    addUsage(totals, record, key)

    const date = new Date(record.created).toISOString().slice(0, 10)
    const day = days.get(date) ?? bucket()
    addUsage(day, record, key)
    days.set(date, day)

    const project = projects.get(record.projectID) ?? bucket()
    addUsage(project, record, key)
    projects.set(record.projectID, project)

    const modelKey = `${record.model.providerID}\0${record.model.id}\0${record.model.variant ?? ""}`
    const model = models.get(modelKey) ?? bucket()
    addUsage(model, record)
    models.set(modelKey, model)

    const groupKey = `${record.model.providerID}\0${record.model.id}`
    const group = modelGroups.get(groupKey) ?? bucket()
    addUsage(group, record)
    modelGroups.set(groupKey, group)

    if (linked.pr) {
      const pr = prBucket(linked.pr.key)
      addUsage(pr.bucket, record, linked.pr.key)
      pr.manual ||= linked.manual
      pr.branch ||= !linked.manual

      const prModelKey = `${record.model.providerID}\0${record.model.id}`
      const prModel = pr.models.get(prModelKey) ?? bucket()
      addUsage(prModel, record)
      pr.models.set(prModelKey, prModel)

      const prVariantKey = `${prModelKey}\0${record.model.variant ?? ""}`
      const prVariant = pr.variants.get(prVariantKey) ?? bucket()
      addUsage(prVariant, record)
      pr.variants.set(prVariantKey, prVariant)
    } else {
      addUsage(unassigned, record)
    }
  }

  for (const record of selectLineRecords(data.lines)) {
    if (!inRange(record.created, filter) || !selectedProject(record.projectID, filter)) continue
    const linked = attribution(record)
    const key = linked.pr?.key
    addLines(totals, record, key)

    const date = new Date(record.created).toISOString().slice(0, 10)
    const day = days.get(date) ?? bucket()
    addLines(day, record, key)
    days.set(date, day)

    const project = projects.get(record.projectID) ?? bucket()
    addLines(project, record, key)
    projects.set(record.projectID, project)

    if (linked.pr) {
      const pr = prBucket(linked.pr.key)
      addLines(pr.bucket, record, linked.pr.key)
      pr.manual ||= linked.manual
      pr.branch ||= !linked.manual
    } else {
      addLines(unassigned, record)
    }
  }

  const directories = new Map<string, string>()
  for (const record of [...data.usage, ...data.lines]) {
    if (!directories.has(record.projectID)) directories.set(record.projectID, record.directory)
  }
  for (const pr of data.pullRequests) {
    if (!directories.has(pr.projectID)) directories.set(pr.projectID, pr.directory)
  }

  const projectRows: ProjectMetrics[] = [...projects.entries()].map(([projectID, value]) => {
    const directory = directories.get(projectID) ?? ""
    return { projectID, name: basename(directory) || projectID.slice(0, 8), directory, ...finish(value) }
  })

  function modelValues(providerID: string, modelID: string, value: Bucket): Omit<ModelMetrics, "variant"> {
    const metrics = finish(value)
    return {
      providerID,
      modelID,
      cost: metrics.cost,
      reportedCost: metrics.reportedCost,
      estimatedCost: metrics.estimatedCost,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      reasoningTokens: metrics.reasoningTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cacheWriteTokens: metrics.cacheWriteTokens,
      totalTokens: metrics.totalTokens,
      sessions: metrics.sessions,
      steps: metrics.steps,
      pricingSources: [...value.pricingSources].sort(),
    }
  }

  const modelRows: ModelMetrics[] = [...models.entries()].map(([key, value]) => {
    const [providerID, modelID, variant] = key.split("\0")
    return { ...modelValues(providerID, modelID, value), ...(variant ? { variant } : {}) }
  })
  const modelGroupRows: ModelGroupMetrics[] = [...modelGroups.entries()].map(([key, value]) => {
    const [providerID, modelID] = key.split("\0")
    const variants = modelRows
      .filter((model) => model.providerID === providerID && model.modelID === modelID)
      .sort((a, b) => (a.variant ?? "").localeCompare(b.variant ?? ""))
    return { ...modelValues(providerID, modelID, value), variants }
  })

  const prRows: PullRequestMetrics[] = data.pullRequests
    .filter((pr) => selectedProject(pr.projectID, filter))
    .map((pr) => {
      const value = prBuckets.get(pr.key)
      const metrics = finish(value?.bucket ?? bucket())
      const directory = directories.get(pr.projectID) ?? pr.directory
      const models: ModelGroupMetrics[] = [...(value?.models ?? new Map<string, Bucket>()).entries()].map(([key, model]) => {
        const [providerID, modelID] = key.split("\0")
        const variants = [...(value?.variants ?? new Map<string, Bucket>()).entries()]
          .filter(([variantKey]) => variantKey.startsWith(`${key}\0`))
          .map(([variantKey, variant]) => {
            const [, , effort] = variantKey.split("\0")
            return { ...modelValues(providerID, modelID, variant), ...(effort ? { variant: effort } : {}) }
          })
          .sort((a, b) => (a.variant ?? "").localeCompare(b.variant ?? ""))
        return { ...modelValues(providerID, modelID, model), variants }
      })
      return {
        pr,
        projectName: basename(directory) || pr.projectID.slice(0, 8),
        projectDirectory: directory,
        models: models.sort((a, b) => b.cost - a.cost),
        ...metrics,
        attribution: value?.manual && value.branch ? "mixed" : value?.manual ? "manual" : value?.branch ? "branch" : "none",
        githubLinesAdded: pr.additions,
        githubLinesDeleted: pr.deletions,
      }
    })

  const dayRows: DayMetrics[] = [...days.entries()].map(([date, value]) => ({ date, ...finish(value) }))
  const byCost = (a: { cost: number }, b: { cost: number }) => b.cost - a.cost

  return {
    version: 1,
    generatedAt: now,
    range: filter,
    totals: finish(totals),
    unassigned: finish(unassigned),
    projects: projectRows.sort(byCost),
    models: modelRows.sort(byCost),
    modelGroups: modelGroupRows.sort(byCost),
    pullRequests: prRows.sort(byCost),
    days: dayRows.sort((a, b) => a.date.localeCompare(b.date)),
  }
}
