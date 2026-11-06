// Bundling a Worker and driving it through Miniflare, shared by the workerd tests.
import { fileURLToPath } from "node:url"

import { build } from "esbuild"
import { Miniflare } from "miniflare"

import type { Fetchable } from "../backend/sdk-clients.js"

const SRC = fileURLToPath(new URL("../../src", import.meta.url))

export const bundleWorker = async (entry: string): Promise<string> => {
  const result = await build({
    alias: { "@": SRC },
    bundle: true,
    // What wrangler resolves for a Worker: the SDK's _shims export picks its workerd stub.
    conditions: ["workerd", "worker", "browser"],
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    // "neutral" knows no Node built-ins, so importing one fails the build outright.
    platform: "neutral",
    target: "es2022",
    write: false,
  })
  return result.outputFiles[0]?.text ?? ""
}

export const startWorkerd = async (script: string): Promise<Miniflare> => {
  const mf = new Miniflare({ compatibilityDate: "2026-07-01", compatibilityFlags: [], modules: true, script })
  await mf.ready
  return mf
}

/** Route a client's requests into the Worker; Miniflare's Response becomes a global one. */
export const workerFetchable = (mf: Miniflare): Fetchable => ({
  fetch: async (request) => {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const response = await mf.dispatchFetch(request.url, {
      body,
      headers: Object.fromEntries(request.headers),
      method: request.method,
    })
    return new Response(response.body as ReadableStream | null, {
      headers: Object.fromEntries(response.headers),
      status: response.status,
    })
  },
})
