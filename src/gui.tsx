import { Command, MenuItem, Panel, Plugin, usePlugin, type PanelTab } from "@opencode/plugin/gui"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { MetricsRpc } from "./rpc.js"
import { nextSort, sortRows as orderRows } from "./sort.js"
import type { PricingStatus } from "./pricing.js"
import type { ExportData, Metrics, ModelGroupMetrics, Report, SyncResult } from "./types.js"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

function ModelBreakdown(props: { models: ModelGroupMetrics[] }) {
  return <div class="ocm-breakdown">
    <strong class="ocm-breakdown-title">Models used</strong>
    <For each={props.models} fallback={<span class="ocm-muted">No model usage attributed</span>}>{(model) => <div class="ocm-breakdown-model">
      <div class="ocm-breakdown-heading"><strong>{model.providerID}/{model.modelID}</strong><strong>{usd(model.cost)}</strong></div>
      <small>{num(model.steps)} calls · {num(model.inputTokens)} input · {num(model.outputTokens)} output · {num(model.reasoningTokens)} reasoning · {num(model.sessions)} sessions</small>
      <div class="ocm-efforts"><For each={model.variants}>{(variant) => <span>{variant.variant ?? "default"}: {usd(variant.cost)} · {num(variant.steps)} calls</span>}</For></div>
    </div>}</For>
  </div>
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
  const [providerFilter, setProviderFilter] = createSignal("all")
  const [expandedModels, setExpandedModels] = createSignal<Record<string, boolean>>({})
  const [sorts, setSorts] = createSignal<Record<string, { key: string; direction: "asc" | "desc" }>>({})
  const [selectedProject, setSelectedProject] = createSignal("")
  const [projectDetail, setProjectDetail] = createSignal<Report>()
  const [detailBusy, setDetailBusy] = createSignal(false)
  const [expandedPR, setExpandedPR] = createSignal("")
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
      if (selectedProject()) void openProject(selectedProject())
      if (providerFilter() !== "all" && !result.modelGroups.some((model) => model.providerID === providerFilter())) {
        setProviderFilter("all")
      }
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

  function field(row: unknown, key: string): string | number | null {
    const value = (row as Record<string, unknown>)[key]
    return typeof value === "string" || typeof value === "number" || value === null ? value : null
  }

  function sortRows<Row>(table: string, rows: Row[], value: (row: Row, key: string) => string | number | null): Row[] {
    return orderRows(rows, sorts()[table], value)
  }

  function toggleSort(table: string, key: string): void {
    setSorts((currentSorts) => ({ ...currentSorts, [table]: nextSort(currentSorts[table], key) }))
  }

  function sortHeader(table: string, key: string, label: string) {
    const sort = sorts()[table]
    const active = sort?.key === key
    return <button class="ocm-sort" onClick={() => toggleSort(table, key)} aria-label={`Sort by ${label}${active ? `, ${sort.direction === "asc" ? "ascending" : "descending"}` : ""}`}>
      {label}<span>{active ? (sort.direction === "asc" ? " ▲" : " ▼") : " ↕"}</span>
    </button>
  }

  function modelGroups() {
    const filtered = report()?.modelGroups.filter((model) => providerFilter() === "all" || model.providerID === providerFilter()) ?? []
    return sortRows("models", filtered, (model, key) => key === "name" ? `${model.providerID}/${model.modelID}` : field(model, key))
  }

  function dailyRows() {
    const rows = report()?.days ?? []
    const sorted = sorts().daily
      ? sortRows("daily", rows, (day, key) => field(day, key))
      : [...rows].reverse()
    return sorted.slice(0, 14)
  }

  function projectRows() {
    return sortRows("projects", report()?.projects ?? [], (project, key) => field(project, key))
  }

  function pullRequestRows() {
    return sortRows("prs", report()?.pullRequests ?? [], (row, key) => {
      if (key === "title") return row.pr.title
      if (key === "githubLinesChanged") return row.githubLinesAdded + row.githubLinesDeleted
      return field(row, key)
    })
  }

  function providers() {
    return [...new Set(report()?.modelGroups.map((model) => model.providerID) ?? [])].sort()
  }

  function toggleModel(key: string): void {
    setExpandedModels((current) => ({ ...current, [key]: !current[key] }))
  }

  function togglePR(key: string): void {
    setExpandedPR((current) => current === key ? "" : key)
  }

  async function openProject(projectID: string): Promise<void> {
    setSelectedProject(projectID)
    setProjectDetail(undefined)
    setExpandedPR("")
    setDetailBusy(true)
    try {
      const dayCount = days()
      const result = await ctx.client.rpc(MetricsRpc).report({
        projectID,
        from: dayCount ? Date.now() - dayCount * 86_400_000 : undefined,
      }) as Report
      setProjectDetail(result)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDetailBusy(false)
    }
  }

  function mostUsed(report: Report): ModelGroupMetrics | undefined {
    return [...report.modelGroups].sort((a, b) => b.steps - a.steps)[0]
  }

  function highestCost(report: Report): ModelGroupMetrics | undefined {
    return [...report.modelGroups].sort((a, b) => b.cost - a.cost)[0]
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
              <div class="ocm-table"><table><thead><tr><th>{sortHeader("daily", "date", "Date")}</th><th>{sortHeader("daily", "sessions", "Sessions")}</th><th>{sortHeader("daily", "inputTokens", "Input")}</th><th>{sortHeader("daily", "outputTokens", "Output")}</th><th>{sortHeader("daily", "linesChanged", "Lines")}</th><th>{sortHeader("daily", "cost", "Cost")}</th><th>{sortHeader("daily", "costPerLine", "Cost / line")}</th></tr></thead>
                <tbody><For each={dailyRows()} fallback={<Empty columns={7} text="No usage in this range" />}>{(day) => <tr><td>{day.date}</td><td>{num(day.sessions)}</td><td>{num(day.inputTokens)}</td><td>{num(day.outputTokens)}</td><td>{num(day.linesChanged)}</td><td>{usd(day.cost)}</td><td>{perLine(day.costPerLine)}</td></tr>}</For></tbody>
              </table></div>
              <div class="ocm-unassigned"><strong>Unassigned to a PR</strong><span>{usd(data().unassigned.cost)} · {num(data().unassigned.linesChanged)} lines · {num(data().unassigned.sessions)} sessions</span></div>
              <p class="ocm-note">Effective cost uses OpenCode's reported cost, falling back to public API-equivalent or configured estimates only when reported cost is zero. Public API estimates value subscription and free usage at list token rates; they are not invoices. Token total excludes cache to avoid presenting cached input as fresh input.</p>
            </section>
          </Show>
          <Show when={tab() === "models"}>
            <div class="ocm-model-filter">
              <label>Provider <select value={providerFilter()} onChange={(event) => setProviderFilter(event.currentTarget.value)}>
                <option value="all">All providers</option>
                <For each={providers()}>{(provider) => <option value={provider}>{provider}</option>}</For>
              </select></label>
              <span>{modelGroups().length} {modelGroups().length === 1 ? "model" : "models"}</span>
            </div>
            <div class="ocm-table"><table><thead><tr><th>{sortHeader("models", "name", "Provider / model")}</th><th>{sortHeader("models", "steps", "Calls")}</th><th>{sortHeader("models", "inputTokens", "Input")}</th><th>{sortHeader("models", "outputTokens", "Output")}</th><th>{sortHeader("models", "reasoningTokens", "Reasoning")}</th><th>{sortHeader("models", "cacheReadTokens", "Cache read")}</th><th>{sortHeader("models", "cost", "Cost")}</th></tr></thead>
              <tbody><For each={modelGroups()} fallback={<Empty columns={7} text="No model usage for this provider" />}>{(group) => {
                const key = `${group.providerID}/${group.modelID}`
                const expanded = () => !!expandedModels()[key]
                return <>
                  <tr class="ocm-model-group">
                    <td><button class="ocm-expand" aria-expanded={expanded()} aria-label={`${expanded() ? "Hide" : "Show"} effort types for ${key}`} onClick={() => toggleModel(key)}>{expanded() ? "▾" : "▸"}</button><strong>{key}</strong><small>{group.variants.length} {group.variants.length === 1 ? "effort type" : "effort types"}{group.pricingSources.length ? ` · ${group.pricingSources.join(", ")}` : " · no public API price match"}</small></td>
                    <td>{num(group.steps)}</td><td>{num(group.inputTokens)}</td><td>{num(group.outputTokens)}</td><td>{num(group.reasoningTokens)}</td><td>{num(group.cacheReadTokens)}</td><td>{usd(group.cost)}</td>
                  </tr>
                  <Show when={expanded()}><For each={sortRows("models", group.variants, (variant, key) => key === "name" ? (variant.variant ?? "default") : field(variant, key))}>{(variant) => <tr class="ocm-variant">
                    <td><span>Effort: <strong>{variant.variant ?? "default"}</strong></span><small>{variant.pricingSources.join(", ") || "no public API price match"}</small></td>
                    <td>{num(variant.steps)}</td><td>{num(variant.inputTokens)}</td><td>{num(variant.outputTokens)}</td><td>{num(variant.reasoningTokens)}</td><td>{num(variant.cacheReadTokens)}</td><td>{usd(variant.cost)}</td>
                  </tr>}</For></Show>
                </>
              }}</For></tbody>
            </table></div>
          </Show>
          <Show when={tab() === "projects"}>
            <Show when={selectedProject()}>
              <section class="ocm-detail">
                <div class="ocm-detail-header"><h3>Project drill-down</h3><button onClick={() => { setSelectedProject(""); setProjectDetail(undefined) }}>Close</button></div>
                <Show when={detailBusy()}><p class="ocm-muted">Loading project details…</p></Show>
                <Show when={projectDetail()}>{(detail) => <>
                  <h3>{detail().projects[0]?.name ?? selectedProject()}</h3><p class="ocm-note">{detail().projects[0]?.directory}</p>
                  <MetricCards metrics={detail().totals} />
                  <div class="ocm-model-highlights">
                    <span>Most used: <strong>{mostUsed(detail()) ? `${mostUsed(detail())!.providerID}/${mostUsed(detail())!.modelID} (${num(mostUsed(detail())!.steps)} calls)` : "—"}</strong></span>
                    <span>Highest cost: <strong>{highestCost(detail()) ? `${highestCost(detail())!.providerID}/${highestCost(detail())!.modelID} (${usd(highestCost(detail())!.cost)})` : "—"}</strong></span>
                  </div>
                  <h3>Pull requests in this project</h3>
                  <For each={detail().pullRequests} fallback={<p class="ocm-muted">No PRs discovered for this project</p>}>{(row) => <div class="ocm-pr-detail">
                    <button class="ocm-pr-button" aria-expanded={expandedPR() === row.pr.key} onClick={() => togglePR(row.pr.key)}>{expandedPR() === row.pr.key ? "▾" : "▸"} #{row.pr.number} {row.pr.title}<strong>{usd(row.cost)}</strong></button>
                    <small>{row.attribution} · {num(row.sessions)} sessions · {num(row.steps)} calls · {num(row.linesChanged)} AI lines</small>
                    <Show when={expandedPR() === row.pr.key}><ModelBreakdown models={row.models} /></Show>
                  </div>}</For>
                  <h3>Models in this project</h3><ModelBreakdown models={detail().modelGroups} />
                </>}</Show>
              </section>
            </Show>
            <div class="ocm-table"><table><thead><tr><th>{sortHeader("projects", "name", "Project")}</th><th>{sortHeader("projects", "sessions", "Sessions")}</th><th>{sortHeader("projects", "totalTokens", "Tokens")}</th><th>{sortHeader("projects", "linesChanged", "Lines +/−")}</th><th>{sortHeader("projects", "cost", "Cost")}</th><th>{sortHeader("projects", "costPerLine", "Cost / line")}</th></tr></thead>
              <tbody><For each={projectRows()} fallback={<Empty columns={6} text="No projects" />}>{(project) => <tr><td><button class="ocm-link" title={`Drill down into ${project.name}`} onClick={() => void openProject(project.projectID)}><strong>{project.name}</strong></button><small>{project.directory}</small></td><td>{num(project.sessions)}</td><td>{num(project.totalTokens)}</td><td>+{num(project.linesAdded)} / −{num(project.linesDeleted)}</td><td>{usd(project.cost)}</td><td>{perLine(project.costPerLine)}</td></tr>}</For></tbody>
            </table></div>
          </Show>
          <Show when={tab() === "prs"}>
            <div class="ocm-assignment">
              <label>Assign current session <select value={assignment()} onChange={(event) => setAssignment(event.currentTarget.value)}>
                <option value="">Exclude from PR attribution</option>
                <For each={data().pullRequests}>{(row) => <option value={row.pr.number}>#{row.pr.number} {row.pr.title} — {row.projectName}</option>}</For>
              </select></label>
              <button disabled={!!busy()} onClick={() => void assign()}>Save override</button>
            </div>
            <div class="ocm-table"><table><thead><tr><th>{sortHeader("prs", "projectName", "Project")}</th><th>{sortHeader("prs", "title", "PR")}</th><th>{sortHeader("prs", "branch", "Branch")}</th><th>{sortHeader("prs", "attribution", "Attribution")}</th><th>{sortHeader("prs", "linesChanged", "AI lines")}</th><th>{sortHeader("prs", "githubLinesChanged", "GitHub lines")}</th><th>{sortHeader("prs", "cost", "Cost")}</th><th>{sortHeader("prs", "costPerLine", "Cost / line")}</th></tr></thead>
              <tbody><For each={pullRequestRows()} fallback={<Empty columns={8} text="Discover PRs to begin branch attribution" />}>{(row) => <>
                <tr><td><strong>{row.projectName}</strong><small>{row.projectDirectory}</small></td><td><button class="ocm-link" aria-expanded={expandedPR() === row.pr.key} title="Show models used in this PR" onClick={() => togglePR(row.pr.key)}>{expandedPR() === row.pr.key ? "▾" : "▸"} #{row.pr.number} {row.pr.title}</button><small>{row.pr.state} · <a href={row.pr.url} target="_blank" rel="noreferrer">open on GitHub ↗</a></small></td><td>{row.pr.branch}</td><td>{row.attribution}</td><td>{num(row.linesChanged)}</td><td>+{num(row.githubLinesAdded)} / −{num(row.githubLinesDeleted)}</td><td>{usd(row.cost)}</td><td>{perLine(row.costPerLine)}</td></tr>
                <Show when={expandedPR() === row.pr.key}><tr class="ocm-pr-breakdown"><td colspan={8}><ModelBreakdown models={row.models} /></td></tr></Show>
              </>}</For></tbody>
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
.ocm select { color-scheme: light dark; }
.ocm select option { background: Canvas; color: CanvasText; }
@media (prefers-color-scheme: dark) {
  .ocm select { color-scheme: dark; }
  .ocm select option { background: #202521; color: #f5f5f5; }
}
.ocm th button.ocm-sort { border: 0; background: none; padding: 0; font: inherit; font-weight: 500; color: inherit; white-space: nowrap; }
.ocm th button.ocm-sort span { opacity: .65; font-size: 10px; }
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
.ocm-model-filter { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.ocm-model-filter label { display: flex; align-items: center; gap: 7px; } .ocm-model-filter span { opacity: .6; }
.ocm .ocm-expand { width: 24px; margin-right: 5px; padding: 1px 4px; font-size: 15px; line-height: 1.2; }
.ocm-variant { background: color-mix(in srgb, currentColor 3%, transparent); }
.ocm-variant td:first-child { padding-left: 37px; } .ocm-variant td { opacity: .82; }
.ocm .ocm-link { border: 0; background: none; padding: 0; text-align: left; text-decoration: underline; text-decoration-style: dotted; }
.ocm-detail { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 7px; padding: 12px; margin-bottom: 14px; }
.ocm-detail-header, .ocm-breakdown-heading, .ocm-model-highlights { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.ocm-detail-header h3 { margin: 0; } .ocm-model-highlights { justify-content: flex-start; margin: 12px 0; opacity: .8; }
.ocm-pr-detail { border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); padding: 8px 0; }
.ocm .ocm-pr-button { display: flex; justify-content: space-between; gap: 12px; width: 100%; border: 0; background: none; padding: 3px 0; text-align: left; }
.ocm-breakdown { padding: 8px; margin: 5px 0; border-left: 2px solid color-mix(in srgb, currentColor 20%, transparent); }
.ocm-breakdown-title { display: block; margin-bottom: 6px; }
.ocm-breakdown-model { padding: 7px 0; border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
.ocm-breakdown-model small { display: block; opacity: .65; } .ocm-efforts { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 5px; }
.ocm-efforts span { padding: 2px 5px; border-radius: 4px; background: color-mix(in srgb, currentColor 6%, transparent); opacity: .75; }
.ocm-pr-breakdown td { background: color-mix(in srgb, currentColor 3%, transparent); }
`
