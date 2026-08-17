import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getRuntimeInfo, readBuildInfoFromEnv, resolveBuildInfo } from "../src/buildInfo.js"

describe("buildInfo", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.SOMAMCP_BUILD_COMMIT
    delete process.env.SOMAMCP_BUILD_DATE
    delete process.env.SOMAMCP_BUILD_BRANCH
    delete process.env.SOMAMCP_ENVIRONMENT
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("returns undefined fields when env vars are not set", () => {
    const info = readBuildInfoFromEnv()
    expect(info.commit).toBeUndefined()
    expect(info.date).toBeUndefined()
    expect(info.branch).toBeUndefined()
    expect(info.environment).toBeUndefined()
  })

  it("reads SOMAMCP_BUILD_* env vars", () => {
    process.env.SOMAMCP_BUILD_COMMIT = "abc123"
    process.env.SOMAMCP_BUILD_DATE = "2026-05-22T00:00:00Z"
    process.env.SOMAMCP_BUILD_BRANCH = "main"
    process.env.SOMAMCP_ENVIRONMENT = "prod"

    const info = readBuildInfoFromEnv()
    expect(info.commit).toBe("abc123")
    expect(info.date).toBe("2026-05-22T00:00:00Z")
    expect(info.branch).toBe("main")
    expect(info.environment).toBe("prod")
  })

  it("treats empty strings as undefined", () => {
    process.env.SOMAMCP_BUILD_COMMIT = ""
    const info = readBuildInfoFromEnv()
    expect(info.commit).toBeUndefined()
  })

  it("programmatic override takes precedence over env vars", () => {
    process.env.SOMAMCP_BUILD_COMMIT = "from-env"
    const resolved = resolveBuildInfo({ commit: "from-override" })
    expect(resolved.commit).toBe("from-override")
  })

  it("falls back to env when override field is undefined", () => {
    process.env.SOMAMCP_BUILD_COMMIT = "from-env"
    const resolved = resolveBuildInfo({ branch: "feature" })
    expect(resolved.commit).toBe("from-env")
    expect(resolved.branch).toBe("feature")
  })
})

describe("getRuntimeInfo", () => {
  it("reports node when the process global is present", () => {
    const info = getRuntimeInfo()
    expect(info.runtime).toBe("node")
    expect(info.nodeVersion).toBe(process.version)
  })

  it("reports edge without throwing when there is no process global", () => {
    const original = globalThis.process
    // Edge runtimes (Workers without nodejs_compat) have no `process` at all —
    // touching it unguarded would throw on every createServer call.
    // @ts-expect-error deliberately removing a global to simulate an edge runtime
    delete globalThis.process
    try {
      const info = getRuntimeInfo()
      expect(info.runtime).toBe("edge")
      expect(info.nodeVersion).toBe("unknown")
      expect(() => readBuildInfoFromEnv()).not.toThrow()
    } finally {
      globalThis.process = original
    }
  })

  /**
   * Swap in a fake global for the duration of a callback.
   *
   * Uses defineProperty rather than assignment: `navigator` is an accessor with
   * only a getter on Node 22+, so `globalThis.navigator = x` throws.
   */
  const withGlobal = (key: string, value: unknown, run: () => void): void => {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true })
    try {
      run()
    } finally {
      if (original) Object.defineProperty(globalThis, key, original)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }

  it("reports edge on Cloudflare Workers even though nodejs_compat provides process", () => {
    // The 1.2.0 regression: Workers with nodejs_compat supplies a real
    // process.versions.node (v22.x), so a process-first check called it "node".
    // Production /info returned runtime "node", nodeVersion "v22.19.0".
    expect(process.versions.node).toBeDefined()

    withGlobal("navigator", { userAgent: "Cloudflare-Workers" }, () => {
      const info = getRuntimeInfo()
      expect(info.runtime).toBe("edge")
      // Node fields describe the compat shim, not the runtime — report unknown.
      expect(info.nodeVersion).toBe("unknown")
      expect(info.arch).toBe("unknown")
      expect(info.platform).toBe("Cloudflare-Workers")
    })
  })

  it("reports edge on Deno", () => {
    withGlobal("Deno", { version: { deno: "2.0.0" } }, () => {
      expect(getRuntimeInfo().runtime).toBe("edge")
    })
  })

  it("reports edge on Vercel Edge", () => {
    withGlobal("EdgeRuntime", "vercel", () => {
      expect(getRuntimeInfo().runtime).toBe("edge")
    })
  })

  it("still reports node for an unrelated navigator user agent", () => {
    // A browser-ish UA must not be mistaken for an edge runtime.
    withGlobal("navigator", { userAgent: "Mozilla/5.0" }, () => {
      expect(getRuntimeInfo().runtime).toBe("node")
    })
  })

  it("still reports node when navigator exists without a userAgent", () => {
    withGlobal("navigator", {}, () => {
      expect(getRuntimeInfo().runtime).toBe("node")
    })
  })
})
