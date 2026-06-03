import { defineConfig } from "tsdown"

const isProduction = process.env.NODE_ENV === "production"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "backend/index": "src/backend/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: !isProduction,
  clean: true,
  minify: isProduction,
  target: "es2022",
  outDir: "dist",
  platform: "node",
  treeshake: true,
  external: [
    "fastmcp",
    "@modelcontextprotocol/sdk",
    "hono",
    "functype",
    "zod",
    /^functype\//,
    /^@modelcontextprotocol\//,
  ],
  outExtensions: () => ({
    js: ".js",
    dts: ".d.ts",
  }),
})
