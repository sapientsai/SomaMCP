import { createServer } from "somamcp/node"
import { z } from "zod"

const formatInZone = (date: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`
}

const server = createServer({
  name: "time-server",
  version: "0.0.0",
  instructions: "Provides current-time and timezone-conversion tools.",
})

server.addTool({
  name: "get_current_time",
  description: "Return the current time, optionally formatted for a specific IANA timezone.",
  parameters: z.object({
    timezone: z.string().optional().describe("IANA timezone identifier, e.g. 'America/New_York'. Defaults to UTC."),
  }),
  execute: async ({ timezone }) => {
    const now = new Date()
    const zone = timezone ?? "UTC"
    return JSON.stringify({
      epochMs: now.getTime(),
      iso: now.toISOString(),
      local: formatInZone(now, zone),
      timezone: zone,
    })
  },
})

server.addTool({
  name: "convert_timezone",
  description: "Convert an ISO timestamp from one timezone to another.",
  parameters: z.object({
    isoTimestamp: z.string().describe("ISO-8601 timestamp to convert."),
    targetTimezone: z.string().describe("IANA timezone identifier to render in."),
  }),
  execute: async ({ isoTimestamp, targetTimezone }) => {
    const date = new Date(isoTimestamp)
    if (Number.isNaN(date.getTime())) {
      return {
        content: [{ type: "text" as const, text: `Invalid ISO timestamp: ${isoTimestamp}` }],
        isError: true,
      }
    }
    return JSON.stringify({
      input: isoTimestamp,
      targetTimezone,
      rendered: formatInZone(date, targetTimezone),
    })
  },
})

const useStdio = process.argv.includes("--stdio")
const port = Number(process.env.PORT ?? 3333)

if (useStdio) {
  await server.start({ transportType: "stdio" })
} else {
  await server.start({
    transportType: "httpStream",
    httpStream: { port, endpoint: "/mcp" },
  })
  console.log(`time-server listening on http://localhost:${port}/mcp (dashboard: /dashboard)`)
}

const shutdown = async () => {
  await server.stop()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
