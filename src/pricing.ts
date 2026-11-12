import { FALLBACK_PRICING, FALLBACK_PRICING_FETCHED_AT } from "./pricing-fallback.js"
import type { Storage } from "./store.js"
import type { Price, PricingSource, TokenUsage } from "./types.js"

export interface ApiPrice extends Price {
  tier?: {
    type: "context"
    size: number
  }
}

export type ApiCatalog = Record<string, Record<string, ApiPrice[]>>

export interface PriceQuote {
  price: Price
  source: PricingSource
}

export interface PricingStatus {
  fetchedAt: number
  source: "live" | "cache" | "fallback"
  providers: number
  models: number
  lastError?: string
}

interface RawCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tiers?: RawCost[]
  tier?: { type?: string; size?: number }
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function priced(cost: RawCost): ApiPrice {
  return {
    input: positive(cost.input),
    output: positive(cost.output),
    cacheRead: positive(cost.cache_read),
    cacheWrite: positive(cost.cache_write),
    ...(cost.tier?.type === "context" && positive(cost.tier.size) > 0
      ? { tier: { type: "context" as const, size: positive(cost.tier.size) } }
      : {}),
  }
}

/** Keep only pricing metadata, never model definitions or provider settings. */
export function parseCatalog(input: unknown): ApiCatalog {
  const catalog: ApiCatalog = {}
  if (!input || typeof input !== "object") return catalog
  for (const [providerID, provider] of Object.entries(input)) {
    if (!provider || typeof provider !== "object") continue
    const models = (provider as { models?: unknown }).models
    if (!models || typeof models !== "object") continue
    for (const [modelID, model] of Object.entries(models)) {
      const cost = (model as { cost?: RawCost | undefined })?.cost
      if (!cost || typeof cost !== "object") continue
      const tiers = [priced(cost), ...(cost.tiers ?? []).map(priced)]
      ;(catalog[providerID] ??= {})[modelID] = tiers
    }
  }
  return catalog
}

function hasPrice(price: Price): boolean {
  return price.input + price.output + price.cacheRead + price.cacheWrite > 0
}

function tier(prices: ApiPrice[], tokens: TokenUsage): Price {
  const context = tokens.input + tokens.cache.read + tokens.cache.write
  const selected = [...prices]
    .sort((a, b) => (a.tier?.size ?? -1) - (b.tier?.size ?? -1))
    .reduce((current, candidate) => (!candidate.tier || context > candidate.tier.size ? candidate : current), prices[0])
  return selected
}

const KIMI_ALIASES: Record<string, string> = {
  "k3.1-pro": "kimi-k3.1-pro",
  "k3.1-pro-highspeed": "kimi-k3.1-pro-highspeed",
  k3: "kimi-k3",
  "k3-256k": "kimi-k3",
  "kimi-for-coding": "kimi-k2.7-code",
  "kimi-for-coding-highspeed": "kimi-k2.7-code-highspeed",
}

const PROVIDER_ALIASES: Record<string, string> = {
  azure: "openai",
  "azure-cognitive-services": "openai",
  "github-copilot": "openai",
  "google-vertex": "google",
  "google-vertex-anthropic": "anthropic",
  "moonshotai-cn": "moonshotai-cn",
}

const PUBLIC_MODEL_ALIASES: Record<string, Record<string, string>> = {
  deepseek: {
    "deepseek-v4.1-flash": "deepseek-flash",
    "deepseek-v4.1-flash-1017": "deepseek-flash",
  },
}

const MODEL_PREFIXES: Array<[prefix: string, providerID: string]> = [
  ["gpt-", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["chatgpt-", "openai"],
  ["claude-", "anthropic"],
  ["gemini-", "google"],
  ["gemma-", "google"],
  ["kimi-", "moonshotai"],
  ["deepseek-", "deepseek"],
  ["grok-", "xai"],
  ["mistral-", "mistral"],
  ["mixtral-", "mistral"],
  ["codestral-", "mistral"],
  ["devstral-", "mistral"],
]

function normalizedModel(modelID: string): string {
  return modelID
    .replace(/^(anthropic|openai|google|moonshotai|deepseek|xai|mistral)[./]/, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/:\d+$/, "")
}

export class ApiPricingCatalog {
  private catalog: ApiCatalog = FALLBACK_PRICING
  private state: PricingStatus

  constructor(
    private readonly storage?: Storage,
    private readonly url = "https://models.dev/api.json",
  ) {
    const models = Object.values(this.catalog).reduce((sum, provider) => sum + Object.keys(provider).length, 0)
    this.state = {
      fetchedAt: FALLBACK_PRICING_FETCHED_AT,
      source: "fallback",
      providers: Object.keys(this.catalog).length,
      models,
    }
  }

  status(): PricingStatus {
    return { ...this.state }
  }

  async initialize(): Promise<void> {
    if (!this.storage) return
    try {
      const cached = await this.storage.get("pricing/models-dev/v1")
      if (!cached || typeof cached !== "object") return
      const value = cached as { fetchedAt?: number; catalog?: unknown }
      const catalog = parseCatalog(value.catalog)
      if (Object.keys(catalog).length === 0) return
      this.catalog = catalog
      this.state = {
        fetchedAt: positive(value.fetchedAt),
        source: "cache",
        providers: Object.keys(catalog).length,
        models: Object.values(catalog).reduce((sum, provider) => sum + Object.keys(provider).length, 0),
      }
    } catch {
      // The bundled snapshot remains available if storage is unreadable.
    }
  }

  async refresh(): Promise<PricingStatus> {
    try {
      const response = await fetch(this.url, {
        headers: { accept: "application/json", "user-agent": "opencode-metrics" },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
      const catalog = parseCatalog(await response.json())
      if (Object.keys(catalog).length === 0) throw new Error("models.dev returned an empty pricing catalog")
      const fetchedAt = Date.now()
      this.catalog = catalog
      this.state = {
        fetchedAt,
        source: "live",
        providers: Object.keys(catalog).length,
        models: Object.values(catalog).reduce((sum, provider) => sum + Object.keys(provider).length, 0),
      }
      await this.storage?.set("pricing/models-dev/v1", { fetchedAt, catalog })
      return this.status()
    } catch (cause) {
      this.state = { ...this.state, lastError: cause instanceof Error ? cause.message : String(cause) }
      throw cause
    }
  }

  private lookup(providerID: string, modelID: string, tokens: TokenUsage): PriceQuote | undefined {
    const prices = this.catalog[providerID]?.[modelID]
    if (!prices || prices.length === 0) return undefined
    const price = tier(prices, tokens)
    if (!hasPrice(price)) return undefined
    return {
      price,
      source: {
        kind: "public-api",
        catalog: "models.dev",
        providerID,
        modelID,
        fetchedAt: this.state.fetchedAt,
      },
    }
  }

  quote(input: { providerID: string; modelID: string; package?: string }, tokens: TokenUsage): PriceQuote | undefined {
    const { providerID, modelID } = input
    const normalized = normalizedModel(modelID)
    // OpenCode routes are transport/subscription choices, not the public lab
    // whose API-equivalent value we want to estimate.
    const candidates: Array<[string, string]> = providerID === "opencode" || providerID === "opencode-go" ? [] : [[providerID, modelID]]

    if (providerID === "kimi-code-plan-global" || providerID === "kimi-code-plan-cn") {
      const publicProvider = providerID === "kimi-code-plan-global" ? "moonshotai" : "moonshotai-cn"
      candidates.push([publicProvider, KIMI_ALIASES[modelID] ?? normalized])
    }

    const slash = modelID.indexOf("/")
    if (slash > 0) {
      const namespace = modelID.slice(0, slash)
      const model = normalizedModel(modelID.slice(slash + 1))
      candidates.push([namespace, model], [namespace === "moonshot" ? "moonshotai" : namespace, model])
    }

    const providerAlias = PROVIDER_ALIASES[providerID]
    if (providerAlias) candidates.push([providerAlias, normalized])

    const packageProvider = input.package?.includes("anthropic")
      ? "anthropic"
      : input.package?.includes("google")
        ? "google"
        : input.package?.includes("moonshot")
          ? "moonshotai"
          : input.package?.includes("openai")
            ? "openai"
            : input.package?.includes("deepseek")
              ? "deepseek"
              : undefined
    if (packageProvider) candidates.push([packageProvider, normalized])

    for (const [prefix, publicProvider] of MODEL_PREFIXES) {
      if (normalized.startsWith(prefix)) {
        candidates.push([publicProvider, PUBLIC_MODEL_ALIASES[publicProvider]?.[normalized] ?? normalized])
      }
    }

    // A public OpenCode route can use the upstream model name without the
    // upstream provider namespace. Exact model matches avoid fuzzy pricing.
    candidates.push(["moonshotai", normalized], ["openai", normalized], ["anthropic", normalized], ["google", normalized])

    const attempted = new Set<string>()
    for (const [publicProvider, publicModel] of candidates) {
      const key = `${publicProvider}/${publicModel}`
      if (attempted.has(key)) continue
      attempted.add(key)
      const match = this.lookup(publicProvider, publicModel, tokens)
      if (match) return match
    }
    return undefined
  }
}
