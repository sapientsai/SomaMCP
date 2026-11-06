import { describe, expect, it } from "vitest"

import { parseTraceparent, readTraceContext } from "../../src/telemetry/traceContext.js"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const SPAN_ID = "00f067aa0ba902b7"
const VALID = `00-${TRACE_ID}-${SPAN_ID}-01`

describe("parseTraceparent", () => {
  it("reads the ids and flags of a valid value", () => {
    expect(parseTraceparent(VALID).orUndefined()).toEqual({ flags: 1, spanId: SPAN_ID, traceId: TRACE_ID })
  })

  it("accepts a later version's extra fields", () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-00-extra`).isSome()).toBe(true)
  })

  it.each([
    ["not a string", 42],
    ["missing", undefined],
    ["empty", ""],
    ["wrong shape", "00-abc-def-01"],
    ["uppercase hex", VALID.toUpperCase()],
    ["version ff", `ff-${TRACE_ID}-${SPAN_ID}-01`],
    ["version 00 with extra fields", `${VALID}-extra`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${SPAN_ID}-01`],
    ["an all-zero span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["a line break in the extra fields", `01-${TRACE_ID}-${SPAN_ID}-00-a\nb`],
    ["longer than the limit", `01-${TRACE_ID}-${SPAN_ID}-00-${"a".repeat(300)}`],
  ])("rejects %s", (_label, value) => {
    expect(parseTraceparent(value).isEmpty).toBe(true)
  })
})

describe("readTraceContext", () => {
  it("keeps both values when both are valid", () => {
    expect(readTraceContext(VALID, "vendor=1").orUndefined()).toEqual({ traceparent: VALID, tracestate: "vendor=1" })
  })

  it("drops everything when traceparent is bad", () => {
    expect(readTraceContext("nope", "vendor=1").isEmpty).toBe(true)
  })

  it.each([
    ["not a string", 42],
    ["empty", ""],
    ["over 512 characters", "a".repeat(513)],
    ["carrying a line break", "vendor=1\ninjected=2"],
  ])("keeps traceparent but drops a tracestate that is %s", (_label, tracestate) => {
    expect(readTraceContext(VALID, tracestate).orUndefined()).toEqual({ traceparent: VALID })
  })
})
