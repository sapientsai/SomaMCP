import { List, Option } from "functype"

const concat = (chunks: List<Uint8Array>, total: number): Uint8Array =>
  chunks.foldLeft({ bytes: new Uint8Array(total), offset: 0 })((acc, chunk) => {
    acc.bytes.set(chunk, acc.offset)
    return { bytes: acc.bytes, offset: acc.offset + chunk.byteLength }
  }).bytes

const readAll = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
  chunks: List<Uint8Array>,
  total: number,
): Promise<Option<Uint8Array>> => {
  const { done, value } = await reader.read()
  if (done) return Option(concat(chunks, total))
  const size = total + value.byteLength
  if (size > limit) {
    await reader.cancel().catch(() => {})
    return Option.none()
  }
  return readAll(reader, limit, chunks.add(value), size)
}

/**
 * A request's body as text, or none when it is over `limit` bytes or cannot be read.
 * A declared `Content-Length` over the limit is refused without reading.
 */
export const readBoundedText = async (request: Request, limit: number): Promise<Option<string>> => {
  const declared = Option(request.headers.get("content-length")).map(Number)
  if (declared.exists((length) => length > limit)) return Option.none()
  return Option(request.body).fold(
    () => Promise.resolve(Option("")),
    (body) =>
      // getReader() throws on a locked or consumed stream; keep that inside the chain.
      Promise.resolve()
        .then(() => readAll(body.getReader(), limit, List.empty<Uint8Array>(), 0))
        .then((bytes) => bytes.map((b) => new TextDecoder().decode(b)))
        .catch(() => Option.none<string>()),
  )
}
