export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export type UsageSource = "primary" | "compaction" | "title" | "generate"

export interface PricingSource {
  kind: "public-api" | "provider-catalog" | "override"
  catalog: "models.dev" | "opencode" | "custom"
  providerID: string
  modelID: string
  fetchedAt?: number
}

export interface UsageRecord {
  id: string
  sessionID: string
  projectID: string
  directory: string
  branch?: string
  created: number
  source: UsageSource
  model: ModelRef
  /** USD reported by OpenCode. Zero can mean free, subscribed, or unpriced. */
  cost: number
  /** USD estimated from public API prices, the model catalog, or an override. */
  estimatedCost?: number
  pricingSource?: PricingSource
  tokens: TokenUsage
}

export interface FileLineChange {
  file: string
  additions: number
  deletions: number
}

export interface LineRecord {
  id: string
  sessionID: string
  turnID: string
  projectID: string
  directory: string
  branch?: string
  created: number
  kind: "turn" | "tool"
  files: FileLineChange[]
}

export interface PullRequestRecord {
  key: string
  projectID: string
  directory: string
  number: number
  title: string
  url: string
  state: string
  branch: string
  additions: number
  deletions: number
  createdAt?: string
  updatedAt?: string
  closedAt?: string
  mergedAt?: string
}

export interface SessionAssignment {
  sessionID: string
  projectID: string
  prKey: string
  updatedAt: number
}

export interface Price {
  /** USD per million tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface Metrics {
  cost: number
  reportedCost: number
  estimatedCost: number
  costBasis: "reported" | "estimated" | "mixed" | "zero"
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  linesAdded: number
  linesDeleted: number
  linesChanged: number
  costPerLine: number | null
  costPerAddedLine: number | null
  sessions: number
  steps: number
  prs: number
}

export interface ProjectMetrics extends Metrics {
  projectID: string
  name: string
  directory: string
}

export interface ModelMetrics {
  providerID: string
  modelID: string
  variant?: string
  cost: number
  reportedCost: number
  estimatedCost: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  sessions: number
  steps: number
  pricingSources: string[]
}

export interface PullRequestMetrics extends Metrics {
  pr: PullRequestRecord
  attribution: "branch" | "manual" | "mixed" | "none"
  githubLinesAdded: number
  githubLinesDeleted: number
}

export interface DayMetrics extends Metrics {
  date: string
}

export interface Report {
  version: 1
  generatedAt: number
  range: {
    from?: number
    to?: number
    projectID?: string
  }
  totals: Metrics
  unassigned: Metrics
  projects: ProjectMetrics[]
  models: ModelMetrics[]
  pullRequests: PullRequestMetrics[]
  days: DayMetrics[]
}

export interface SyncResult {
  sessions: number
  usageRecords: number
  lineRecords: number
  errors: string[]
  durationMs: number
}

export interface ExportData {
  version: 1
  exportedAt: number
  usage: UsageRecord[]
  lines: LineRecord[]
  pullRequests: PullRequestRecord[]
  assignments: SessionAssignment[]
}

export interface ReportFilter {
  from?: number
  to?: number
  projectID?: string
}
