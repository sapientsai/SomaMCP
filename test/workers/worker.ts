// A Worker built from the main entry, for workerd.test.ts. It touches what a real
// server does on Workers: auth, schemas, content helpers, errors, resources, the
// info tool, and the health route.
import { z } from "zod"

import { createServer, getRequestHeader, imageContent, UserError } from "../../src/index.js"

const server = createServer<{ user: string }>({
  authenticate: (request) =>
    getRequestHeader(request, "x-api-key") === "k" ? Promise.resolve({ user: "u" }) : Promise.reject(new Error("no")),
  enableDashboard: false,
  name: "worker",
  version: "1.0.0",
})

server.addTool({
  description: "Echo",
  execute: async ({ text }) => `echo: ${text}`,
  name: "echo",
  parameters: z.object({ text: z.string() }),
})

server.addTool({
  description: "Text and an inline image, encoded without Buffer",
  execute: async () => ({
    content: [{ text: "pixel", type: "text" as const }, await imageContent({ buffer: new Uint8Array([1, 2, 3]) })],
  }),
  name: "pixel",
})

server.addTool({
  description: "Always fails",
  execute: () => Promise.reject(new UserError("nope")),
  name: "fail",
})

server.addTool({
  description: "Who am I",
  execute: async (_args, context) => `user: ${context.session?.user ?? "none"}`,
  name: "whoami",
})

server.addResource({
  load: async () => ({ text: "hello from workerd" }),
  mimeType: "text/plain",
  name: "memo",
  uri: "memo://a",
})

export default { fetch: (request: Request): Promise<Response> => server.fetch(request) }
