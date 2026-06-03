import { describe, expect, it, vi } from "vitest"

import { createDefaultLogger } from "../src/logging.js"

describe("createDefaultLogger", () => {
  it("routes info logs to stderr, never stdout (JSON-RPC channel on stdio)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    createDefaultLogger("test-cell").info("hello")

    expect(errorSpy).toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()

    errorSpy.mockRestore()
    infoSpy.mockRestore()
    logSpy.mockRestore()
  })
})
