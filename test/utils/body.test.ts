import { describe, expect, it } from "vitest"

import { readBoundedText } from "../../src/utils/body.js"

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)))
      controller.close()
    },
  })

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://body.test/", { body, duplex: "half", headers, method: "POST" } as RequestInit)

describe("readBoundedText", () => {
  it("reads a body within the limit, across chunks", async () => {
    expect((await readBoundedText(post(streamOf("ab", "cd")), 4)).orUndefined()).toBe("abcd")
  })

  it("reads no body as empty", async () => {
    expect((await readBoundedText(new Request("http://body.test/"), 4)).orUndefined()).toBe("")
  })

  it("stops once the streamed body passes the limit", async () => {
    expect((await readBoundedText(post(streamOf("abc", "de")), 4)).isNone()).toBe(true)
  })

  it("refuses a declared Content-Length over the limit without reading", async () => {
    const request = post("tiny", { "content-length": "100" })
    expect((await readBoundedText(request, 4)).isNone()).toBe(true)
    expect(request.bodyUsed).toBe(false)
  })

  it("answers none for a body that was already read", async () => {
    const request = post("used")
    await request.text()
    expect((await readBoundedText(request, 16)).isNone()).toBe(true)
  })

  it("answers none for a stream that errors", async () => {
    const failing = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("boom")) })
    expect((await readBoundedText(post(failing), 16)).isNone()).toBe(true)
  })
})
