import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { FileLineChange, PullRequestRecord } from "./types.js"
import { prKey } from "./metrics.js"

const execute = promisify(execFile)
const branchCache = new Map<string, { branch?: string; expires: number }>()

async function run(command: string, args: string[], cwd?: string, timeout = 30_000): Promise<string> {
  const result = await execute(command, args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  })
  return result.stdout
}

export async function currentBranch(directory: string): Promise<string | undefined> {
  const cached = branchCache.get(directory)
  if (cached && cached.expires > Date.now()) return cached.branch
  let branch: string | undefined
  try {
    branch = (await run("git", ["branch", "--show-current"], directory, 5_000)).trim() || undefined
  } catch {
    branch = undefined
  }
  branchCache.set(directory, { branch, expires: Date.now() + 5_000 })
  return branch
}

interface GhPullRequest {
  number: number
  title: string
  url: string
  state: string
  headRefName: string
  additions?: number
  deletions?: number
  createdAt?: string
  updatedAt?: string
  closedAt?: string | null
  mergedAt?: string | null
}

export async function discoverPullRequests(directory: string, projectID: string, limit = 100): Promise<PullRequestRecord[]> {
  const fields = "number,title,url,state,headRefName,additions,deletions,createdAt,updatedAt,closedAt,mergedAt"
  const output = await run(
    "gh",
    ["pr", "list", "--state", "all", "--limit", String(Math.max(1, Math.min(limit, 1000))), "--json", fields],
    directory,
    45_000,
  )
  const pulls = JSON.parse(output) as GhPullRequest[]
  return pulls.map((pr) => ({
    key: prKey(projectID, pr.number),
    projectID,
    directory,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state.toLowerCase(),
    branch: pr.headRefName,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt ?? undefined,
    mergedAt: pr.mergedAt ?? undefined,
  }))
}

export async function turnDiff(directory: string, sessionID: string, turnID: string, opencode = "opencode"): Promise<FileLineChange[]> {
  const path = `/api/session/${encodeURIComponent(sessionID)}/diff?from=${encodeURIComponent(turnID)}&context=0`
  const output = await run(opencode, ["api", "get", path], directory, 45_000)
  const response = JSON.parse(output) as { data?: Array<{ file: string; additions: number; deletions: number }> }
  return (response.data ?? []).map((file) => ({
    file: file.file,
    additions: file.additions,
    deletions: file.deletions,
  }))
}

export async function hasCommand(command: string): Promise<boolean> {
  try {
    await run(command, ["--version"], undefined, 5_000)
    return true
  } catch {
    return false
  }
}
