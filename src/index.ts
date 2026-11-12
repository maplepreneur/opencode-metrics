import { Plugin } from "@opencode/plugin"
import { Collector, type CollectorOptions } from "./collector.js"
import { discoverPullRequests } from "./git.js"
import { aggregate, prKey } from "./metrics.js"
import { MetricsRpc } from "./rpc.js"
import { MetricsStore } from "./store.js"
import type { ReportFilter, SessionAssignment } from "./types.js"

function options(value: unknown): CollectorOptions {
  if (!value || typeof value !== "object") return {}
  const input = value as Record<string, unknown>
  return {
    prices: input.prices && typeof input.prices === "object" ? (input.prices as CollectorOptions["prices"]) : undefined,
    opencodePath: typeof input.opencodePath === "string" ? input.opencodePath : undefined,
  }
}

function error(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default Plugin.define({
  id: "opencode-metrics",
  async setup(ctx) {
    const store = new MetricsStore(ctx.storage)
    const collector = new Collector(ctx, store, options(ctx.options))
    await collector.initialize()
    const controller = new AbortController()

    const registration = await ctx.rpc.register(MetricsRpc, {
      report: async (input) => aggregate(await store.export(), (input ?? {}) as ReportFilter),
      sync: async (input) => {
        const value = (input ?? {}) as { directory?: string; all?: boolean; diffs?: boolean }
        const result = await collector.sync(value)
        await registration.events.emit("changed", { reason: "sync" })
        return result
      },
      discover: async (input) => {
        const value = (input ?? {}) as { directory?: string; sessionID?: string; limit?: number }
        const session = value.sessionID ? await ctx.session.get({ sessionID: value.sessionID }) : undefined
        const directory = value.directory ?? session?.location.directory ?? ctx.location.directory
        let projectID = session?.projectID ?? ctx.location.project.id
        if (!session && directory !== ctx.location.directory) {
          const data = await store.export()
          const existing = [...data.usage, ...data.lines, ...data.pullRequests].reverse().find((record) => record.directory === directory)
          if (existing) projectID = existing.projectID
        }
        const pullRequests = await discoverPullRequests(directory, projectID, value.limit)
        for (const pr of pullRequests) await store.pullRequest(pr)
        await registration.events.emit("changed", { reason: "pull-requests" })
        return { count: pullRequests.length }
      },
      assign: async (input) => {
        const value = input as { sessionID: string; number: number | null }
        const session = await ctx.session.get({ sessionID: value.sessionID })
        if (value.number === null) {
          await store.unassign(value.sessionID)
          await registration.events.emit("changed", { reason: "assignment" })
          return { sessionID: value.sessionID, number: null }
        }
        if (!Number.isInteger(value.number) || value.number <= 0) throw new Error("PR number must be a positive integer or null")
        const key = prKey(session.projectID, value.number)
        const data = await store.export()
        if (!data.pullRequests.some((pr) => pr.key === key)) {
          throw new Error(`PR #${value.number} has not been discovered for this project. Run PR discovery first.`)
        }
        const assignment: SessionAssignment = {
          sessionID: value.sessionID,
          projectID: session.projectID,
          prKey: key,
          updatedAt: Date.now(),
        }
        await store.assign(assignment)
        await registration.events.emit("changed", { reason: "assignment" })
        return assignment
      },
      export: async () => store.export(),
    })

    async function changed(reason: string): Promise<void> {
      await registration.events.emit("changed", { reason })
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
          types: [
            "session.step.ended",
            "session.usage.updated",
            "session.compaction.ended",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "model.updated",
          ],
        })) {
          try {
            // Each location has its own plugin instance. Scoping prevents N
            // loaded projects from processing the same global event N times.
            if (event.location && event.location.directory !== ctx.location.directory) continue
            if (event.type === "model.updated") {
              await collector.refreshModels()
              continue
            }
            await collector.syncSession(
              event.data.sessionID,
              event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted",
            )
            await changed(event.type)
          } catch (cause) {
            console.error(`[opencode-metrics] ${event.type}: ${error(cause)}`)
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) console.error(`[opencode-metrics] event stream: ${error(cause)}`)
      }
    })()

    await ctx.tool.hook("execute.before", (event) => collector.beforeTool(event))
    await ctx.tool.hook("execute.after", (event) => {
      if (event.status === "completed") return collector.afterTool({ ...event, metadata: event.result.metadata })
    })

    // Import historical usage without launching one CLI process per old turn.
    // The Desktop/CLI Sync action performs the complete turn-diff import.
    void collector
      .sync({ directory: ctx.location.directory, diffs: false })
      .then(() => changed("startup"))
      .catch((cause) => console.error(`[opencode-metrics] startup import: ${error(cause)}`))

    return () => controller.abort()
  },
})
