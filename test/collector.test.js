import test from "node:test"
import assert from "node:assert/strict"
import { Collector, countLineChanges, extractFileDiffs, remainingTokens } from "../dist/collector.js"
import { MetricsStore } from "../dist/store.js"

class MemoryStorage {
  values = new Map()
  async get(key) { return this.values.get(key) }
  async set(key, value) { this.values.set(key, structuredClone(value)) }
  async remove(key) { this.values.delete(key) }
  async scan({ prefix, after, limit = 500 }) {
    const entries = [...this.values.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
    const start = after ? entries.findIndex(([key]) => key === after) + 1 : 0
    const page = entries.slice(start, start + limit).map(([key, value]) => ({ key, value }))
    return { entries: page, next: start + limit < entries.length ? page.at(-1)?.key : undefined }
  }
}

const tokens = (input, output, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } })

test("tool metadata keeps counts but not patches", () => {
  assert.deepEqual(extractFileDiffs({ filediff: { file: "/work/a.ts", additions: 3, deletions: 2, patch: "secret source" } }), [
    { file: "/work/a.ts", additions: 3, deletions: 2 },
  ])
  assert.deepEqual(extractFileDiffs({ files: [{ path: "b.ts", additions: 1, deletions: 0 }] }), [
    { file: "b.ts", additions: 1, deletions: 0 },
  ])
  assert.deepEqual(extractFileDiffs({ unrelated: true }), [])
})

test("fallback line diff handles replacement and trailing newlines", () => {
  assert.deepEqual(countLineChanges("a\nb\nc\n", "a\nx\nc\n"), { additions: 1, deletions: 1 })
  assert.deepEqual(countLineChanges("", "a\nb\n"), { additions: 2, deletions: 0 })
  assert.deepEqual(countLineChanges("a\nb\n", ""), { additions: 0, deletions: 2 })
  assert.deepEqual(countLineChanges("same\n", "same\n"), { additions: 0, deletions: 0 })
})

test("session residual captures auxiliary usage without negative tokens", () => {
  assert.deepEqual(remainingTokens(tokens(20, 10, 5, 100, 4), tokens(15, 8, 2, 120, 1)), tokens(5, 2, 3, 0, 3))
})

test("collector import is idempotent and reconciles auxiliary usage", async () => {
  const storage = new MemoryStorage()
  const store = new MetricsStore(storage)
  const session = {
    id: "s1", projectID: "p1", location: { directory: "/tmp" }, time: { created: 1, updated: 2 },
    model: { providerID: "test", id: "model" }, tokens: tokens(15, 8, 2, 10, 1), cost: 0.4,
  }
  const message = {
    id: "m1", type: "assistant", time: { created: 1 }, content: [], model: session.model,
    tokens: tokens(10, 5, 1, 10, 0), cost: 0.3,
  }
  const ctx = {
    location: { directory: "/tmp", project: { id: "p1" } },
    model: { list: async () => ({ data: [] }) },
    session: {
      get: async () => session,
      context: async () => [message],
      list: async () => ({ data: [session], cursor: {} }),
    },
  }
  const collector = new Collector(ctx, store)
  await collector.initialize()
  const first = await collector.syncSession("s1", false)
  assert.equal(first.usage, 2)
  let data = await store.export()
  assert.equal(data.usage.length, 2)
  assert.deepEqual(data.usage.find((record) => record.id === "generate:s1").tokens, tokens(5, 3, 1, 0, 1))
  assert.ok(Math.abs(data.usage.find((record) => record.id === "generate:s1").cost - 0.1) < 1e-12)

  await collector.syncSession("s1", false)
  data = await store.export()
  assert.equal(data.usage.length, 2, "stable IDs must overwrite rather than duplicate")

  session.tokens = message.tokens
  session.cost = message.cost
  await collector.syncSession("s1", false)
  data = await store.export()
  assert.equal(data.usage.length, 1, "stale auxiliary residual is removed")
})

test("store scan paginates and exports raw metrics only", async () => {
  const storage = new MemoryStorage()
  const store = new MetricsStore(storage)
  for (let index = 0; index < 3; index++) {
    await store.usage({
      id: `u${index}`, sessionID: "s", projectID: "p", directory: "/work/p", created: index,
      source: "primary", model: { providerID: "test", id: "m" }, cost: 0, tokens: tokens(index, 0),
    })
  }
  const original = storage.scan.bind(storage)
  storage.scan = (input) => original({ ...input, limit: 1 })
  const data = await store.export()
  assert.equal(data.usage.length, 3)
  assert.equal(data.usage[2].tokens.input, 2)
  assert.equal("prompt" in data.usage[0], false)
})
