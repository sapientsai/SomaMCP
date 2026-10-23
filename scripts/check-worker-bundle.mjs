#!/usr/bin/env node
// Guards the built package against two regressions that neither typecheck nor
// the unit tests can see, because both live in how the bundle is split:
//
// 1. Node-only code reaching the main entry. `somamcp`, `somamcp/edge` and
//    `somamcp/backend` must run on Workers without nodejs_compat, so nothing they
//    load (their files and every chunk those import, transitively) may import a
//    Node built-in or a Node-only package, call require(), or use the Node
//    globals Buffer and process. In 1.x this regressed twice through a shared
//    chunk while the export map looked correct. Dependencies are external, so
//    this reads somamcp's own code; test/workers/ runs it all in workerd.
// 2. The core emitted twice. `somamcp/node` must share the main entry's chunks;
//    a second copy would make `instanceof UserError` fail across entries.

import { readFile } from "node:fs/promises"
import { dirname, join, normalize } from "node:path"

import { init, parse } from "es-module-lexer"

// The directory to check; defaults to the build output. Tests pass a fixture.
const DIST = process.argv[2] ?? "dist"
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
    .map((entry) => entry.specifier)
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

/**
 * Uses of Node globals and require() in a file. Block comments and whole-line
 * comments are dropped first, so prose about `process` does not count. A
 * property access (`globalThis.process`, `x.Buffer`) does not count either: that
 * is how guarded code reads them. String literals are not stripped, so a string
 * containing `process.` would be flagged; none does today.
 */
const nodeGlobalsIn = (source) =>
  [
    ...source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .matchAll(/(?<![.\w$])(Buffer\s*[.(]|process\s*\.|require\s*\()/g),
  ].map((m) => m[1].replace(/\s+/g, ""))

const problems = []
const files = new Map()
for (const entry of WORKER_ENTRIES) {
  for (const [path, specifiers] of await closure(entry)) {
    if (files.has(path)) continue
    files.set(path, specifiers)
    specifiers.filter(isNodeOnly).forEach((s) => problems.push(`${path} (loaded by ${entry}) imports Node-only "${s}"`))
    nodeGlobalsIn(await read(path)).forEach((use) =>
      problems.push(`${path} (loaded by ${entry}) uses the Node global or CommonJS call "${use}"`),
    )
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
