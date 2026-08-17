#!/usr/bin/env node
// Guards the `somamcp/edge` build against Node-only code.
//
// This has regressed twice during development, both times invisibly: the subpath
// export looked correct while rolldown's shared chunk quietly pulled
// `node:fs/promises` and the Node FastMCP backend into the edge entry. Neither
// typecheck nor the unit tests catch it — only reading the emitted bundle does.
// A Workers deploy would fail at runtime, not build time.

import { readdir, readFile } from "node:fs/promises"

const DIST = "dist"

// Forbidden as whole import specifiers. `fastmcp/edge` is the allowed one;
// `fastmcp/auth` is Node-only (it imports bare crypto/fs/promises/path/util).
const FORBIDDEN_MODULES = ["fastmcp", "fastmcp/auth"]

// Node builtins are also importable WITHOUT the `node:` prefix, and real code
// does this — fastmcp/auth imports bare "crypto", "fs/promises", "path", "util".
// Checking only the `node:` form would wave those straight through.
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

/** True for "fs" and "fs/promises" alike. */
const isBareNodeBuiltin = (specifier) => BARE_NODE_BUILTINS.has(specifier.split("/")[0])

// The edge entry plus any chunk it could emit alongside itself (dynamic imports
// produce sibling chunks that would otherwise go unscanned).
const isEdgeArtifact = (name) => /^edge.*\.js$/.test(name)

const listEdgeFiles = async () => {
  try {
    return (await readdir(DIST)).filter(isEdgeArtifact).sort()
  } catch {
    console.error(`✗ ${DIST}/ not found — run the build first.`)
    process.exit(1)
  }
}

const files = await listEdgeFiles()
if (files.length === 0) {
  console.error(`✗ no edge bundle found in ${DIST}/ — run the build first.`)
  process.exit(1)
}

const problems = []
let total = 0

for (const name of files) {
  const path = `${DIST}/${name}`
  const source = await readFile(path, "utf8")

  // Matches `from "x"`, bare side-effect `import "x"`, and dynamic `import("x")`.
  const specifiers = [
    ...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
    ...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1])

  total += specifiers.length

  specifiers.filter((s) => s.startsWith("node:")).forEach((s) => problems.push(`${path} imports Node built-in "${s}"`))
  specifiers
    .filter((s) => isBareNodeBuiltin(s))
    .forEach((s) => problems.push(`${path} imports Node built-in "${s}" (bare, no node: prefix)`))
  specifiers
    .filter((s) => FORBIDDEN_MODULES.includes(s))
    .forEach((s) => problems.push(`${path} imports Node-only module "${s}"`))
}

if (problems.length > 0) {
  console.error("✗ edge bundle is not edge-safe:")
  problems.forEach((p) => console.error(`    - ${p}`))
  console.error("\n  Check for a barrel import that re-exports Node code (see src/edge.ts header).")
  process.exit(1)
}

console.log(`✓ edge bundle is edge-safe (${files.join(", ")}; ${total} imports, no Node built-ins)`)
