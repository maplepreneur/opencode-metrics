import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Context as ServerContext } from "@opencode/plugin/promise/plugin"
import { currentBranch, turnDiff } from "./git.js"
import { estimateCost, normalizeTokens } from "./metrics.js"
import { ApiPricingCatalog, type PriceQuote, type PricingStatus } from "./pricing.js"
import { MetricsStore } from "./store.js"
import type {
  FileLineChange,
  LineRecord,
  ModelRef,
  Price,
  SyncResult,
  TokenUsage,
  UsageRecord,
  UsageSource,
} from "./types.js"

export type Context = ServerContext
export type Session = Awaited<ReturnType<Context["session"]["get"]>>
export type Message = Awaited<ReturnType<Context["session"]["context"]>>[number]
export type Models = Awaited<ReturnType<Context["model"]["list"]>>["data"]

export interface CollectorOptions {
  prices?: Record<string, Partial<Price>>
  opencodePath?: string
}

interface PendingEdit {
  file: string
  before: string
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function filePath(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  for (const key of ["filePath", "filepath", "path", "file"]) {
    if (typeof input[key] === "string") return input[key]
  }
  return undefined
}

function relativeFile(directory: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(directory, file) : file
  return relative.split(path.sep).join("/")
}

/** Read OpenCode's FileDiff-shaped tool metadata without retaining patches. */
export function extractFileDiffs(metadata: unknown): Array<{ file: string; additions: number; deletions: number }> {
  if (!metadata || typeof metadata !== "object") return []
  const source = metadata as Record<string, unknown>
  const candidates = [source.filediff, source.fileDiff, source.diff, source.files]
  for (const candidate of candidates) {
    const list = Array.isArray(candidate) ? candidate : [candidate]
    const files = list.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const diff = item as Record<string, unknown>
      const file = filePath(diff)
      if (!file || (typeof diff.additions !== "number" && typeof diff.deletions !== "number")) return []
      return [{ file, additions: finite(diff.additions), deletions: finite(diff.deletions) }]
    })
    if (files.length > 0) return files
  }
  return []
}

export function countLineChanges(before: string, after: string): { additions: number; deletions: number } {
  function lines(text: string): string[] {
    if (!text) return []
    const normalized = text.replaceAll("\r\n", "\n")
    const result = normalized.split("\n")
    if (normalized.endsWith("\n")) result.pop()
    return result
  }
  const left = lines(before)
  const right = lines(after)
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++
  let suffix = 0
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    additions: right.length - prefix - suffix,
    deletions: left.length - prefix - suffix,
  }
}

function usageTokens(message: Message): TokenUsage | undefined {
  if (!("tokens" in message)) return undefined
  return normalizeTokens(message.tokens)
}

function usageCost(message: Message): number {
  return "cost" in message ? finite(message.cost) : 0
}

function usageModel(message: Message, session: Session): ModelRef {
  if ("model" in message && message.model) return message.model
  return session.model ?? { providerID: "unknown", id: "unknown" }
}

export function remainingTokens(total: TokenUsage, observed: TokenUsage): TokenUsage {
  return normalizeTokens({
    input: Math.max(0, total.input - observed.input),
    output: Math.max(0, total.output - observed.output),
    reasoning: Math.max(0, total.reasoning - observed.reasoning),
    cache: {
      read: Math.max(0, total.cache.read - observed.cache.read),
      write: Math.max(0, total.cache.write - observed.cache.write),
    },
  })
}

function addTokens(target: TokenUsage, tokens: TokenUsage): void {
  target.input += tokens.input
  target.output += tokens.output
  target.reasoning += tokens.reasoning
  target.cache.read += tokens.cache.read
  target.cache.write += tokens.cache.write
}

export class Collector {
  private models: Models = []
  private readonly diffed = new Set<string>()
  private readonly pending = new Map<string, PendingEdit>()

  constructor(
    private readonly ctx: Context,
    readonly store: MetricsStore,
    private readonly options: CollectorOptions = {},
    private readonly pricing: ApiPricingCatalog = new ApiPricingCatalog(ctx.storage),
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([this.refreshModels(), this.pricing.initialize()])
  }

  pricingStatus(): PricingStatus {
    return this.pricing.status()
  }

  async refreshPricing(): Promise<PricingStatus> {
    return this.pricing.refresh()
  }

  async refreshModels(): Promise<void> {
    this.models = (await this.ctx.model.list()).data
  }

  private price(model: ModelRef, tokens: TokenUsage): PriceQuote | undefined {
    const override = this.options.prices?.[`${model.providerID}/${model.id}`]
    if (override) {
      return {
        price: {
          input: finite(override.input),
          output: finite(override.output),
          cacheRead: finite(override.cacheRead),
          cacheWrite: finite(override.cacheWrite),
        },
        source: { kind: "override", catalog: "custom", providerID: model.providerID, modelID: model.id },
      }
    }
    const info = this.models.find((candidate) => candidate.providerID === model.providerID && (candidate.id === model.id || candidate.modelID === model.id))
    const publicApi = this.pricing.quote({ providerID: model.providerID, modelID: model.id, package: info?.package }, tokens)
    if (publicApi) return publicApi
    if (!info || info.cost.length === 0) return undefined
    const context = tokens.input + tokens.cache.read + tokens.cache.write
    const tier = [...info.cost]
      .sort((a, b) => (a.tier?.size ?? -1) - (b.tier?.size ?? -1))
      .reduce((selected, candidate) => (!candidate.tier || context > candidate.tier.size ? candidate : selected), info.cost[0])
    return {
      price: {
        input: finite(tier.input),
        output: finite(tier.output),
        cacheRead: finite(tier.cache.read),
        cacheWrite: finite(tier.cache.write),
      },
      source: { kind: "provider-catalog", catalog: "opencode", providerID: model.providerID, modelID: model.id },
    }
  }

  private async usage(input: {
    id: string
    session: Session
    branch?: string
    created: number
    source: UsageSource
    model: ModelRef
    cost: number
    tokens: TokenUsage
  }): Promise<UsageRecord> {
    const quote = this.price(input.model, input.tokens)
    const record: UsageRecord = {
      id: input.id,
      sessionID: input.session.id,
      projectID: input.session.projectID,
      directory: input.session.location.directory,
      branch: input.branch,
      created: input.created,
      source: input.source,
      model: input.model,
      cost: input.cost,
      estimatedCost: estimateCost(input.tokens, quote?.price),
      pricingSource: quote?.source,
      tokens: input.tokens,
    }
    await this.store.usage(record)
    return record
  }

  async syncSession(sessionID: string, includeTurnDiffs: boolean): Promise<{ usage: number; lines: number; errors: string[] }> {
    const session = await this.ctx.session.get({ sessionID })
    const messages = await this.ctx.session.context({ sessionID })
    const branch = await currentBranch(session.location.directory)
    let usage = 0
    let lines = 0
    const errors: string[] = []
    let turnID = sessionID
    let diffUnavailable = false
    const observedTokens = normalizeTokens(undefined)
    let observedCost = 0

    for (const message of messages) {
      if (message.type === "user") {
        turnID = message.id
        if (includeTurnDiffs && !diffUnavailable && !this.diffed.has(`${sessionID}:${turnID}`)) {
          try {
            const files = await turnDiff(session.location.directory, sessionID, turnID, this.options.opencodePath)
            await this.store.lines({
              id: `turn:${sessionID}:${turnID}`,
              sessionID,
              turnID,
              projectID: session.projectID,
              directory: session.location.directory,
              branch,
              created: message.time.created,
              kind: "turn",
              files,
            })
            this.diffed.add(`${sessionID}:${turnID}`)
            lines++
          } catch (error) {
            errors.push(`turn ${turnID}: ${error instanceof Error ? error.message : String(error)}`)
            // A missing CLI affects every turn. Keep importing usage and tool metadata.
            diffUnavailable = true
          }
        }
        continue
      }

      const tokens = usageTokens(message)
      if ((message.type === "assistant" || (message.type === "compaction" && message.status === "completed")) && tokens) {
        const source = message.type === "assistant" ? "primary" : "compaction"
        await this.usage({
          id: `${source}:${message.id}`,
          session,
          branch,
          created: message.time.created,
          source,
          model: usageModel(message, session),
          cost: usageCost(message),
          tokens,
        })
        addTokens(observedTokens, tokens)
        observedCost += usageCost(message)
        usage++
      }

      if (message.type !== "assistant") continue
      for (const part of message.content) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        const files = extractFileDiffs(part.state.metadata).map((file) => ({
          ...file,
          file: relativeFile(session.location.directory, file.file),
        }))
        if (files.length === 0) continue
        await this.store.lines({
          id: `tool:${sessionID}:${message.id}:${part.id}`,
          sessionID,
          turnID,
          projectID: session.projectID,
          directory: session.location.directory,
          branch,
          created: part.time.completed ?? part.time.ran ?? part.time.created,
          kind: "tool",
          files,
        })
        lines++
      }
    }

    // Session totals include title and transient generation calls that are not
    // persisted as assistant messages. Reconcile the residual as one stable
    // auxiliary record instead of double-counting normal assistant usage.
    const auxiliaryTokens = remainingTokens(normalizeTokens(session.tokens), observedTokens)
    const auxiliaryCost = Math.max(0, finite(session.cost) - observedCost)
    const hasAuxiliary = auxiliaryCost > 0 || Object.values(auxiliaryTokens.cache).some((value) => value > 0) ||
      auxiliaryTokens.input + auxiliaryTokens.output + auxiliaryTokens.reasoning > 0
    if (hasAuxiliary) {
      await this.usage({
        id: `generate:${sessionID}`,
        session,
        branch,
        created: session.time.updated,
        source: "generate",
        model: session.model ?? { providerID: "unknown", id: "unknown" },
        cost: auxiliaryCost,
        tokens: auxiliaryTokens,
      })
      usage++
    } else {
      await this.store.removeUsage(`generate:${sessionID}`)
    }
    return { usage, lines, errors }
  }

  async sync(input: { directory?: string; all?: boolean; diffs?: boolean }): Promise<SyncResult> {
    const started = Date.now()
    let cursor: string | undefined
    let sessions = 0
    let usageRecords = 0
    let lineRecords = 0
    const errors: string[] = []
    if (input.diffs !== false) {
      try {
        await this.refreshPricing()
      } catch (error) {
        errors.push(`pricing: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    do {
      const page = await this.ctx.session.list({
        directory: input.all ? undefined : input.directory ?? this.ctx.location.directory,
        limit: 100,
        cursor,
      })
      for (const session of page.data) {
        sessions++
        try {
          const result = await this.syncSession(session.id, input.diffs !== false)
          usageRecords += result.usage
          lineRecords += result.lines
          errors.push(...result.errors.map((error) => `${session.id} ${error}`))
        } catch (error) {
          errors.push(`${session.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      cursor = page.cursor.next ?? undefined
    } while (cursor)
    return { sessions, usageRecords, lineRecords, errors, durationMs: Date.now() - started }
  }

  async beforeTool(input: { sessionID: string; id: string; tool: string; input: unknown }): Promise<void> {
    if (!/(^|_)(edit|write|multiedit)$/.test(input.tool)) return
    const source = filePath(input.input)
    if (!source) return
    const session = await this.ctx.session.get({ sessionID: input.sessionID })
    const file = path.isAbsolute(source) ? source : path.resolve(session.location.directory, source)
    try {
      const before = await readFile(file, "utf8")
      if (Buffer.byteLength(before) <= 2_000_000) this.pending.set(input.id, { file, before })
    } catch {
      this.pending.set(input.id, { file, before: "" })
    }
  }

  async afterTool(input: {
    sessionID: string
    messageID: string
    id: string
    tool: string
    input: unknown
    metadata: unknown
  }): Promise<void> {
    const session = await this.ctx.session.get({ sessionID: input.sessionID })
    let files: FileLineChange[] = extractFileDiffs(input.metadata)
    const pending = this.pending.get(input.id)
    this.pending.delete(input.id)
    if (files.length === 0 && pending) {
      try {
        const after = await readFile(pending.file, "utf8")
        if (Buffer.byteLength(after) <= 2_000_000) {
          files = [{ file: pending.file, ...countLineChanges(pending.before, after) }]
        }
      } catch {
        // Deleted files have only deletions.
        files = [{ file: pending.file, additions: 0, deletions: countLineChanges(pending.before, "").deletions }]
      }
    }
    if (files.length === 0) return
    const messages = await this.ctx.session.context({ sessionID: input.sessionID })
    const turnID = messages.filter((message) => message.type === "user").at(-1)?.id ?? input.sessionID
    const branch = await currentBranch(session.location.directory)
    const record: LineRecord = {
      id: `tool:${input.sessionID}:${input.messageID}:${input.id}`,
      sessionID: input.sessionID,
      turnID,
      projectID: session.projectID,
      directory: session.location.directory,
      branch,
      created: Date.now(),
      kind: "tool",
      files: files.map((file) => ({
        file: relativeFile(session.location.directory, file.file),
        additions: finite(file.additions),
        deletions: finite(file.deletions),
      })),
    }
    await this.store.lines(record)
  }
}
