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

Because collection, aggregation, persistence, Desktop presentation, and export are all local, creating a separate hosted website would add credential handling and privacy risk without adding a required capability.
