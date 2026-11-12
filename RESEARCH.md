# Feasibility research

## Conclusion

A hosted account service is **not required**. The requested metrics can be collected and analyzed locally with OpenCode V2's public APIs, so this project deliberately has no website or signup flow.

Research was performed against the OpenCode 2.2.7 documentation and runtime on 2026-11-12:

- [Plugin overview](https://opencode.ai/docs/build/plugins): server, TUI, Desktop GUI, and RPC package parts.
- [Server plugins](https://opencode.ai/docs/build/plugins/server): session messages, model catalogs, durable plugin storage, public events, tool hooks, project/location metadata, and VCS access.
- [Desktop GUI plugins](https://opencode.ai/docs/build/plugins/gui): side panels, commands, and Solid components.
- [Plugin RPC](https://opencode.ai/docs/build/plugins/rpc): typed methods/events shared with Desktop and local clients.
- [HTTP API](https://opencode.ai/docs/api): session messages, per-turn diffs, model/provider information, projects, events, and plugin RPC.

## Data mapping

| Requested metric | Local source |
| --- | --- |
| Models/providers/variants | Persisted assistant message `model` and session model |
| Input/output/reasoning/cache tokens | `TokenUsage.Info` on messages and sessions |
| AI cost | Message/session `cost`, plus model catalog rates for explicit estimates |
| Lines of code | `GET /api/session/{sessionID}/diff`, with tool `FileDiff` fallback |
| Projects | `Session.Info.projectID` and `Session.Info.location.directory` |
| PR cost and LOC | Stored GitHub PR branch metadata matched to session records; manual overrides |
| Desktop analysis | GUI panel calling the local server plugin through RPC |
| Durable history/export | OpenCode plugin storage and JSON export |

The durable `session.usage.recorded` log event is not in the subscribable public event union. The collector therefore uses public session events and reconciles authoritative session totals against persisted assistant/compaction messages. The residual represents auxiliary title/transient generation usage without double-counting normal steps.

The Promise plugin context exposes session context but not the turn-diff method. Full sync calls the documented HTTP route through `opencode api`, using argument-safe subprocess execution. Live tool metadata provides a Desktop-only fallback.

## Verification during development

The implementation was loaded by OpenCode 2.2.7 as an active local plugin with `server`, `rpc`, and `gui` features. Real RPC report/export calls succeeded. A targeted sync processed 6 sessions, 366 usage records, and 90 line records with no errors. The subsequent all-project sync processed 151 sessions, 3,419 usage records, and 1,246 line records; two sessions with deleted working directories produced isolated warnings while the remaining history completed. The resulting report returned 10 project groups and 14 provider/model/variant groups. PR discovery also executed successfully; the initially empty repository had no PRs to return.

## Public API-equivalent pricing

Version 0.2.0 separates actual reported charges from public API-equivalent value. Subscription provider catalogs such as `kimi-code-plan-global` report zero token rates, so the estimator resolves usage to public lab models instead of treating that zero as an API price. Kimi's public K3.1 Pro documentation lists $2/M regular input, $10/M output, and $0.20/M cached input, matching the models.dev Moonshot catalog used by the plugin. Google's official Gemini API pricing likewise documents output-inclusive thinking tokens, cache rates, and time-limited prices; the live catalog refresh allows those rates to change without a plugin release.

Pricing references:

- https://models.dev/api.json — refreshable cross-provider pricing metadata and context tiers
- https://www.kimi.ai/resources/kimi-k3-1-pro-pricing — Kimi K3.1 Pro membership/API distinction and public token rates
- https://openai.com/api/pricing/ — OpenAI API prices
- https://www.anthropic.com/pricing#api — Anthropic subscription/API distinction
- https://ai.google.dev/gemini-api/docs/pricing — Gemini API token, reasoning, cache, and tier prices

An offline models.dev snapshot covers major labs. Refreshing prices requires no credentials and sends no usage data. Actual reported cost remains unchanged and visible beside the public API estimate.

Because collection, aggregation, persistence, Desktop presentation, and export are all local, creating a separate hosted website would add credential handling and privacy risk without adding a required capability.
