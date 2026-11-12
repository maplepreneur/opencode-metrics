import { Command, MenuItem, Panel, Plugin, usePlugin, type PanelTab } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { MetricsRpc } from "./rpc.js"
import type { PricingStatus } from "./pricing.js"
import type { ExportData, Metrics, Report, SyncResult } from "./types.js"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 })
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

function usd(value: number): string {
  return money.format(value)
}

function num(value: number): string {
  return integer.format(value)
}

function perLine(value: number | null): string {
  return value === null ? "—" : usd(value)
}

function Card(props: { label: string; value: string; detail?: string }) {
  return (
    <div class="ocm-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <Show when={props.detail}><small>{props.detail}</small></Show>
    </div>
  )
}

function MetricCards(props: { metrics: Metrics }) {
  return (
    <div class="ocm-grid">
      <Card label="Effective AI cost" value={usd(props.metrics.cost)} detail={`${usd(props.metrics.reportedCost)} reported · ${usd(props.metrics.estimatedCost)} public API estimate`} />
      <Card label="Changed lines" value={num(props.metrics.linesChanged)} detail={`+${num(props.metrics.linesAdded)} / −${num(props.metrics.linesDeleted)}`} />
      <Card label="Cost / changed line" value={perLine(props.metrics.costPerLine)} detail={`${perLine(props.metrics.costPerAddedLine)} / added line`} />
      <Card label="Input tokens" value={num(props.metrics.inputTokens)} detail={`${num(props.metrics.cacheReadTokens)} cache read · ${num(props.metrics.cacheWriteTokens)} cache write`} />
      <Card label="Output tokens" value={num(props.metrics.outputTokens)} detail={`${num(props.metrics.reasoningTokens)} reasoning`} />
      <Card label="Activity" value={`${num(props.metrics.sessions)} sessions`} detail={`${num(props.metrics.steps)} model calls · ${num(props.metrics.prs)} attributed PRs`} />
    </div>
  )
}

function Dashboard(props: { session: { id: string; directory: string } }) {
  const ctx = usePlugin()
  const [report, setReport] = createSignal<Report>()
  const [pricing, setPricing] = createSignal<PricingStatus>()
  const [tab, setTab] = createSignal("overview")
  const [days, setDays] = createSignal(30)
  const [busy, setBusy] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [failure, setFailure] = createSignal("")
  const [assignment, setAssignment] = createSignal("")
  let timer: ReturnType<typeof setTimeout> | undefined

  async function load(): Promise<void> {
    try {
      const dayCount = days()
      const [result, priceStatus] = await Promise.all([
        ctx.client.rpc(MetricsRpc).report({ from: dayCount ? Date.now() - dayCount * 86_400_000 : undefined }) as Promise<Report>,
        ctx.client.rpc(MetricsRpc).pricing({}) as Promise<PricingStatus>,
      ])
      setReport(result)
      setPricing(priceStatus)
      setFailure("")
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function scheduleLoad(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void load(), 750)
  }

  async function action(name: string, run: () => Promise<string>): Promise<void> {
    setBusy(name)
    setMessage("")
    setFailure("")
    try {
      setMessage(await run())
      await load()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy("")
    }
  }

  async function sync(): Promise<void> {
    await action("sync", async () => {
      const result = (await ctx.client.rpc(MetricsRpc).sync({ all: true, diffs: true })) as SyncResult
      return `Synced ${result.sessions} sessions: ${result.usageRecords} usage and ${result.lineRecords} line records processed${result.errors.length ? `; ${result.errors.length} warnings` : ""}.`
    })
  }

  async function discover(): Promise<void> {
    await action("discover", async () => {
      const result = (await ctx.client.rpc(MetricsRpc).discover({ sessionID: props.session.id })) as { count: number }
      return `Discovered ${result.count} pull requests for this project.`
    })
  }

  async function refreshPrices(): Promise<void> {
    await action("prices", async () => {
      const result = (await ctx.client.rpc(MetricsRpc).refreshPricing({})) as { pricing: PricingStatus; sync: SyncResult }
      setPricing(result.pricing)
      return `Updated ${result.pricing.models} public API price entries and recalculated ${result.sync.usageRecords} usage records.`
    })
  }

  async function assign(): Promise<void> {
    const selected = assignment()
    await action("assign", async () => {
      await ctx.client.rpc(MetricsRpc).assign({ sessionID: props.session.id, number: selected ? Number(selected) : null })
      return selected ? `Assigned this session to PR #${selected}.` : "Excluded this session from automatic PR attribution."
    })
  }

  async function exportJson(): Promise<void> {
    await action("export", async () => {
      const data = (await ctx.client.rpc(MetricsRpc).export({})) as ExportData
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `opencode-metrics-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return `Exported ${data.usage.length} usage and ${data.lines.length} line records.`
    })
  }

  onMount(() => {
    void load()
    const unsubscribe = ctx.client.rpc(MetricsRpc).events.on("changed", scheduleLoad)
    const interval = setInterval(() => void load(), 30_000)
    onCleanup(() => {
      unsubscribe()
      clearInterval(interval)
      if (timer) clearTimeout(timer)
    })
  })

  return (
    <div class="ocm">
      <style>{css}</style>
      <header class="ocm-header">
        <div><h2>OpenCode Metrics</h2><p>Local, provider-neutral AI cost analysis</p></div>
        <div class="ocm-actions">
          <button disabled={!!busy()} onClick={() => void sync()}>{busy() === "sync" ? "Syncing…" : "Full sync"}</button>
          <button disabled={!!busy()} onClick={() => void discover()}>{busy() === "discover" ? "Discovering…" : "Discover PRs"}</button>
          <button disabled={!!busy()} onClick={() => void refreshPrices()}>{busy() === "prices" ? "Updating…" : "Update API prices"}</button>
          <button disabled={!!busy()} onClick={() => void exportJson()}>Export</button>
        </div>
      </header>
      <div class="ocm-toolbar">
        <label>Range <select value={days()} onChange={(event) => { setDays(Number(event.currentTarget.value)); void load() }}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={0}>All time</option>
        </select></label>
        <span>Cost basis: {report()?.totals.costBasis ?? "—"}</span>
        <span>API prices: {pricing() ? `${pricing()!.source} · ${pricing()!.models} models` : "—"}</span>
      </div>
      <Show when={message()}><div class="ocm-notice">{message()}</div></Show>
      <Show when={failure()}><div class="ocm-error">{failure()}</div></Show>
      <Show when={report()} fallback={<p class="ocm-muted">Loading local metrics…</p>}>
        {(data) => <>
          <MetricCards metrics={data().totals} />
          <nav class="ocm-tabs">
            <For each={["overview", "models", "projects", "prs"]}>{(item) => <button classList={{ active: tab() === item }} onClick={() => setTab(item)}>{item === "prs" ? "Pull requests" : item}</button>}</For>
          </nav>
          <Show when={tab() === "overview"}>
            <section>
              <h3>Daily activity</h3>
              <div class="ocm-table"><table><thead><tr><th>Date</th><th>Sessions</th><th>Input</th><th>Output</th><th>Lines</th><th>Cost</th><th>Cost / line</th></tr></thead>
                <tbody><For each={[...data().days].reverse().slice(0, 14)} fallback={<Empty columns={7} text="No usage in this range" />}>{(day) => <tr><td>{day.date}</td><td>{num(day.sessions)}</td><td>{num(day.inputTokens)}</td><td>{num(day.outputTokens)}</td><td>{num(day.linesChanged)}</td><td>{usd(day.cost)}</td><td>{perLine(day.costPerLine)}</td></tr>}</For></tbody>
              </table></div>
              <div class="ocm-unassigned"><strong>Unassigned to a PR</strong><span>{usd(data().unassigned.cost)} · {num(data().unassigned.linesChanged)} lines · {num(data().unassigned.sessions)} sessions</span></div>
              <p class="ocm-note">Effective cost uses OpenCode's reported cost, falling back to public API-equivalent or configured estimates only when reported cost is zero. Public API estimates value subscription and free usage at list token rates; they are not invoices. Token total excludes cache to avoid presenting cached input as fresh input.</p>
            </section>
          </Show>
          <Show when={tab() === "models"}>
            <div class="ocm-table"><table><thead><tr><th>Provider / model</th><th>Calls</th><th>Input</th><th>Output</th><th>Reasoning</th><th>Cache read</th><th>Cost</th></tr></thead>
              <tbody><For each={data().models} fallback={<Empty columns={7} text="No model usage" />}>{(model) => <tr><td><strong>{model.providerID}/{model.modelID}</strong><small>{model.variant ?? "default variant"}{model.pricingSources.length ? ` · ${model.pricingSources.join(", ")}` : " · no public API price match"}</small></td><td>{num(model.steps)}</td><td>{num(model.inputTokens)}</td><td>{num(model.outputTokens)}</td><td>{num(model.reasoningTokens)}</td><td>{num(model.cacheReadTokens)}</td><td>{usd(model.cost)}</td></tr>}</For></tbody>
            </table></div>
          </Show>
          <Show when={tab() === "projects"}>
            <div class="ocm-table"><table><thead><tr><th>Project</th><th>Sessions</th><th>Tokens</th><th>Lines +/−</th><th>Cost</th><th>Cost / line</th></tr></thead>
              <tbody><For each={data().projects} fallback={<Empty columns={6} text="No projects" />}>{(project) => <tr><td><strong>{project.name}</strong><small>{project.directory}</small></td><td>{num(project.sessions)}</td><td>{num(project.totalTokens)}</td><td>+{num(project.linesAdded)} / −{num(project.linesDeleted)}</td><td>{usd(project.cost)}</td><td>{perLine(project.costPerLine)}</td></tr>}</For></tbody>
            </table></div>
          </Show>
          <Show when={tab() === "prs"}>
            <div class="ocm-assignment">
              <label>Assign current session <select value={assignment()} onChange={(event) => setAssignment(event.currentTarget.value)}>
                <option value="">Exclude from PR attribution</option>
                <For each={data().pullRequests}>{(row) => <option value={row.pr.number}>#{row.pr.number} {row.pr.title}</option>}</For>
              </select></label>
              <button disabled={!!busy()} onClick={() => void assign()}>Save override</button>
            </div>
            <div class="ocm-table"><table><thead><tr><th>PR</th><th>Branch</th><th>Attribution</th><th>AI lines</th><th>GitHub lines</th><th>Cost</th><th>Cost / line</th></tr></thead>
              <tbody><For each={data().pullRequests} fallback={<Empty columns={7} text="Discover PRs to begin branch attribution" />}>{(row) => <tr><td><a href={row.pr.url} target="_blank" rel="noreferrer">#{row.pr.number} {row.pr.title}</a><small>{row.pr.state}</small></td><td>{row.pr.branch}</td><td>{row.attribution}</td><td>{num(row.linesChanged)}</td><td>+{num(row.githubLinesAdded)} / −{num(row.githubLinesDeleted)}</td><td>{usd(row.cost)}</td><td>{perLine(row.costPerLine)}</td></tr>}</For></tbody>
            </table></div>
          </Show>
        </>}
      </Show>
    </div>
  )
}

function Empty(props: { columns: number; text: string }) {
  return <tr><td colspan={props.columns} class="ocm-muted">{props.text}</td></tr>
}

export default Plugin.define({
  i18n: { en: { title: "Metrics", open: "Open Metrics" } },
  setup(ctx) {
    const mainTab: PanelTab = { id: "main", title: "Metrics", closable: "compact", fallback: true }
    ctx.add(Panel, {
      id: "main",
      region: "side",
      mobile: { title: "Metrics", order: 45, kind: "menu", icon: "models" },
      list: (input) => (input.open.includes("main") ? [mainTab] : []),
      render: (props) => <Dashboard session={props.session} />,
    })
    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current()
      return {
        menu: "session.panel",
        id: "open",
        title: "Metrics",
        icon: "models",
        keybind: "opencode-metrics.open",
        opened: !!session && ctx.layout.state("opencode-metrics:main", session) !== "closed",
        run: () => { if (session) ctx.layout.open("opencode-metrics:main", session) },
      }
    })
    ctx.add(Command, {
      id: "open",
      title: "Open Metrics",
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open("opencode-metrics:main", session)
      },
    })
  },
})

const css = `
.ocm { padding: 16px; font-size: 12px; line-height: 1.45; overflow: auto; height: 100%; box-sizing: border-box; }
.ocm * { box-sizing: border-box; }
.ocm-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.ocm h2 { font-size: 18px; margin: 0; } .ocm h3 { font-size: 13px; margin: 18px 0 8px; }
.ocm-header p, .ocm-note { opacity: .65; margin: 3px 0 12px; }
.ocm-actions, .ocm-toolbar, .ocm-tabs, .ocm-assignment { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ocm button, .ocm select { font: inherit; color: inherit; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); background: color-mix(in srgb, currentColor 5%, transparent); border-radius: 5px; padding: 5px 8px; }
.ocm button { cursor: pointer; } .ocm button:disabled { opacity: .45; cursor: wait; }
.ocm-toolbar { justify-content: space-between; margin: 12px 0; opacity: .75; }
.ocm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 8px; }
.ocm-card { border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 7px; padding: 10px; min-width: 0; }
.ocm-card span, .ocm-card small { display: block; opacity: .62; } .ocm-card strong { display: block; font-size: 17px; margin: 4px 0; }
.ocm-tabs { border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); margin: 16px 0 10px; }
.ocm-tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; text-transform: capitalize; }
.ocm-tabs button.active { border-bottom-color: currentColor; }
.ocm-table { overflow: auto; } .ocm table { border-collapse: collapse; width: 100%; white-space: nowrap; }
.ocm th, .ocm td { text-align: right; padding: 8px; border-bottom: 1px solid color-mix(in srgb, currentColor 9%, transparent); vertical-align: top; }
.ocm th:first-child, .ocm td:first-child { text-align: left; } .ocm th { opacity: .6; font-weight: 500; }
.ocm td small { display: block; opacity: .55; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
.ocm a { color: inherit; } .ocm-muted { opacity: .55; text-align: center !important; padding: 24px !important; }
.ocm-notice, .ocm-error { padding: 8px; border-radius: 5px; margin: 8px 0; background: color-mix(in srgb, currentColor 7%, transparent); }
.ocm-error { border: 1px solid #d66; } .ocm-unassigned { display: flex; justify-content: space-between; gap: 12px; margin-top: 14px; padding: 10px; border: 1px dashed color-mix(in srgb, currentColor 20%, transparent); border-radius: 6px; }
.ocm-assignment { margin-bottom: 12px; } .ocm-assignment label { display: flex; gap: 7px; align-items: center; }
`
