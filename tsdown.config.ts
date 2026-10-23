import { defineConfig } from "tsdown"

const isProduction = process.env.NODE_ENV === "production"

// One pass for every entry, so `somamcp/node` and the main entry share chunks
// instead of each bundling a copy of the core. Copies would break identity: a
// UserError thrown from code that imported `somamcp` would fail an `instanceof`
// check made by `somamcp/node`. scripts/check-worker-bundle.mjs fails the build
// if Node-only code reaches anything the main entry loads, or if the core is
// emitted twice.
export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    "backend/index": "src/backend/index.ts",
    edge: "src/edge.ts",
    index: "src/index.ts",
    "node/index": "src/node/index.ts",
  },
  deps: {
    neverBundle: [
      /^node:/,
      "hono",
      /^hono\//,
      "@hono/node-server",
      "functype",
      "zod",
      /^functype\//,
      /^@modelcontextprotocol\//,
    ],
  },
  format: ["esm"],
  minify: isProduction,
  outDir: "dist",
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  // "neutral" keeps Node built-in interop out of the output; Node built-ins are
  // imported by name, from somamcp/node's modules only.
  platform: "neutral",
  sourcemap: !isProduction,
  target: "es2022",
  treeshake: true,
})
