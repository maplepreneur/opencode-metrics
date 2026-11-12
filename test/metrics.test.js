import test from "node:test"
import assert from "node:assert/strict"
import { aggregate, estimateCost, normalizeTokens, prKey, selectLineRecords, totalTokens } from "../dist/metrics.js"

const tokens = (input, output, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } })
const usage = (id, sessionID, projectID, branch, cost, estimatedCost, created = 1000) => ({
  id, sessionID, projectID, directory: `/work/${projectID}`, branch, created, source: "primary",
  model: { providerID: projectID === "p1" ? "anthropic" : "openai", id: projectID === "p1" ? "claude" : "gpt", variant: "default" },
  cost, estimatedCost, tokens: tokens(100, 50, 10, 500, 20),
})
const lines = (id, sessionID, turnID, projectID, branch, kind, additions, deletions, created = 1000) => ({
  id, sessionID, turnID, projectID, directory: `/work/${projectID}`, branch, created, kind,
  files: [{ file: "src/app.ts", additions, deletions }],
})
const pr = { key: prKey("p1", 42), projectID: "p1", directory: "/work/p1", number: 42, title: "Feature", url: "https://example/pr/42", state: "open", branch: "feature", additions: 100, deletions: 20, updatedAt: "2026-01-01" }
const empty = { version: 1, exportedAt: 0, usage: [], lines: [], pullRequests: [], assignments: [] }

test("cost estimation includes reasoning and cache tokens", () => {
  const usage = tokens(1_000_000, 500_000, 500_000, 2_000_000, 100_000)
  assert.equal(estimateCost(usage, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 }), 12.8)
  assert.equal(estimateCost(usage, undefined), undefined)
  assert.equal(totalTokens(usage), 2_000_000)
  assert.deepEqual(normalizeTokens({ input: -1, output: Number.NaN }), tokens(0, 0))
})

test("turn diffs replace gross tool diffs for the same turn", () => {
  const turn = lines("turn", "s1", "u1", "p1", "feature", "turn", 10, 5)
  const tool = lines("tool", "s1", "u1", "p1", "feature", "tool", 999, 999)
  const otherTool = lines("tool2", "s1", "u2", "p1", "feature", "tool", 2, 1)
  assert.deepEqual(selectLineRecords([tool, turn, otherTool]).map((record) => record.id), ["turn", "tool2"])
  assert.deepEqual(selectLineRecords([tool, { ...turn, files: [] }]).map((record) => record.id), ["turn"])
})

test("aggregation covers providers, projects, LOC, PRs, estimates, and unassigned work", () => {
  const report = aggregate({
    ...empty,
    usage: [usage("u1", "s1", "p1", "feature", 0, 0.2), usage("u2", "s2", "p2", "main", 0.5, 1)],
    lines: [
      lines("tool", "s1", "t1", "p1", "feature", "tool", 999, 999),
      lines("turn", "s1", "t1", "p1", "feature", "turn", 10, 5),
      lines("tool2", "s2", "t2", "p2", "main", "tool", 2, 1),
    ],
    pullRequests: [pr],
  }, {}, 5000)
  assert.equal(report.generatedAt, 5000)
  assert.equal(report.totals.cost, 0.7)
  assert.equal(report.totals.reportedCost, 0.5)
  assert.equal(report.totals.estimatedCost, 1.2)
  assert.equal(report.totals.costBasis, "mixed")
  assert.equal(report.totals.linesChanged, 18)
  assert.equal(report.totals.costPerLine, 0.7 / 18)
  assert.equal(report.totals.sessions, 2)
  assert.equal(report.totals.prs, 1)
  assert.equal(report.models.length, 2)
  assert.equal(report.projects.length, 2)
  assert.equal(report.pullRequests[0].cost, 0.2)
  assert.equal(report.pullRequests[0].linesChanged, 15)
  assert.equal(report.pullRequests[0].attribution, "branch")
  assert.equal(report.unassigned.cost, 0.5)
  assert.equal(report.unassigned.linesChanged, 3)
})

test("manual assignment wins and mixed attribution is explicit", () => {
  const data = {
    ...empty,
    usage: [usage("u1", "s1", "p1", "feature", 0.2), usage("u2", "s2", "p1", "other", 0.1)],
    lines: [lines("l1", "s1", "t1", "p1", "feature", "turn", 1, 0)],
    pullRequests: [pr],
    assignments: [{ sessionID: "s2", projectID: "p1", prKey: pr.key, updatedAt: 2000 }],
  }
  const report = aggregate(data)
  assert.equal(report.pullRequests[0].cost, 0.30000000000000004)
  assert.equal(report.pullRequests[0].attribution, "mixed")
  assert.equal(report.pullRequests[0].sessions, 2)
  assert.equal(report.unassigned.cost, 0)
})

test("explicit exclusion prevents branch attribution", () => {
  const report = aggregate({
    ...empty,
    usage: [usage("u1", "s1", "p1", "feature", 0.2)],
    pullRequests: [pr],
    assignments: [{ sessionID: "s1", projectID: "p1", prKey: "", updatedAt: 2000 }],
  })
  assert.equal(report.pullRequests[0].cost, 0)
  assert.equal(report.pullRequests[0].attribution, "none")
  assert.equal(report.unassigned.cost, 0.2)
})

test("reports contain strict JSON values even when model variants are absent", () => {
  const record = usage("u1", "s1", "p1", "feature", 0.2)
  delete record.model.variant
  const report = aggregate({ ...empty, usage: [record] })
  function assertJson(value, path = "report") {
    assert.notEqual(value, undefined, `${path} must not be undefined`)
    if (typeof value === "number") assert.ok(Number.isFinite(value), `${path} must be finite`)
    if (Array.isArray(value)) return value.forEach((item, index) => assertJson(item, `${path}[${index}]`))
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`)
    }
  }
  assertJson(report)
  assert.equal("variant" in report.models[0], false)
})

test("time and project filters apply consistently", () => {
  const data = {
    ...empty,
    usage: [usage("old", "s1", "p1", "feature", 1, undefined, 100), usage("new", "s2", "p2", "main", 2, undefined, 2000)],
    lines: [lines("old-line", "s1", "t1", "p1", "feature", "turn", 5, 0, 100), lines("new-line", "s2", "t2", "p2", "main", "turn", 7, 0, 2000)],
    pullRequests: [pr],
  }
  const ranged = aggregate(data, { from: 1000 })
  assert.equal(ranged.totals.cost, 2)
  assert.equal(ranged.totals.linesAdded, 7)
  assert.equal(ranged.projects[0].projectID, "p2")
  const project = aggregate(data, { projectID: "p1" })
  assert.equal(project.totals.cost, 1)
  assert.equal(project.totals.linesAdded, 5)
  assert.equal(project.pullRequests.length, 1)
})
