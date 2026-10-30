import { type Either, Left, Option, Right } from "functype"

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

/**
 * Run `authenticate` with somamcp 1.x's failure semantics, on the MCP endpoint
 * and on protected artifacts and routes alike. A synchronous throw counts as a
 * rejection, and a nullish result, whatever the type says, as a failed
 * authentication (the idiomatic way to signal one). Left(None) means no session;
 * Left(Some) carries what it threw or rejected with, as it was.
 *
 * Not `Try.fromPromise`: it turns a rejection that is not an `Error` into a new
 * `Error`, so a rejected `Response` would be lost.
 */
export const runAuthenticate = <S>(run: () => Promise<S> | S): Promise<Either<Option<unknown>, S>> =>
  Promise.resolve()
    .then(run)
    .then(
      (auth) =>
        Option(auth).fold(
          () => Left<Option<unknown>, S>(Option.none()),
          (session) => Right<Option<unknown>, S>(session as S),
        ),
      (reason: unknown) => Left<Option<unknown>, S>(Option(reason)),
    )

/**
 * A `Response` that `authenticate` rejected with, which is served as-is (somamcp
 * 1.x's convention, from FastMCP), on the MCP endpoint and on protected artifacts
 * and routes alike.
 */
export const rejectedResponse = (failure: Option<unknown>): Option<Response> =>
  failure.filter((reason) => reason instanceof Response).map((reason) => reason as Response)
