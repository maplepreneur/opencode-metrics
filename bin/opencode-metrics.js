#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

const [command = "report", ...args] = process.argv.slice(2)

function option(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function flag(name) {
  return args.includes(name)
}

function call(method, input = {}) {
  const directory = resolve(option("--directory", process.cwd()))
  const location = `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
  const result = spawnSync(
    process.env.OPENCODE_PATH || "opencode",
    ["api", "post", `/api/rpc/opencode-metrics/${method}${location}`, "--data", JSON.stringify({ input })],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `opencode api exited ${result.status}`)
  try {
    const parsed = JSON.parse(result.stdout)
    if (parsed && typeof parsed === "object" && "output" in parsed) return parsed.output
    return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed
  } catch {
    throw new Error(`Could not parse OpenCode response: ${result.stdout.slice(0, 500)}`)
  }
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 })
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const money = (value) => usd.format(value)
const number = (value) => integer.format(value)
const ratio = (value) => value === null ? "—" : money(value)

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index]).length)))
  const line = (row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join("  ")
  console.log(line(headers))
  console.log(widths.map((width) => "─".repeat(width)).join("  "))
  for (const row of rows) console.log(line(row))
}

function report() {
  const all = flag("--all")
  const days = Number(option("--days", "30"))
  const input = {
    from: all || days === 0 ? undefined : Date.now() - days * 86_400_000,
    projectID: option("--project"),
  }
  const data = call("report", input)
  if (flag("--json")) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  const t = data.totals
  console.log(`OpenCode Metrics · ${all || days === 0 ? "all time" : `last ${days} days`} · ${t.costBasis} cost basis`)
  console.log(`Effective cost ${money(t.cost)} · Reported ${money(t.reportedCost)} · Public API estimate ${money(t.estimatedCost)}`)
  console.log(`Tokens: ${number(t.inputTokens)} input · ${number(t.outputTokens)} output · ${number(t.reasoningTokens)} reasoning · ${number(t.cacheReadTokens)} cache read · ${number(t.cacheWriteTokens)} cache write`)
  console.log(`Lines: +${number(t.linesAdded)} / -${number(t.linesDeleted)} (${number(t.linesChanged)} changed) · ${ratio(t.costPerLine)}/changed line · ${ratio(t.costPerAddedLine)}/added line`)
  console.log(`Activity: ${t.sessions} sessions · ${t.steps} model calls · ${t.prs} attributed PRs`)
  console.log(`Unassigned: ${money(data.unassigned.cost)} · ${number(data.unassigned.linesChanged)} lines · ${data.unassigned.sessions} sessions\n`)
  table(["Provider / model", "Calls", "Input", "Output", "Cost"], data.models.map((m) => [`${m.providerID}/${m.modelID}${m.variant ? ` (${m.variant})` : ""}`, m.steps, number(m.inputTokens), number(m.outputTokens), money(m.cost)]))
  console.log()
  table(["Project", "Sessions", "Lines", "Cost", "Cost/line"], data.projects.map((p) => [p.name, p.sessions, number(p.linesChanged), money(p.cost), ratio(p.costPerLine)]))
  if (data.pullRequests.length) {
    console.log()
    table(["PR", "Attribution", "AI lines", "Cost", "Cost/line"], data.pullRequests.map((p) => [`#${p.pr.number} ${p.pr.title}`, p.attribution, number(p.linesChanged), money(p.cost), ratio(p.costPerLine)]))
  }
}

function help() {
  console.log(`opencode-metrics — local usage, cost, LOC, and PR analytics

Usage:
  opencode-metrics report [--days 30 | --all] [--project ID] [--json]
  opencode-metrics prices
  opencode-metrics sync [--all] [--directory PATH] [--no-diffs]
  opencode-metrics discover [--directory PATH] [--session ID] [--limit 100]
  opencode-metrics assign SESSION_ID PR_NUMBER|none
  opencode-metrics export [FILE]

The plugin must be enabled in opencode.json(c). No account or cloud service is used.`)
}

try {
  if (command === "report") report()
  else if (command === "prices") {
    const result = call("refreshPricing")
    console.log(JSON.stringify(result, null, 2))
  } else if (command === "sync") {
    const result = call("sync", { all: flag("--all"), directory: resolve(option("--directory", process.cwd())), diffs: !flag("--no-diffs") })
    console.log(JSON.stringify(result, null, 2))
  } else if (command === "discover") {
    const result = call("discover", { directory: resolve(option("--directory", process.cwd())), sessionID: option("--session"), limit: Number(option("--limit", "100")) })
    console.log(`Discovered ${result.count} pull requests.`)
  } else if (command === "assign") {
    const [sessionID, pr] = args
    if (!sessionID || !pr) throw new Error("Usage: opencode-metrics assign SESSION_ID PR_NUMBER|none")
    const result = call("assign", { sessionID, number: pr === "none" ? null : Number(pr) })
    console.log(JSON.stringify(result, null, 2))
  } else if (command === "export") {
    const data = call("export")
    const json = JSON.stringify(data, null, 2)
    if (args[0]) {
      writeFileSync(args[0], `${json}\n`)
      console.log(`Exported ${data.usage.length} usage and ${data.lines.length} line records to ${args[0]}`)
    } else console.log(json)
  } else if (command === "help" || command === "--help" || command === "-h") help()
  else throw new Error(`Unknown command: ${command}. Run opencode-metrics help.`)
} catch (cause) {
  console.error(`opencode-metrics: ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exitCode = 1
}
