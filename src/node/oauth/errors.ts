// Why an OAuth request failed, as a tagged union. Code inside the authorization server
// returns these as the Left of an Either. Only the HTTP layer turns them into the wire
// error codes that RFC 6749 (§4.1.2.1, §5.2) and RFC 7591 (§3.2.2) define, because those
// codes are what clients act on: `invalid_grant` on a refresh, for example, makes a client
// sign in again.
import { Option } from "functype"

export type OAuthError =
  /** The request is missing a parameter, repeats one, or has one the server cannot accept. */
  | { readonly _tag: "InvalidRequest"; readonly reason: string }
  /** The `client_id` is not one this server issued. */
  | { readonly _tag: "UnknownClient"; readonly clientId: string }
  /** A code, refresh token or PKCE verifier that is invalid, expired, spent, or someone else's. */
  | { readonly _tag: "InvalidGrant"; readonly reason: string }
  | { readonly _tag: "UnsupportedGrantType"; readonly grantType: string }
  | { readonly _tag: "UnsupportedResponseType"; readonly responseType: string }
  /** Dynamic client registration: a redirect URI the allow-list refuses. */
  | { readonly _tag: "RedirectUriNotAllowed"; readonly uri: string }
  /** Dynamic client registration: metadata that is missing or malformed. */
  | { readonly _tag: "InvalidClientMetadata"; readonly reason: string }
  /** The upstream provider answered with an OAuth error of its own, relayed as it came. */
  | { readonly _tag: "ProviderRejected"; readonly code: string; readonly description: Option<string> }
  /** The upstream provider could not be reached, timed out, or answered with something unusable. */
  | { readonly _tag: "ProviderUnavailable"; readonly reason: string }

export const OAuthError = {
  invalidGrant: (reason: string): OAuthError => ({ _tag: "InvalidGrant", reason }),
  invalidMetadata: (reason: string): OAuthError => ({ _tag: "InvalidClientMetadata", reason }),
  invalidRequest: (reason: string): OAuthError => ({ _tag: "InvalidRequest", reason }),
  providerRejected: (code: string, description: Option<string>): OAuthError => ({
    _tag: "ProviderRejected",
    code,
    description,
  }),
  providerUnavailable: (reason: string): OAuthError => ({ _tag: "ProviderUnavailable", reason }),
  redirectUriNotAllowed: (uri: string): OAuthError => ({ _tag: "RedirectUriNotAllowed", uri }),
  unknownClient: (clientId: string): OAuthError => ({ _tag: "UnknownClient", clientId }),
  unsupportedGrantType: (grantType: string): OAuthError => ({ _tag: "UnsupportedGrantType", grantType }),
  unsupportedResponseType: (responseType: string): OAuthError => ({
    _tag: "UnsupportedResponseType",
    responseType,
  }),
}

/** An OAuth error as it goes on the wire: the RFC error code, a description, and the HTTP status. */
export type WireError = { readonly code: string; readonly description: Option<string>; readonly status: number }

const wire = (code: string, description: string, status = 400): WireError => ({
  code,
  description: Option(description),
  status,
})

export const toWireError = (error: OAuthError): WireError => {
  switch (error._tag) {
    case "InvalidRequest":
      return wire("invalid_request", error.reason)
    case "UnknownClient":
      return wire("invalid_client", "This client is not registered with the server.")
    case "InvalidGrant":
      return wire("invalid_grant", error.reason)
    case "UnsupportedGrantType":
      return wire("unsupported_grant_type", `The grant type "${error.grantType}" is not supported.`)
    case "UnsupportedResponseType":
      return wire("unsupported_response_type", `The response type "${error.responseType}" is not supported.`)
    case "RedirectUriNotAllowed":
      return wire("invalid_redirect_uri", `The redirect URI ${error.uri} is not allowed.`)
    case "InvalidClientMetadata":
      return wire("invalid_client_metadata", error.reason)
    case "ProviderRejected":
      return { code: error.code, description: error.description, status: 400 }
    // A failure on the provider's side is not the client's fault, so it is a 502.
    case "ProviderUnavailable":
      return wire("server_error", error.reason, 502)
  }
}

/** The JSON body of an OAuth error response. */
export const wireErrorBody = (error: WireError): { error: string; error_description?: string } => ({
  error: error.code,
  ...error.description.fold(
    () => ({}),
    (description) => ({ error_description: description }),
  ),
})
