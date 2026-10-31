import { describe, expect, it } from "vitest"
import { z } from "zod"

import { classifyError, createEnrichedError } from "../../src/telemetry/EnrichedError.js"
import { UserError } from "../../src/types/core.js"

describe("EnrichedError", () => {
  describe("classifyError", () => {
    it("classifies validation errors", () => {
      expect(classifyError(new Error("invalid input format"))).toBe("validation")
      expect(classifyError(new Error("schema validation failed"))).toBe("validation")
    })

    it("classifies timeout errors", () => {
      expect(classifyError(new Error("request timed out"))).toBe("timeout")
      expect(classifyError(new Error("ETIMEDOUT"))).toBe("timeout")
    })

    it("classifies gateway errors", () => {
      expect(classifyError(new Error("ECONNREFUSED"))).toBe("gateway")
      expect(classifyError(new Error("gateway not connected"))).toBe("gateway")
    })

    it("classifies auth errors", () => {
      expect(classifyError(new Error("unauthorized"))).toBe("auth")
      expect(classifyError(new Error("forbidden resource"))).toBe("auth")
    })

    it("classifies not_found errors", () => {
      expect(classifyError(new Error("resource not found"))).toBe("not_found")
      expect(classifyError(new Error("404"))).toBe("not_found")
    })

    it("labels a UserError with no category execution, whatever its message says", () => {
      // A tool passing on a remote command's output: the words are not the tool's own.
      expect(classifyError(new UserError("bash: chezmoi: command not found"))).toBe("execution")
      expect(classifyError(new UserError("invalid option -- 'z'"))).toBe("execution")
      expect(classifyError(new UserError("Permission denied (publickey)"))).toBe("execution")
      expect(classifyError({ message: "bad input", name: "UserError" })).toBe("execution")
    })

    it("labels a UserError with the category it carries", () => {
      expect(classifyError(new UserError("no such list", { category: "not_found" }))).toBe("not_found")
      expect(classifyError(new UserError("listId is required", { category: "validation" }))).toBe("validation")
      // From another copy of somamcp, or built by hand: read by name and shape.
      expect(classifyError({ category: "timeout", message: "slow", name: "UserError" })).toBe("timeout")
      expect(classifyError({ category: "bogus", message: "x", name: "UserError" })).toBe("execution")
    })

    it("labels a schema library's error validation, by its issues rather than its words", () => {
      const parsed = z.object({ n: z.number() }).safeParse({ n: "x" })
      expect(parsed.success).toBe(false)
      expect(classifyError(parsed.error)).toBe("validation")
      expect(classifyError({ issues: [{ message: "Expected number" }], message: "Oops", name: "ValiError" })).toBe(
        "validation",
      )
    })

    it("defaults to internal for unknown errors", () => {
      expect(classifyError(new Error("something went wrong"))).toBe("internal")
      expect(classifyError("string error")).toBe("internal")
    })
  })

  describe("createEnrichedError", () => {
    it("returns enriched response with category and suggestions", () => {
      const result = createEnrichedError(new Error("connection refused"))
      expect(result.errorCategory).toBe("gateway")
      expect(result.message).toBe("connection refused")
      expect(result.suggestions).toBeDefined()
      expect(result.suggestions!.length).toBeGreaterThan(0)
    })

    it("includes gateway status in relatedState", () => {
      const result = createEnrichedError(new Error("not connected"), {
        gatewayStatus: "error",
        toolName: "remote_search",
      })
      expect(result.relatedState).toEqual({
        gatewayStatus: "error",
        toolName: "remote_search",
      })
    })

    it("omits relatedState when no context provided", () => {
      const result = createEnrichedError(new Error("boom"))
      expect(result.relatedState).toBeUndefined()
    })

    it("gives a UserError with no category no suggestions", () => {
      const result = createEnrichedError(new UserError("remote command failed: exit 2"))
      expect(result).toEqual({ errorCategory: "execution", message: "remote command failed: exit 2" })
    })

    it("gives a UserError's own suggestions, or the category's when it brings none, or none for []", () => {
      expect(createEnrichedError(new UserError("x", { suggestions: ["Run `login` first"] })).suggestions).toEqual([
        "Run `login` first",
      ])
      expect(createEnrichedError(new UserError("x", { category: "not_found" })).suggestions).toEqual([
        "The requested resource was not found. Verify the identifier",
      ])
      expect(createEnrichedError(new UserError("x", { category: "not_found", suggestions: [] }))).toEqual({
        errorCategory: "not_found",
        message: "x",
      })
    })

    it("handles non-Error values", () => {
      const result = createEnrichedError("string error")
      expect(result.message).toBe("string error")
      expect(result.errorCategory).toBe("internal")
    })
  })
})
