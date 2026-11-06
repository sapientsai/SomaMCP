// somamcp/otel inside workerd with no nodejs_compat: @opentelemetry/api has to load, and a
// tool has to be able to nest under its span, since Workers have no context manager there.
import type { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { connectModern } from "../backend/sdk-clients.js"
import { bundleWorker, startWorkerd, workerFetchable } from "./harness.js"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const CLIENT_SPAN = "00f067aa0ba902b7"

const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]?.text ?? ""

let script = ""
let mf: Miniflare

beforeAll(async () => {
  script = await bundleWorker("./otel-worker.ts")
  mf = await startWorkerd(script)
}, 120_000)

afterAll(async () => {
  await mf?.dispose()
})

describe("somamcp/otel in workerd (no nodejs_compat)", () => {
  it("bundles with no Node built-ins", () => {
    expect(script.length).toBeGreaterThan(0)
    expect(script).not.toMatch(/from\s*["']node:/)
  })

  it("opens spans, carries trace context, and nests by hand", async () => {
    const client = await connectModern(workerFetchable(mf))
    const seen = await client.callTool({
      _meta: { traceparent: `00-${TRACE_ID}-${CLIENT_SPAN}-01`, tracestate: "vendor=1" },
      arguments: {},
      name: "trace",
    })
    await client.callTool({ arguments: {}, name: "fail" })
    const spans = JSON.parse(textOf(await client.callTool({ arguments: {}, name: "spans" }))) as Array<{
      errorType?: string
      name: string
      parent?: { spanId: string; traceId: string }
    }>
    await client.close()

    const toolSpanId = JSON.parse(textOf(seen)).traceparent.split("-")[2]
    expect(JSON.parse(textOf(seen)).traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`))
    expect(toolSpanId).not.toBe(CLIENT_SPAN)

    const call = spans.find((s) => s.name === "tools/call trace")
    expect(call?.parent).toMatchObject({ spanId: CLIENT_SPAN, traceId: TRACE_ID })
    expect(spans.find((s) => s.name === "explicit")?.parent).toMatchObject({ spanId: toolSpanId, traceId: TRACE_ID })
    expect(spans.find((s) => s.name === "tools/call fail")?.errorType).toBe("tool_error")
  })
})
