import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { verifyPrCost } from "../dist/pr-verification.js"

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const number = Number(option("--pr"))
const directory = resolve(option("--directory") ?? process.cwd())

try {
  const cli = new URL("../bin/opencode-metrics.js", import.meta.url).pathname
  const result = spawnSync(process.execPath, [cli, "report", "--all", "--json", "--directory", directory], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Metrics CLI exited ${result.status}`)
  const report = JSON.parse(result.stdout)
  const row = verifyPrCost(report, number)
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
  console.log(`PASS: PR #${number} ${row.pr.title}`)
  console.log(`Effective AI cost: ${usd.format(row.cost)}`)
  console.log(`Attributed sessions: ${row.sessions}; model calls: ${row.steps}`)
  console.log(`AI lines changed: ${row.linesChanged}; cost per line: ${row.costPerLine === null ? "—" : usd.format(row.costPerLine)}`)
  console.log(`Attribution: ${row.attribution}; source: ${row.pr.url}`)
} catch (cause) {
  console.error(`FAIL: ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exitCode = 1
}
