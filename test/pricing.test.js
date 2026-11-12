import test from "node:test"
import assert from "node:assert/strict"
import { ApiPricingCatalog, parseCatalog } from "../dist/pricing.js"
import { estimateCost } from "../dist/metrics.js"

const tokens = (input, output, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } })
const catalog = new ApiPricingCatalog()

function quote(providerID, modelID, usage = tokens(1_000_000, 1_000_000), packageName) {
  const result = catalog.quote({ providerID, modelID, package: packageName }, usage)
  assert.ok(result, `Expected a public API price for ${providerID}/${modelID}`)
  return result
}

test("offline catalog includes major public lab APIs", () => {
  const status = catalog.status()
  assert.equal(status.source, "fallback")
  assert.equal(status.providers, 8)
  assert.ok(status.models >= 150)
})

test("Kimi subscription K3.1 Pro uses Moonshot public API equivalent pricing", () => {
  const result = quote("kimi-code-plan-global", "k3.1-pro", tokens(1_000_000, 1_000_000, 0, 1_000_000))
  assert.equal(result.source.kind, "public-api")
  assert.equal(result.source.providerID, "moonshotai")
  assert.equal(result.source.modelID, "kimi-k3.1-pro")
  assert.equal(estimateCost(tokens(1_000_000, 1_000_000, 0, 1_000_000), result.price), 12.2)
})

test("Kimi highspeed and coding aliases use their public API rates", () => {
  const highspeed = quote("kimi-code-plan-global", "k3.1-pro-highspeed")
  assert.equal(highspeed.price.input, 4)
  assert.equal(highspeed.price.output, 20)
  assert.equal(highspeed.source.modelID, "kimi-k3.1-pro-highspeed")
  const coding = quote("kimi-code-plan-global", "kimi-for-coding")
  assert.equal(coding.price.input, 0.95)
  assert.equal(coding.price.output, 4)
  assert.equal(coding.source.modelID, "kimi-k2.7-code")
  const codingHighspeed = quote("kimi-code-plan-global", "kimi-for-coding-highspeed")
  assert.equal(codingHighspeed.price.input, 1.9)
  assert.equal(codingHighspeed.price.output, 8)
})

test("Kimi CN subscriptions use CN public API prices", () => {
  const result = quote("kimi-code-plan-cn", "k3")
  assert.equal(result.source.providerID, "moonshotai-cn")
  assert.equal(result.source.modelID, "kimi-k3")
  assert.equal(result.price.input, 2.9879)
  assert.equal(result.price.output, 14.9395)
})

test("OpenAI and Anthropic public prices include cache rates", () => {
  const openai = quote("openai", "gpt-5.3-codex", tokens(1_000_000, 1_000_000, 0, 1_000_000))
  assert.equal(estimateCost(tokens(1_000_000, 1_000_000, 0, 1_000_000), openai.price), 15.925)
  const anthropic = quote("anthropic", "claude-sonnet-4-5", tokens(1_000_000, 1_000_000, 0, 1_000_000, 1_000_000))
  assert.equal(estimateCost(tokens(1_000_000, 1_000_000, 0, 1_000_000, 1_000_000), anthropic.price), 22.05)
})

test("Google and OpenAI context tiers select the correct public rate", () => {
  const openai = quote("openai", "gpt-5.4", tokens(300_000, 1_000))
  assert.equal(openai.price.input, 5)
  assert.equal(openai.price.output, 22.5)
  const google = quote("google", "gemini-2.5-pro", tokens(300_000, 1_000))
  assert.equal(google.price.input, 2.5)
  assert.equal(google.price.output, 15)
})

test("subscription/router and cloud model names resolve to upstream public labs", () => {
  const router = quote("openrouter", "openai/gpt-5.4")
  assert.equal(router.source.providerID, "openai")
  const bedrock = quote("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0")
  assert.equal(bedrock.source.providerID, "anthropic")
  assert.equal(bedrock.source.modelID, "claude-sonnet-4-5-20250929")
  const copilot = quote("github-copilot", "claude-sonnet-4-5")
  assert.equal(copilot.source.providerID, "anthropic")
  const kimi = quote("opencode", "kimi-k3.1-pro")
  assert.equal(kimi.source.providerID, "moonshotai")
  const goKimi = quote("opencode-go", "kimi-k2.7-code")
  assert.equal(goKimi.source.providerID, "moonshotai")
  const deepseek = quote("opencode-go", "deepseek-v4.1-flash")
  assert.equal(deepseek.source.providerID, "deepseek")
  assert.equal(deepseek.source.modelID, "deepseek-flash")
})

test("unknown models do not receive a fabricated price", () => {
  assert.equal(catalog.quote({ providerID: "local", modelID: "my-uncatalogued-model" }, tokens(1, 1)), undefined)
})

test("catalog parser preserves context tiers and ignores malformed entries", () => {
  const parsed = parseCatalog({
    test: {
      models: {
        model: { cost: { input: 1, output: 2, cache_read: 0.1, tiers: [{ input: 3, output: 4, tier: { type: "context", size: 100 } }] } },
        broken: {},
      },
    },
    invalid: null,
  })
  assert.deepEqual(parsed.test.model[0], { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 })
  assert.equal(parsed.test.model[1].tier.size, 100)
  assert.equal(parsed.test.broken, undefined)
})
