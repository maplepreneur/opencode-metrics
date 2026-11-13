import test from "node:test"
import assert from "node:assert/strict"
import { verifyPrCost } from "../dist/pr-verification.js"

const row = {
  pr: { number: 42, title: "Feature", url: "https://example.test/pr/42" },
  projectName: "shop",
  projectDirectory: "/work/shop",
  models: [],
  cost: 12.34,
  linesChanged: 100,
  costPerLine: 0.1234,
  sessions: 2,
  steps: 8,
  attribution: "branch",
}

test("PR verification returns visible cost and line metrics", () => {
  const report = { pullRequests: [row] }
  assert.equal(verifyPrCost(report, 42), row)
})

test("PR verification rejects missing and zero-cost PRs", () => {
  assert.throws(() => verifyPrCost({ pullRequests: [] }, 42), /absent.*discovery/)
  assert.throws(() => verifyPrCost({ pullRequests: [{ ...row, cost: 0 }] }, 42), /no attributed AI cost/)
})

test("PR verification validates per-model cost totals", () => {
  const models = [{ cost: 10 }, { cost: 2.34 }]
  assert.equal(verifyPrCost({ pullRequests: [{ ...row, models }] }, 42).models.length, 2)
  assert.throws(() => verifyPrCost({ pullRequests: [{ ...row, models: [{ cost: 1 }] }] }, 42), /model costs do not add up/)
})

test("PR verification rejects inconsistent cost-per-line output", () => {
  assert.throws(() => verifyPrCost({ pullRequests: [{ ...row, costPerLine: 1 }] }, 42), /invalid cost-per-line/)
  assert.doesNotThrow(() => verifyPrCost({ pullRequests: [{ ...row, linesChanged: 0, costPerLine: null }] }, 42))
})
