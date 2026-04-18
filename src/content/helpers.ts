import { readFile } from "node:fs/promises"
import { extname } from "node:path"

import type { AudioContent, ImageContent } from "../types/core.js"

type ContentInput = { buffer: Buffer } | { path: string } | { url: string }

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

const inferMime = (source: string, mimeMap: Record<string, string>, fallback: string): string => {
  const ext = extname(new URL(source, "file:///").pathname).toLowerCase()
  return mimeMap[ext] ?? fallback
}

// eslint-disable-next-line functype/prefer-either -- helper feeds imageContent/audioContent which must return Promise<ImageContent>/Promise<AudioContent>; failures surface as Promise rejections per their public contract
const loadRaw = async (input: ContentInput, label: string): Promise<{ data: Buffer; source?: string }> => {
  if ("url" in input) {
    const response = await fetch(input.url)
    if (!response.ok) {
      // eslint-disable-next-line functype/prefer-either -- see function-level note above
      throw new Error(`Failed to fetch ${label} from URL (${input.url}): ${response.status} ${response.statusText}`)
    }
    return { data: Buffer.from(await response.arrayBuffer()), source: input.url }
  }
  if ("path" in input) {
    return { data: await readFile(input.path), source: input.path }
  }
  return { data: input.buffer }
}

export const imageContent = async (input: ContentInput): Promise<ImageContent> => {
  const { data, source } = await loadRaw(input, "image")
  const mimeType = source ? inferMime(source, IMAGE_MIME_MAP, "image/png") : "image/png"
  return { data: data.toString("base64"), mimeType, type: "image" }
}

export const audioContent = async (input: ContentInput): Promise<AudioContent> => {
  const { data, source } = await loadRaw(input, "audio")
  const mimeType = source ? inferMime(source, AUDIO_MIME_MAP, "audio/mpeg") : "audio/mpeg"
  return { data: data.toString("base64"), mimeType, type: "audio" }
}
