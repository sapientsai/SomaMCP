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
})
