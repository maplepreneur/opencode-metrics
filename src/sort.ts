export interface SortSelection {
  key: string
  direction: "asc" | "desc"
}

const TEXT_COLUMNS = new Set(["name", "date", "title", "branch", "attribution"])

export function nextSort(current: SortSelection | undefined, key: string): SortSelection {
  if (current?.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" }
  return { key, direction: TEXT_COLUMNS.has(key) ? "asc" : "desc" }
}

export function sortRows<Row>(
  rows: readonly Row[],
  selection: SortSelection | undefined,
  value: (row: Row, key: string) => string | number | null,
): Row[] {
  if (!selection) return [...rows]
  return [...rows].sort((left, right) => {
    const a = value(left, selection.key)
    const b = value(right, selection.key)
    if (a === b) return 0
    // Missing ratios remain at the bottom in both directions.
    if (a === null || a === undefined) return 1
    if (b === null || b === undefined) return -1
    const compared = typeof a === "string" ? a.localeCompare(String(b)) : a - Number(b)
    return selection.direction === "asc" ? compared : -compared
  })
}
