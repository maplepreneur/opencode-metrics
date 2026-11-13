import test from "node:test"
import assert from "node:assert/strict"
import { nextSort, sortRows } from "../dist/sort.js"

const rows = [
  { name: "Beta", cost: 2, ratio: null },
  { name: "Alpha", cost: 10, ratio: 0.5 },
  { name: "Gamma", cost: 1, ratio: 0.1 },
]

test("numeric columns sort in both directions", () => {
  assert.deepEqual(sortRows(rows, { key: "cost", direction: "desc" }, (row) => row.cost).map((row) => row.name), ["Alpha", "Beta", "Gamma"])
  assert.deepEqual(sortRows(rows, { key: "cost", direction: "asc" }, (row) => row.cost).map((row) => row.name), ["Gamma", "Beta", "Alpha"])
})

test("text columns sort alphabetically and missing ratios remain last", () => {
  assert.deepEqual(sortRows(rows, { key: "name", direction: "asc" }, (row) => row.name).map((row) => row.name), ["Alpha", "Beta", "Gamma"])
  assert.deepEqual(sortRows(rows, { key: "ratio", direction: "asc" }, (row) => row.ratio).map((row) => row.name), ["Gamma", "Alpha", "Beta"])
  assert.deepEqual(sortRows(rows, { key: "ratio", direction: "desc" }, (row) => row.ratio).map((row) => row.name), ["Alpha", "Gamma", "Beta"])
})

test("header clicks choose sensible defaults and toggle direction", () => {
  assert.deepEqual(nextSort(undefined, "cost"), { key: "cost", direction: "desc" })
  assert.deepEqual(nextSort(undefined, "name"), { key: "name", direction: "asc" })
  assert.deepEqual(nextSort({ key: "cost", direction: "desc" }, "cost"), { key: "cost", direction: "asc" })
  assert.deepEqual(nextSort({ key: "cost", direction: "asc" }, "name"), { key: "name", direction: "asc" })
})
