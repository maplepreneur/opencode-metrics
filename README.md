# OpenCode Metrics

Local, open-source usage and cost analytics for **all providers and models** in OpenCode V2, with an OpenCode Desktop panel and a CLI.

Track:

- provider, model, and variant usage;
- input, output, reasoning, cache-read, and cache-write tokens;
- reported and estimated AI cost;
- added, deleted, and changed lines of code;
- cost per changed or added line;
- projects, sessions, model calls, and daily activity;
- GitHub pull requests, AI cost per PR, and AI lines per PR;
- branch-based and manually overridden PR attribution;
- work that is not assigned to a PR.

**No account, server, telemetry, or companion website is required.** Local OpenCode APIs provide the required data. See [the research notes](./RESEARCH.md).

## Requirements

- OpenCode **2.2.7 or newer** (V2 plugin API);
- Node.js 22 or newer to build the plugin;
- OpenCode CLI on `PATH` for historical per-turn line diffs;
- Git for branch attribution;
- optional [GitHub CLI](https://cli.github.com/) (`gh`) for PR discovery. Run `gh auth login` yourself if needed; the plugin never receives your token.

Desktop panels use OpenCode's experimental GUI plugin API. The server collector and CLI work without Desktop.

## Install

### From a source checkout

```bash
git clone https://github.com/maplepreneur/opencode-metrics.git
cd opencode-metrics
npm ci
npm run build
```

Add the absolute checkout path to the global `~/.config/opencode/opencode.json(c)` to cover every project and enable the Desktop panel:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-metrics"]
}
```

For project-only collection, add the same entry to that project's `opencode.json(c)` instead. OpenCode reloads configuration changes automatically.

### From npm

Once published, the package can be installed like other OpenCode plugins:

```bash
opencode plugin add opencode-metrics
```

The package includes the server plugin, Desktop GUI, RPC contract, and `opencode-metrics` binary. The source-checkout instructions above do not require an npm release.

## Open the dashboard

In OpenCode Desktop, open a session's side panel and choose **Metrics**, or run **Open Metrics** from the command palette.

- **Full sync** imports all sessions and historical per-turn diffs.
- **Discover PRs** uses `gh pr list` for the current project.
- **Update API prices** refreshes public lab rates and recalculates all estimates.
- **Export** downloads the raw local metrics as JSON.
- **Save override** assigns the current session to a PR or excludes it from automatic attribution.

The dashboard has Overview, Models, Projects, and Pull requests tabs, plus 7/30/90-day and all-time ranges. Models are grouped by provider/model with expandable effort types (default, high, max, and others), and the provider dropdown filters the grouped rows. Grouped session totals are deduplicated across efforts.

## CLI

For a source checkout, either run `node bin/opencode-metrics.js` from the checkout or link the binary:

```bash
npm link
opencode-metrics report --all
```

Commands:

```text
opencode-metrics report [--days 30 | --all] [--project ID] [--provider ID] [--json]
opencode-metrics prices
opencode-metrics sync [--all] [--directory PATH] [--no-diffs]
opencode-metrics discover [--directory PATH] [--session ID] [--limit 100]
opencode-metrics assign SESSION_ID PR_NUMBER|none
opencode-metrics export [FILE]
```

The CLI discovers the same local OpenCode service as `opencode api`. Enable the plugin globally or in the directory where the command runs. `--directory` selects both the plugin location and sync/discovery directory.

Examples:

```bash
# Complete historical import for every project
opencode-metrics sync --all

# Refresh public API prices and recalculate all historical estimates
opencode-metrics prices

# Aggregate JSON for automation
opencode-metrics report --days 30 --json

# Grouped model summaries for one provider
opencode-metrics report --all --provider kimi-code-plan-global

# Discover GitHub PRs, then correct one session's attribution
opencode-metrics discover --directory /work/my-project
opencode-metrics assign ses_abc123 42

# Exclude a session from branch attribution
opencode-metrics assign ses_abc123 none

# Export raw usage, line, PR, and assignment records
opencode-metrics export ./metrics.json
```

## Metric definitions

### Cost

OpenCode records token usage and cost for every provider. The plugin does not special-case OpenCode, OpenCode Go, or any other provider.

Each usage record retains two values:

- **Reported cost**: the USD value supplied by OpenCode;
- **Public API estimate**: the value of the same tokens at public API list rates from [models.dev](https://models.dev/), or your explicit override. If no public model matches, the active OpenCode model catalog is the fallback.

**Effective cost**, used for project, model, daily, LOC, and PR totals and ratios, is reported cost when it is greater than zero. Otherwise it falls back to a nonzero public API estimate. The dashboard labels the resulting basis as `reported`, `estimated`, `mixed`, or `zero` and always shows reported and estimated totals separately. Model rows identify the exact pricing source, such as `public-api:moonshotai/kimi-k3.1-pro`.

This distinction matters because `$0` can mean a free model, an included subscription, a custom provider without pricing, or genuinely unmetered use. Public API estimates value subscription/free usage as if it were metered API usage; they are **not invoices or subscription charges**. Check provider bills for actual charges.

### Public API pricing catalog

The plugin refreshes `https://models.dev/api.json` on startup, every six hours, on full sync, and when you choose **Update API prices** in Desktop or run `opencode-metrics prices`. The refresh action also recalculates every stored usage record without re-importing line diffs. Only pricing metadata is cached in durable plugin storage.

An offline snapshot is bundled for OpenAI, Anthropic, Google, Moonshot global/CN, DeepSeek, xAI, and Mistral. The live catalog includes many additional providers. Exact model matches, context-price tiers, output/reasoning, and cache rates are supported. OpenCode/OpenCode Go routes and OpenRouter, Azure, Bedrock, Copilot, and Vertex-style model names resolve to upstream public labs when an exact public model is available. Unknown models never receive a guessed price.

Kimi subscription aliases include:

| Subscription model | Public API price model |
| --- | --- |
| `k3.1-pro` | `moonshotai/kimi-k3.1-pro` |
| `k3.1-pro-highspeed` | `moonshotai/kimi-k3.1-pro-highspeed` |
| `k3`, `k3-256k` | `moonshotai/kimi-k3` |
| `kimi-for-coding` | `moonshotai/kimi-k2.7-code` |
| `kimi-for-coding-highspeed` | `moonshotai/kimi-k2.7-code-highspeed` |

The `kimi-code-plan-cn` provider uses `moonshotai-cn` prices instead. For example, the global K3.1 Pro snapshot values regular input at $2/M, output at $10/M, cache reads at $0.20/M, and cache writes at $2/M. Rates can change; use the refresh action and inspect the model's pricing source.

Explicit `prices` overrides take precedence over public API and OpenCode catalog prices. Desktop and CLI currency values display exactly two decimal places; raw JSON retains full numeric precision.

Price overrides use USD per million tokens and the key `providerID/modelID`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-metrics",
      "options": {
        "opencodePath": "opencode",
        "prices": {
          "example-provider/example-model": {
            "input": 5,
            "output": 15,
            "cacheRead": 0.5,
            "cacheWrite": 6.25
          }
        }
      }
    }
  ]
}
```

The estimate prices output plus reasoning tokens at the output rate and includes cache rates. `opencodePath` is optional and defaults to `opencode`.

### Tokens

Input, output, reasoning, cache-read, and cache-write counts remain separate. `totalTokens` is input + output + reasoning; cached tokens are not folded into fresh input. Raw records preserve every category.

### Lines of code

A full sync uses OpenCode's public **per-turn snapshot diff** API. It records net additions/deletions for each turn, so repeated edits to the same hunk are not counted repeatedly. `linesChanged = linesAdded + linesDeleted`.

When the CLI/turn diff is unavailable, the plugin falls back to `FileDiff` metadata from completed file-editing tools. For direct edit/write tools without that metadata, it compares file contents before and after execution without storing those contents. Tool fallback counts are gross tool changes rather than net turn changes. If both exist for a turn, only the turn diff is aggregated.

`costPerLine = effectiveCost / linesChanged`; `costPerAddedLine = effectiveCost / linesAdded`. Ratios are `null` when the denominator is zero.

### Pull requests

`gh pr list --state all` stores PR number, title, URL, state, head branch, dates, and GitHub additions/deletions. Usage and line records on the same project and branch are attributed automatically. If a branch has multiple PRs, the most recently updated PR wins.

A manual session assignment overrides branch matching. An explicit exclusion prevents automatic attribution. PR rows identify `branch`, `manual`, `mixed`, or `none` attribution. Unassigned cost and lines remain visible and are never dropped from global totals.

GitHub line counts and AI session line counts are shown separately: they measure different things.

## Collection behavior

- Assistant usage is imported from persisted messages and refreshed on public session events.
- Completed compaction usage is included.
- Session totals are reconciled against assistant/compaction messages. The residual captures title/transient generation usage as one stable auxiliary record, preventing double-counting.
- Startup imports usage and tool metadata for the current location without spawning a process for every old turn.
- Full sync paginates through sessions and imports turn diffs. Stable message, turn, and tool IDs make repeated syncs idempotent.
- Model catalog changes refresh pricing metadata.

### Known limitations

- Historical imports know the branch at import time, not necessarily the branch used for every old message. Use session overrides for exact historical PR accounting.
- Per-turn diffs can include a human edit made during the same AI turn. Tool fallback can miss edits performed by arbitrary shell commands; full turn sync includes them.
- Auxiliary residual usage uses the session's currently selected model because title/transient generation records do not retain a per-message model.
- PR discovery currently supports GitHub through `gh`. Other forges can still use project/model/LOC analytics.
- OpenCode's Desktop GUI plugin API is experimental and may change.

## Privacy and storage

Records use OpenCode's durable plugin storage. They contain only session/project IDs, directories, branches, model identifiers, timestamps, token/cost counts, relative file paths and line counts, PR metadata, and attribution overrides.

The plugin **does not store prompts, source code, patch text, provider responses, API keys, or GitHub credentials**. Raw exports contain these metrics only. The pricing refresh sends only an anonymous HTTP GET to the public models.dev catalog; no session or usage data is included. Git, `gh`, and `opencode` subprocesses use argument arrays rather than interpolated shell commands.

## Development

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` builds the server/RPC entries and the one-file Desktop bundle, then runs aggregation, collector, storage, PR attribution, cost, token, and line-diff tests.

For live Desktop development, run `npm run build` after changes. The repository's `opencode.json` loads the checkout as a local plugin.

## Architecture

- `src/index.ts`: server lifecycle, events, hooks, and RPC implementation;
- `src/collector.ts`: usage, line, and auxiliary-total collection;
- `src/store.ts`: durable, stable-key local records;
- `src/metrics.ts`: pure aggregation and cost calculations;
- `src/pricing.ts`: live/cached public API prices and upstream model aliases;
- `src/pricing-fallback.ts`: generated offline snapshot (`npm run pricing:update`);
- `src/git.ts`: Git, GitHub CLI, and OpenCode turn-diff adapters;
- `src/rpc.ts`: typed RPC contract;
- `src/gui.tsx`: Solid OpenCode Desktop panel;
- `bin/opencode-metrics.js`: CLI and JSON export.

## License

[MIT](./LICENSE)
