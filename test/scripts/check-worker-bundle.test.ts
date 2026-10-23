// scripts/check-worker-bundle.mjs against hand-built dist fixtures: it passes a
// clean layout and fails each leak it exists to catch. Without this, a gap in the
// check only shows up when someone injects a leak by hand.
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

const SCRIPT = fileURLToPath(new URL("../../scripts/check-worker-bundle.mjs", import.meta.url))
const run = promisify(execFile)

/** A minimal dist: three worker entries and somamcp/node over one shared core chunk. */
const CLEAN: Record<string, string> = {
  "backend/index.js": 'export { b } from "../core.js"\n',
  "core.js":
    'export const b = 1\nexport var UserError = class extends Error { constructor(m) { super(m); this.name = "UserError" } }\n',
  "edge.js": 'export * from "./index.js"\n',
  "index.js": 'import { b } from "./core.js"\nexport { b }\n',
  "node/index.js": 'import { readFile } from "node:fs/promises"\nexport * from "../index.js"\nexport { readFile }\n',
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true })))
})

const check = async (overrides: Record<string, string> = {}): Promise<{ code: number; output: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "soma-bundle-"))
  dirs.push(dir)
  for (const [path, source] of Object.entries({ ...CLEAN, ...overrides })) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), source)
  }
  return run("node", [SCRIPT, dir]).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error: { code: number; stderr: string; stdout: string }) => ({
      code: error.code,
      output: error.stdout + error.stderr,
    }),
  )
}

describe("check-worker-bundle", () => {
  it("passes a clean layout, where only somamcp/node imports Node", async () => {
    const { code, output } = await check()
    expect(code).toBe(0)
    expect(output).toContain("worker entries are Node-free")
  })

  it.each([
    ["a node: import", 'import "node:fs"\n', 'imports Node-only "node:fs"'],
    ["a bare built-in import", 'import { join } from "path"\n', 'imports Node-only "path"'],
    ["a Node-only package", 'import { serve } from "@hono/node-server"\n', 'imports Node-only "@hono/node-server"'],
    ["a dynamic import", 'export const f = () => import("node:https")\n', 'imports Node-only "node:https"'],
    ["Buffer", 'export const e = Buffer.from("x")\n', '"Buffer."'],
    ["process", "export const h = process.env.HOME\n", '"process."'],
    ["require()", 'export const fs = require("fs")\n', '"require("'],
  ])("fails %s in a chunk a worker entry loads", async (_label, leak, message) => {
    const { code, output } = await check({ "core.js": CLEAN["core.js"] + leak })
    expect(code).toBe(1)
    expect(output).toContain(message)
  })

  it("ignores guarded and commented uses", async () => {
    const guarded =
      "// process.env is read only through globalThis\nexport const p = globalThis.process?.env\n/* Buffer.from is not used */\n"
    expect((await check({ "core.js": CLEAN["core.js"] + guarded })).code).toBe(0)
  })

  it("fails when somamcp/node bundles its own copy of the core", async () => {
    const copy =
      'export var UserError2 = class extends Error { constructor(m) { super(m); this.name = "UserError" } }\n'
    const { code, output } = await check({ "node/index.js": CLEAN["node/index.js"] + copy })
    expect(code).toBe(1)
    expect(output).toContain("UserError should be defined once")
  })
})
