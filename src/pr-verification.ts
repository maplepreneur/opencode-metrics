import type { PullRequestMetrics, Report } from "./types.js"

/** Validate the user-facing PR metrics returned by the report RPC. */
export function verifyPrCost(report: Report, number: number): PullRequestMetrics {
  if (!Number.isInteger(number) || number <= 0) throw new Error("PR number must be a positive integer")
  const row = report.pullRequests.find((candidate) => candidate.pr.number === number)
  if (!row) throw new Error(`PR #${number} is absent from the report. Run PR discovery for this repository first.`)
  if (!Number.isFinite(row.cost) || row.cost <= 0) {
    throw new Error(`PR #${number} has no attributed AI cost. Sync usage on its head branch or assign a session manually.`)
  }
  if (row.linesChanged > 0) {
    if (row.costPerLine === null || !Number.isFinite(row.costPerLine) || Math.abs(row.costPerLine - row.cost / row.linesChanged) > 1e-12) {
      throw new Error(`PR #${number} has an invalid cost-per-line calculation`)
    }
  }
  if (row.models.length > 0) {
    const modelCost = row.models.reduce((sum, model) => sum + model.cost, 0)
    if (Math.abs(modelCost - row.cost) > 1e-9) throw new Error(`PR #${number} model costs do not add up to its total cost`)
  }
  return row
}
