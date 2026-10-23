#!/usr/bin/env node
// Guards the built package against two regressions that neither typecheck nor
// the unit tests can see, because both live in how the bundle is split:
//
// 1. Node-only code reaching the main entry. `somamcp`, `somamcp/edge` and
//    `somamcp/backend` must run on Workers without nodejs_compat, so nothing they
//    load (their files and every chunk those import, transitively) may import a
//    Node built-in or a Node-only package. In 1.x this regressed twice through a
//    shared chunk while the export map looked correct.
// 2. The core emitted twice. `somamcp/node` must share the main entry's chunks;
//    a second copy would make `instanceof UserError` fail across entries.

import { readFile } from "node:fs/promises"
import { dirname, join, normalize } from "node:path"

import { init, parse } from "es-module-lexer"

const DIST = "dist"
const WORKER_ENTRIES = ["index.js", "edge.js", "backend/index.js"]

// Node-only packages, as whole specifiers or prefixes.
const NODE_ONLY_PACKAGES = [
  "@hono/node-server",
  "@modelcontextprotocol/server/stdio",
  "@modelcontextprotocol/sdk",
  "fastmcp",
]

// Node built-ins are importable without the `node:` prefix too ("fs/promises").
const BARE_NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
])

const isNodeOnly = (specifier) =>
  specifier.startsWith("node:") ||
  BARE_NODE_BUILTINS.has(specifier.split("/")[0]) ||
  NODE_ONLY_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))

await init

/**
 * Import specifiers of an emitted ESM file: static imports, re-exports and
 * dynamic imports with a literal specifier. A real lexer, because the production
 * build is minified onto one line, and a regex would also match string literals
 * that merely contain `from "x"`.
 */
const specifiersOf = (source) =>
  parse(source)[0]
    .map((entry) => entry.n)
    .filter((specifier) => specifier !== undefined)

const read = async (path) => {
  try {
    return await readFile(path, "utf8")
  } catch {
    console.error(`✗ ${path} not found — run the build first.`)
    process.exit(1)
  }
}

/** Every file an entry loads, following relative imports. */
const closure = async (entry) => {
  const seen = new Map()
  const visit = async (path) => {
    if (seen.has(path)) return
    const specifiers = specifiersOf(await read(path))
    seen.set(path, specifiers)
    for (const specifier of specifiers.filter((s) => s.startsWith("."))) {
      await visit(normalize(join(dirname(path), specifier)))
    }
  }
  await visit(join(DIST, entry))
  return seen
}

const problems = []
const files = new Map()
for (const entry of WORKER_ENTRIES) {
  for (const [path, specifiers] of await closure(entry)) {
    files.set(path, specifiers)
    specifiers.filter(isNodeOnly).forEach((s) => problems.push(`${path} (loaded by ${entry}) imports Node-only "${s}"`))
  }
}

// The identity check: exactly one definition of UserError across everything emitted.
const everything = await closure("node/index.js")
for (const entry of WORKER_ENTRIES) for (const [path] of await closure(entry)) everything.set(path, [])
const definitions = []
for (const [path] of everything) {
  // The constructor's name assignment survives minification; the class name does not.
  const count = [...(await read(path)).matchAll(/\.name\s*=\s*["'`]UserError["'`]/g)].length
  if (count > 0) definitions.push(`${path} (${count})`)
}
if (definitions.length !== 1) {
  problems.push(
    `UserError should be defined once, so every entry shares it; found: ${definitions.join(", ") || "none"}`,
  )
}

if (problems.length > 0) {
  console.error("✗ bundle check failed:")
  problems.forEach((p) => console.error(`    - ${p}`))
  console.error(
    "\n  A main-entry module may be importing from src/node/, or somamcp/node may be bundling its own core.",
  )
  process.exit(1)
}

console.log(
  `✓ worker entries are Node-free (${WORKER_ENTRIES.join(", ")}: ${files.size} files) and the core is emitted once (${definitions[0]})`,
)
