import { Option } from "functype"

import type { AudioContent, ImageContent } from "../types/core.js"

/** Raw bytes (a Node `Buffer` is one), or a URL to fetch them from. */
export type ContentInput = { buffer: Uint8Array } | { url: string }

const IMAGE_MIME_MAP: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
}

const AUDIO_MIME_MAP: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".weba": "audio/webm",
}

/** The lowercased extension of a URL's or path's last segment, like `node:path`'s `extname`. */
const extensionOf = (source: string): string => {
  const path = new URL(source, "file:///").pathname
  const dot = path.lastIndexOf(".")
  return dot > path.lastIndexOf("/") + 1 ? path.slice(dot).toLowerCase() : ""
}

// String.fromCharCode takes its bytes as arguments, so convert in slices that stay
// well under the engines' argument limits.
const BASE64_CHUNK = 0x8000

/** Base64 without `Buffer`, so it runs on Workers. */
const toBase64 = (bytes: Uint8Array): string =>
  btoa(
    Array.from({ length: Math.ceil(bytes.length / BASE64_CHUNK) }, (_, i) =>
      String.fromCharCode(...bytes.subarray(i * BASE64_CHUNK, (i + 1) * BASE64_CHUNK)),
    ).join(""),
  )

const mimeOf = (source: Option<string>, mimeMap: Record<string, string>, fallback: string): string =>
  source.flatMap((s) => Option(mimeMap[extensionOf(s)])).orElse(fallback)

/** Encode bytes as image content; `source` (a URL or path) picks the MIME type by extension. */
export const encodeImage = (data: Uint8Array, source: Option<string>): ImageContent => ({
  data: toBase64(data),
  mimeType: mimeOf(source, IMAGE_MIME_MAP, "image/png"),
  type: "image",
})

/** Encode bytes as audio content; `source` (a URL or path) picks the MIME type by extension. */
export const encodeAudio = (data: Uint8Array, source: Option<string>): AudioContent => ({
  data: toBase64(data),
  mimeType: mimeOf(source, AUDIO_MIME_MAP, "audio/mpeg"),
  type: "audio",
})

/** @interop rejects on a failed fetch, which the caller's tool turns into an error result */
const load = async (input: ContentInput, label: string): Promise<{ data: Uint8Array; source: Option<string> }> => {
  if ("buffer" in input) return { data: input.buffer, source: Option.none() }
  const response = await fetch(input.url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${label} from URL (${input.url}): ${response.status} ${response.statusText}`)
  }
  return { data: new Uint8Array(await response.arrayBuffer()), source: Option(input.url) }
}

export const imageContent = async (input: ContentInput): Promise<ImageContent> => {
  const { data, source } = await load(input, "image")
  return encodeImage(data, source)
}

export const audioContent = async (input: ContentInput): Promise<AudioContent> => {
  const { data, source } = await load(input, "audio")
  return encodeAudio(data, source)
}
