import { fileURLToPath } from "node:url"

import { defineConfig, mergeConfig } from "vitest/config"
import baseConfig from "ts-builds/vitest"

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  }),
)
