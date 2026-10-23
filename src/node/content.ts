import { readFile } from "node:fs/promises"

import { Option } from "functype"

import * as web from "../content/helpers.js"
import type { AudioContent, ImageContent } from "../types/core.js"

/** The main entry's inputs, plus a file path, which only Node can read. */
export type NodeContentInput = web.ContentInput | { path: string }

/** Like the main entry's `imageContent`, and also reads `{ path }` from disk; the extension picks the MIME type. */
export const imageContent = async (input: NodeContentInput): Promise<ImageContent> =>
  "path" in input ? web.encodeImage(await readFile(input.path), Option(input.path)) : web.imageContent(input)

/** Like the main entry's `audioContent`, and also reads `{ path }` from disk; the extension picks the MIME type. */
export const audioContent = async (input: NodeContentInput): Promise<AudioContent> =>
  "path" in input ? web.encodeAudio(await readFile(input.path), Option(input.path)) : web.audioContent(input)
