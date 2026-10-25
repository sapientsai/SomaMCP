import { Option } from "functype"

import type { SessionAuth } from "../types/core.js"
import type { ServerConfig } from "../types/server.js"

/**
 * The `authenticate` a server runs: an explicit one, else the auth provider's.
 * An explicit one wins, as in FastMCP, so a server can keep a provider's routes
 * and challenge but decide sessions itself.
 */
export const resolveAuthenticate = <T extends SessionAuth>(
  config: ServerConfig<T>,
): Option<NonNullable<ServerConfig<T>["authenticate"]>> =>
  Option(config.authenticate).or(
    Option(config.auth).map(
      // Nullish already means "no session" to every caller, so the provider's wider return type is safe.
      (auth) => auth.authenticate as NonNullable<ServerConfig<T>["authenticate"]>,
    ),
  )
