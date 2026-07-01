import { createServer, getRequestHeader, imageContent } from "somamcp"
import { z } from "zod"

/**
 * Example: httpStream + `authenticate` + `addRoute` (protected POST) + a tool
 * that returns a content-array (text + inline image).
 *
 * Doubles as the make-or-break fixture that ships alongside 1.1.0 — proves
 * `addRoute`, `getRequestHeader`, and content-array returns compose cleanly.
 *
 * Run:
 *
 *   API_KEY=dev-secret pnpm dev
 *   curl -H "Authorization: Bearer dev-secret" -F file=@./pixel.png http://localhost:3333/upload
 *
 * Reject an unauthorized call:
 *
 *   curl -i http://localhost:3333/upload -X POST -d 'hi'
 *   # → 401 { "error": "Unauthorized" }
 */

const API_KEY = process.env.API_KEY ?? "dev-secret"

const server = createServer({
  name: "protected-upload-server",
  version: "0.0.0",
  instructions: "Demo server: a protected POST /upload route + a tool that returns text + image.",

  // authenticate runs on both the MCP transport and any addRoute({ protected: true })
  // route. It receives either a Hono Request (protected routes) or an
  // http.IncomingMessage (MCP transport) — getRequestHeader hides the shape difference.
  authenticate: async (request) => {
    const header = getRequestHeader(request, "authorization")
    const token = header?.startsWith("Bearer ") ? header.slice(7) : header
    if (token !== API_KEY) {
      throw new Error("invalid api key")
    }
    return { role: "uploader" }
  },
})

// A protected POST route. Auth runs before the handler; a throw from
// `authenticate` short-circuits to onUnauthorized (default 401).
server.addRoute({
  method: ["POST", "PUT"],
  path: "/upload",
  protected: true,
  onUnauthorized: (c) =>
    c.json({ error: "unauthorized", hint: "provide `Authorization: Bearer <API_KEY>`" }, 401, {
      "WWW-Authenticate": "Bearer",
    }),
  handler: async (c) => {
    const contentType = c.req.header("content-type") ?? "application/octet-stream"
    const body = await c.req.arrayBuffer()
    return c.json({
      bytes: body.byteLength,
      contentType,
      status: "accepted",
    })
  },
})

// A tool that returns a content-array (text + inline image) — proves that the
// telemetry wrapper passes multimodal returns straight through to the backend.
server.addTool({
  name: "hello_pixel",
  description: "Return a greeting plus a 1x1 transparent PNG. Demonstrates content-array returns.",
  parameters: z.object({
    name: z.string().default("world"),
  }),
  execute: async ({ name }) => {
    // 1x1 transparent PNG
    const image = await imageContent({
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
        "base64",
      ),
    })
    return {
      content: [{ type: "text" as const, text: `hello, ${name}` }, image],
    }
  },
})

const isStdio = process.argv.includes("--stdio")

await server.start(
  isStdio
    ? { transportType: "stdio" }
    : {
        transportType: "httpStream",
        httpStream: {
          port: Number(process.env.PORT ?? 3333),
          host: process.env.HOST ?? "127.0.0.1",
          endpoint: "/mcp",
        },
      },
)

if (!isStdio) {
  // Not the MCP transport itself, but useful signal for humans running this locally.
  console.error(`protected-upload-server listening on http://127.0.0.1:${process.env.PORT ?? 3333}`)
  console.error(`  MCP endpoint : /mcp`)
  console.error(`  Upload       : POST /upload   (Bearer ${API_KEY})`)
  console.error(`  Dashboard    : /dashboard`)
}
