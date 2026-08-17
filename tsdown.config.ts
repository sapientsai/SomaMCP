import { defineConfig, type UserConfig } from "tsdown"

const isProduction = process.env.NODE_ENV === "production"

const shared: UserConfig = {
  clean: false,
  dts: true,
  external: [
    "fastmcp",
    /^fastmcp\//,
    "@modelcontextprotocol/sdk",
    "hono",
    "functype",
    "zod",
    /^functype\//,
    /^@modelcontextprotocol\//,
  ],
  format: ["esm"],
  minify: isProduction,
  outDir: "dist",
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  sourcemap: !isProduction,
  target: "es2022",
  treeshake: true,
}

// The node and edge entries are built as SEPARATE passes on purpose.
//
// In a single pass, rolldown hoists modules shared between entries into a common
// chunk. That chunk pulled `node:fs/promises` (JsonFileTelemetry, content helpers)
// and the Node FastMCP backend into `somamcp/edge`, which breaks a Workers build —
// the subpath export alone does not prevent it, because the leak happens at the
// chunk layer, below the export map. Separate passes cannot share a chunk graph.
//
// The cost is that code common to both entries is emitted twice. Consumers load
// one entry or the other, never both, so this costs nothing at runtime.
export default defineConfig([
  {
    ...shared,
    clean: true,
    entry: {
      "backend/index": "src/backend/index.ts",
      index: "src/index.ts",
    },
    platform: "node",
  },
  {
    ...shared,
    entry: { edge: "src/edge.ts" },
    // "neutral" keeps Node built-in interop out of the edge output entirely.
    platform: "neutral",
  },
])
