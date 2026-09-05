import { beforeEach, describe, expect, it, vi } from "vitest"

// Capture what the adapter hands FastMCP's constructor. The adapter does not expose the server
// it builds, and replicating the spread inside the test would assert fastmcp's behaviour rather
// than somamcp's passthrough — such a test still passes with the passthrough deleted.
const constructed: Array<Record<string, unknown>> = []

vi.mock("fastmcp", () => ({
  FastMCP: class {
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      this.options = options
      constructed.push(options)
    }
    get serverState() {
      return "stopped"
    }
    get sessions() {
      return []
    }
    addPrompt() {}
    addResource() {}
    addResourceTemplate() {}
    addTool() {}
    on() {}
    start() {
      return Promise.resolve()
    }
    stop() {
      return Promise.resolve()
    }
  },
}))

const { createFastMCPBackend } = await import("../../src/backend/fastmcp")

// streamKeepalive is the only keepalive that survives httpStream.stateless: a transport-level
// ping needs the standing server-to-client stream, and stateless has none. Before this was
// typed it reached fastmcp only through the untyped `backendOptions` hatch, which is how a
// stateless deployment ends up without the one keepalive it can actually use.
describe("streamKeepalive passthrough", () => {
  beforeEach(() => {
    constructed.length = 0
  })

  it("reaches the fastmcp constructor when set on ServerConfig", () => {
    createFastMCPBackend({
      name: "probe",
      streamKeepalive: { enabled: true, intervalMs: 15_000 },
      version: "1.0.0",
    })

    expect(constructed[0]?.streamKeepalive).toEqual({ enabled: true, intervalMs: 15_000 })
  })

  // Absent rather than present-and-undefined: fastmcp reads its own default from a missing key.
  it("is omitted entirely when not configured, so fastmcp keeps its own default", () => {
    createFastMCPBackend({ name: "probe", version: "1.0.0" })

    expect(constructed[0]).not.toHaveProperty("streamKeepalive")
  })

  // The field is intervalMs. fastmcp ignores an unknown key silently and falls back to its 20s
  // default, so `interval` buys a keepalive at the wrong gap with no error anywhere — the same
  // silent-config-ignored failure this passthrough exists to prevent.
  it("carries intervalMs through unchanged, since that is the name fastmcp reads", () => {
    createFastMCPBackend({
      name: "probe",
      streamKeepalive: { enabled: true, intervalMs: 45_000 },
      version: "1.0.0",
    })

    const keepalive = constructed[0]?.streamKeepalive as { intervalMs?: number } | undefined
    expect(keepalive?.intervalMs).toBe(45_000)
  })

  // backendOptions stays usable for fastmcp options somamcp does not model, and naming this one
  // must not have closed that door.
  it("leaves the untyped backendOptions hatch working alongside it", () => {
    createFastMCPBackend({ name: "probe", version: "1.0.0" }, { ping: { enabled: false } })

    expect(constructed[0]?.ping).toEqual({ enabled: false })
  })
})
