import { defineConfig } from "tsdown"

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  outDir: "dist",
  platform: "node",
  treeshake: true,
  outExtensions: () => ({ js: ".js" }),
})
