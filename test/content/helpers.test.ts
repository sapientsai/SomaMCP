import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { audioContent, imageContent } from "../../src/content/helpers.js"
import * as nodeContent from "../../src/node/content.js"

const bytes = (length: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, i) => (i * 7 + 3) % 256)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("content helpers (main entry)", () => {
  // Past one 0x8000-byte slice, so the chunked conversion is exercised.
  it.each([0, 1, 2, 3, 100, 0x8000, 0x8000 + 1, 100_000])("base64-encodes %i bytes as Buffer does", async (n) => {
    const data = bytes(n)
    const image = await imageContent({ buffer: data })
    expect(image.data).toBe(Buffer.from(data).toString("base64"))
  })

  it("accepts a Node Buffer, which is a Uint8Array", async () => {
    const image = await imageContent({ buffer: Buffer.from("hi") })
    expect(image).toEqual({ data: "aGk=", mimeType: "image/png", type: "image" })
  })

  it("falls back to image/png and audio/mpeg for raw bytes", async () => {
    expect((await imageContent({ buffer: bytes(4) })).mimeType).toBe("image/png")
    expect((await audioContent({ buffer: bytes(4) })).mimeType).toBe("audio/mpeg")
  })

  it("fetches a URL and picks the MIME type from its path, ignoring the query", async () => {
    const fetchMock = vi.fn(async () => new Response(bytes(8)))
    vi.stubGlobal("fetch", fetchMock)
    const image = await imageContent({ url: "https://cdn.example/a/photo.WEBP?size=2" })
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example/a/photo.WEBP?size=2")
    expect(image.mimeType).toBe("image/webp")
    expect(image.data).toBe(Buffer.from(bytes(8)).toString("base64"))
    expect((await audioContent({ url: "https://cdn.example/clip.flac" })).mimeType).toBe("audio/flac")
  })

  it("does not take a dotfile's name as its extension", async () => {
    vi.stubGlobal("fetch", async () => new Response(bytes(1)))
    expect((await imageContent({ url: "https://cdn.example/.png" })).mimeType).toBe("image/png")
    expect((await audioContent({ url: "https://cdn.example/.wav" })).mimeType).toBe("audio/mpeg")
  })

  it("rejects when the fetch fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404, statusText: "Not Found" }))
    await expect(imageContent({ url: "https://cdn.example/x.png" })).rejects.toThrow("404 Not Found")
  })
})

describe("content helpers (somamcp/node)", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true })))
  })

  it("reads a path and picks the MIME type from its extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "soma-content-"))
    dirs.push(dir)
    const file = join(dir, "clip.ogg")
    await writeFile(file, bytes(10))
    expect(await nodeContent.audioContent({ path: file })).toEqual({
      data: Buffer.from(bytes(10)).toString("base64"),
      mimeType: "audio/ogg",
      type: "audio",
    })
  })

  it("passes bytes and URLs through to the main entry's helpers", async () => {
    expect(await nodeContent.imageContent({ buffer: Buffer.from("hi") })).toEqual(
      await imageContent({ buffer: Buffer.from("hi") }),
    )
  })
})
