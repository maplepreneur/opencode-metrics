# Changelog

## 0.3.0 — 2026-11-13

Model grouping and provider filters.

- Combine each provider/model into one cost and token summary row.
- Expand grouped rows to inspect default, high, max, and other effort variants.
- Deduplicate sessions across effort variants in grouped totals.
- Add a Desktop provider dropdown and CLI `--provider` filter.
- Display all USD values with exactly two decimal places while retaining raw JSON precision.
- Preserve per-variant rows in `models` and add grouped `modelGroups` to JSON reports.

## 0.2.0 — 2026-11-12

Public API-equivalent pricing update.

- Refresh and cache models.dev public API pricing for thousands of models.
- Bundle offline prices for 159 OpenAI, Anthropic, Google, Moonshot, DeepSeek, xAI, and Mistral models.
- Value Kimi global/CN subscriptions at Moonshot API rates, including K3.1 Pro, K3, coding, and high-speed aliases.
- Resolve OpenCode routes and common router/cloud model names to upstream labs.
- Apply context-price tiers and cache rates to project, daily, LOC, and PR estimates.
- Show pricing sources and catalog status in Desktop and raw reports.
- Add Desktop **Update API prices** and CLI `prices` recalculation actions.

## 0.1.0 — 2026-11-12

Initial release.

- Provider-neutral model, variant, token, cache, and cost collection.
- Reported and catalog/override-estimated cost analysis.
- Per-turn net LOC import with live tool-diff fallback.
- Project, model, day, PR, and unassigned-work aggregates.
- Cost per changed/added line and cost per PR.
- GitHub PR discovery, branch attribution, and session overrides.
- OpenCode Desktop dashboard, typed RPC, CLI, and raw JSON export.
- Durable idempotent local storage with no prompts or source code retained.
