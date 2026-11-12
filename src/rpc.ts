import { Rpc } from "@opencode/plugin/rpc"

const object = { type: "object", additionalProperties: true } as const
const empty = { type: "object", additionalProperties: false } as const

export const MetricsRpc = Rpc.define({
  id: "opencode-metrics",
  methods: {
    report: {
      input: {
        type: "object",
        properties: {
          from: { type: "number" },
          to: { type: "number" },
          projectID: { type: "string" },
        },
        additionalProperties: false,
      },
      output: object,
    },
    sync: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          all: { type: "boolean" },
          diffs: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: object,
    },
    discover: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          sessionID: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      output: object,
    },
    assign: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          number: { anyOf: [{ type: "number" }, { type: "null" }] },
        },
        required: ["sessionID", "number"],
        additionalProperties: false,
      },
      output: object,
    },
    export: {
      input: empty,
      output: object,
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
})
