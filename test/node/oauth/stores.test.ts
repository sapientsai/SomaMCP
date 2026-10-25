import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDiskStore } from "../../../src/node/oauth/stores/disk.js"
import { createEncryptedStore, isEncryptedStore } from "../../../src/node/oauth/stores/encrypted.js"
import { createMemoryStore } from "../../../src/node/oauth/stores/memory.js"
import type { TokenStore } from "../../../src/node/oauth/stores/types.js"

const opened: TokenStore[] = []
const track = <S extends TokenStore>(store: S): S => {
  opened.push(store)
  return store
}
afterEach(() => {
  opened.splice(0).forEach((s) => s.close?.())
  vi.useRealTimers()
})

/** What every store must do, whatever it keeps its data in. */
const behavesLikeAStore = (name: string, make: () => Promise<TokenStore>, { atomicTake = true } = {}) => {
  describe(`${name}: the TokenStore contract`, () => {
    it("reads back what it saved, objects included", async () => {
      const store = await make()
      await store.save("a", { nested: { list: [1, "two"] }, when: "2026-10-25T00:00:00.000Z" })
      await store.save("b", "text")
      await store.save("c", 42)
      expect(await store.get("a")).toEqual({ nested: { list: [1, "two"] }, when: "2026-10-25T00:00:00.000Z" })
      expect(await store.get("b")).toBe("text")
      expect(await store.get("c")).toBe(42)
    })

    it("answers undefined for a key it never saw", async () => {
      expect(await (await make()).get("nothing")).toBeUndefined()
    })

    it("forgets a deleted key, and deleting a missing key is fine", async () => {
      const store = await make()
      await store.save("k", 1)
      await store.delete("k")
      await store.delete("never-there")
      expect(await store.get("k")).toBeUndefined()
    })

    it("lets an entry lapse after its ttl, and keeps one without a ttl", async () => {
      vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] })
      const store = await make()
      await store.save("short", "x", 10)
      await store.save("forever", "y")
      vi.setSystemTime(1_000_000 + 9_000)
      expect(await store.get("short")).toBe("x")
      vi.setSystemTime(1_000_000 + 11_000)
      expect(await store.get("short")).toBeUndefined()
      vi.setSystemTime(1_000_000 + 10 * 365 * 24 * 3600 * 1000)
      expect(await store.get("forever")).toBe("y")
    })

    it("cleanup drops what has lapsed and keeps the rest", async () => {
      vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] })
      const store = await make()
      await store.save("lapsing", 1, 1)
      await store.save("staying", 2, 3600)
      vi.setSystemTime(1_000_000 + 5_000)
      await store.cleanup()
      expect(await store.get("staying")).toBe(2)
      expect(await store.get("lapsing")).toBeUndefined()
    })

    describe("take", () => {
      it("hands back the value and removes it", async () => {
        const store = await make()
        await store.save("code", { v: 1 })
        expect(await store.take?.("code")).toEqual({ v: 1 })
        expect(await store.get("code")).toBeUndefined()
        expect(await store.take?.("code")).toBeUndefined()
      })

      it("answers undefined for a lapsed entry", async () => {
        vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] })
        const store = await make()
        await store.save("code", 1, 1)
        vi.setSystemTime(1_000_000 + 2_000)
        expect(await store.take?.("code")).toBeUndefined()
      })

      // A store without an atomic take falls back to get-then-delete, which can race; the docs say so.
      it.runIf(atomicTake)("gives a value to exactly one of many callers racing for it", async () => {
        const store = await make()
        await store.save("code", "only-once")
        const results = await Promise.all(Array.from({ length: 12 }, () => store.take?.("code")))
        expect(results.filter((r) => r === "only-once")).toHaveLength(1)
      })
    })
  })
}

behavesLikeAStore("memory", () => Promise.resolve(track(createMemoryStore())))

describe("the disk store", () => {
  const state = { directory: "" }
  beforeEach(async () => {
    state.directory = await mkdtemp(join(tmpdir(), "somamcp-disk-"))
  })
  afterEach(async () => {
    await rm(state.directory, { force: true, recursive: true })
  })

  behavesLikeAStore("disk", () => Promise.resolve(track(createDiskStore({ directory: state.directory }))))
  behavesLikeAStore("disk, two instances on one directory", async (): Promise<TokenStore> => {
    // A save through one instance must be visible through another, as for two processes.
    const writer = track(createDiskStore({ directory: state.directory }))
    const reader = track(createDiskStore({ directory: state.directory }))
    return {
      cleanup: () => reader.cleanup(),
      delete: (k) => reader.delete(k),
      get: (k) => reader.get(k),
      save: (k, v, t) => writer.save(k, v, t),
      take: (k) => reader.take?.(k) ?? Promise.resolve(undefined),
    }
  })

  it("creates its directory owner-only, nested paths included", async () => {
    const directory = join(state.directory, "a", "b")
    const store = track(createDiskStore({ directory }))
    await store.save("k", 1)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
  })

  it("writes each entry as an owner-only file, even over a looser existing one", async () => {
    const store = track(createDiskStore({ directory: state.directory }))
    await store.save("fresh", 1)
    const loose = join(state.directory, "loose.json")
    await writeFile(loose, JSON.stringify({ expiresAt: Number.MAX_SAFE_INTEGER, value: 0 }))
    await chmod(loose, 0o644)
    await store.save("loose", 2)
    expect((await stat(join(state.directory, "fresh.json"))).mode & 0o777).toBe(0o600)
    expect((await stat(loose)).mode & 0o777).toBe(0o600)
  })

  it("keeps every key inside its directory", async () => {
    const store = track(createDiskStore({ directory: state.directory }))
    await store.save("../../escape", "nope")
    await store.save("a/b\\c:d", "x")
    expect((await readdir(state.directory)).sort()).toEqual(["______escape.json", "a_b_c_d.json"])
    expect(await store.get("../../escape")).toBe("nope")
  })

  it("writes FastMCP's file format: expiresAt in epoch ms, MAX_SAFE_INTEGER for none", async () => {
    vi.useFakeTimers({ now: 5_000, toFake: ["Date"] })
    const store = track(createDiskStore({ directory: state.directory }))
    await store.save("timed", "v", 60)
    await store.save("untimed", "w")
    const read = async (name: string) => JSON.parse(await readFile(join(state.directory, name), "utf-8")) as unknown
    expect(await read("timed.json")).toEqual({ expiresAt: 65_000, value: "v" })
    expect(await read("untimed.json")).toEqual({ expiresAt: Number.MAX_SAFE_INTEGER, value: "w" })
  })

  it("uses a custom file extension", async () => {
    const store = track(createDiskStore({ directory: state.directory, fileExtension: ".entry" }))
    await store.save("k", 1)
    expect(await readdir(state.directory)).toEqual(["k.entry"])
    expect(await store.get("k")).toBe(1)
  })

  it("never shows a key as missing while it is being overwritten", async () => {
    const store = track(createDiskStore({ directory: state.directory }))
    await store.save("k", 0)
    const reads: unknown[] = []
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => store.save("k", i + 1)),
      ...Array.from({ length: 20 }, async () => reads.push(await store.get("k"))),
    ])
    expect(reads.every((value) => typeof value === "number")).toBe(true)
  })

  it("does not sweep away an entry that is being overwritten", async () => {
    const store = track(createDiskStore({ directory: state.directory }))
    await store.save("k", 0, 3600)
    await Promise.all([...Array.from({ length: 10 }, (_, i) => store.save("k", i, 3600)), store.cleanup()])
    expect(await store.get("k")).toEqual(expect.any(Number))
  })

  it("leaves no claim or staging files behind", async () => {
    const store = track(createDiskStore({ directory: state.directory }))
    await store.save("k", 1)
    await Promise.all([store.take?.("k"), store.take?.("k")])
    expect(await readdir(state.directory)).toEqual([])
  })

  it("lets exactly one of two instances claim a value", async () => {
    const one = track(createDiskStore({ directory: state.directory }))
    const two = track(createDiskStore({ directory: state.directory }))
    await one.save("code", "once")
    const results = await Promise.all([one.take?.("code"), two.take?.("code"), one.take?.("code"), two.take?.("code")])
    expect(results.filter((r) => r === "once")).toHaveLength(1)
  })

  it("reports, and reads as missing, a file that is not a valid entry", async () => {
    const errors: unknown[][] = []
    const store = track(createDiskStore({ directory: state.directory, logger: { error: (...a) => errors.push(a) } }))
    await writeFile(join(state.directory, "broken.json"), "{ not json")
    expect(await store.get("broken")).toBeUndefined()
    expect(String(errors[0]?.[0])).toContain("broken is not a valid store entry")
    await store.cleanup()
    expect(await readdir(state.directory)).toEqual([])
  })

  it("refuses a directory path that is a file", async () => {
    const file = join(state.directory, "file")
    await writeFile(file, "")
    const store = track(createDiskStore({ directory: file }))
    await expect(store.save("k", 1)).rejects.toThrow("is not a directory")
  })
})

describe("the encrypted store", () => {
  behavesLikeAStore("encrypted over memory", () =>
    Promise.resolve(track(createEncryptedStore(createMemoryStore(), "secret"))),
  )
  behavesLikeAStore(
    "encrypted over a store without take",
    () => {
      const inner = createMemoryStore()
      const { take: _take, ...withoutTake } = inner
      track(inner)
      return Promise.resolve(createEncryptedStore(withoutTake, "secret"))
    },
    { atomicTake: false },
  )

  it("hands the inner store only ciphertext, as <iv>:<tag>:<ciphertext> hex with a 16-byte iv and tag", async () => {
    const inner = track(createMemoryStore())
    const store = createEncryptedStore(inner, "secret")
    await store.save("k", { accessToken: "plain-text-token" })
    const sealed = await inner.get("k")
    expect(typeof sealed).toBe("string")
    expect(String(sealed)).not.toContain("plain-text-token")
    const [iv, tag, ciphertext] = String(sealed).split(":")
    expect(iv).toMatch(/^[0-9a-f]{32}$/)
    expect(tag).toMatch(/^[0-9a-f]{32}$/)
    expect(ciphertext).toMatch(/^[0-9a-f]+$/)
  })

  it("seals the same value differently each time", async () => {
    const inner = track(createMemoryStore())
    const store = createEncryptedStore(inner, "secret")
    await store.save("a", "same")
    await store.save("b", "same")
    expect(await inner.get("a")).not.toBe(await inner.get("b"))
  })

  it("passes the ttl through to the inner store", async () => {
    const saves: Array<number | undefined> = []
    const inner = track(createMemoryStore())
    const store = createEncryptedStore(
      { ...inner, save: (k, v, ttl) => (saves.push(ttl), inner.save(k, v, ttl)) },
      "secret",
    )
    await store.save("k", 1, 30)
    expect(saves).toEqual([30])
  })

  it("reads a value sealed under another key, or tampered with, as missing and logs it", async () => {
    const inner = track(createMemoryStore())
    const errors: unknown[][] = []
    await createEncryptedStore(inner, "right").save("k", 1)
    const wrong = createEncryptedStore(inner, "wrong", { error: (...a) => errors.push(a) })
    expect(await wrong.get("k")).toBeUndefined()
    const sealed = String(await inner.get("k"))
    await inner.save("t", `${sealed.slice(0, -2)}${sealed.endsWith("00") ? "11" : "00"}`)
    expect(await createEncryptedStore(inner, "right", { error: (...a) => errors.push(a) }).get("t")).toBeUndefined()
    expect(errors).toHaveLength(2)
  })

  it("knows a store it made, so it is never wrapped twice", () => {
    const inner = track(createMemoryStore())
    expect(isEncryptedStore(inner)).toBe(false)
    expect(isEncryptedStore(createEncryptedStore(inner, "secret"))).toBe(true)
  })
})
