import type { ILogLayer } from "loglayer"
import { ConsoleTransport, LogLayer } from "loglayer"

export const createDefaultLogger = (name: string): ILogLayer =>
  new LogLayer({
    prefix: `[${name}]`,
    transport: new ConsoleTransport({
      logger: console,
    }),
  }).withContext({ cell: name })
