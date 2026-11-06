import { Option } from "functype"

import type { TraceContext } from "../types/tracing.js"

export type Traceparent = {
  readonly flags: number
  readonly spanId: string
  readonly traceId: string
}

// A later version may append fields, so only version 00 has to end after the flags.
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-[\x20-\x7e]*)?$/
// Printable ASCII, so a value can't carry a line break into a log.
const PRINTABLE = /^[\x20-\x7e]+$/
const MAX_TRACEPARENT_LENGTH = 256
// The W3C limit a vendor must be able to pass along; anything longer may be dropped.
const MAX_TRACESTATE_LENGTH = 512

const isAllZeros = (hex: string): boolean => /^0+$/.test(hex)

/** The fields of a W3C `traceparent`, when it is valid: the spec's versions and non-zero ids. */
export const parseTraceparent = (value: unknown): Option<Traceparent> =>
  Option(typeof value === "string" && value.length <= MAX_TRACEPARENT_LENGTH ? TRACEPARENT.exec(value) : undefined)
    .filter(([, version, , , , rest]) => version !== "ff" && !(version === "00" && Boolean(rest)))
    .filter(([, , traceId = "", spanId = ""]) => !isAllZeros(traceId) && !isAllZeros(spanId))
    .map(([, , traceId = "", spanId = "", flags = "00"]) => ({ flags: parseInt(flags, 16), spanId, traceId }))

const readTracestate = (value: unknown): Option<string> =>
  Option(typeof value === "string" ? value : undefined).filter(
    (state) => state.length <= MAX_TRACESTATE_LENGTH && PRINTABLE.test(state),
  )

/**
 * Trace context from what a client sent. It arrives unchecked and may be forwarded to other
 * servers, so a bad `traceparent` drops the whole context, as the W3C spec says to, and a bad
 * `tracestate` drops only itself.
 */
export const readTraceContext = (traceparent: unknown, tracestate: unknown): Option<TraceContext> =>
  parseTraceparent(traceparent).map((): TraceContext => ({
    traceparent: traceparent as string,
    ...readTracestate(tracestate).fold(
      () => ({}),
      (state) => ({ tracestate: state }),
    ),
  }))
