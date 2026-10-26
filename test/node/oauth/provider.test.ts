import { Option } from "functype"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createAzureProvider,
  createMemoryStore,
  createOAuthProxyProvider,
  createServer,
} from "../../../src/node/index.js"
import type { OAuthAuthProvider } from "../../../src/node/oauth/provider.js"
import { consentPage, errorPage, escapeHtml, VISIBLE_SCOPES } from "../../../src/node/oauth/pages.js"
import { CALLBACK, createFakeProvider, quiet } from "./harness.js"

const BASE = "https://ms365.test"
const made: OAuthAuthProvider[] = []
afterEach(() => made.splice(0).forEach((p) => p.close()))

const azure = (overrides: Partial<Parameters<typeof createAzureProvider>[0]> = {}) => {
  const provider = createAzureProvider({
    allowedRedirectUriPatterns: ["https://claude.ai/*"],
    baseUrl: BASE,
    clientId: "azure-client",
    clientSecret: "azure-secret",
    encryptionKey: "k",
    jwtSigningKey: "j",
    logger: quiet,
    tokenStorage: createMemoryStore(),
    ...overrides,
  })
  made.push(provider)
  return provider
}

const fetchFrom = (provider: OAuthAuthProvider) =>
  createServer({ auth: provider, enableDashboard: false, enableInfoEndpoint: false, name: "s", version: "1.0.0" }).fetch

const metadataOf = async (provider: OAuthAuthProvider) =>
  (await (await fetchFrom(provider)(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()) as Record<
    string,
    unknown
  >

/** Where /oauth/authorize sends the user for a freshly registered client. */
const authorizeStep = async (provider: OAuthAuthProvider) => {
  const fetch = fetchFrom(provider)
  const { client_id } = (await (
    await fetch(
      new Request(`${BASE}/oauth/register`, { body: JSON.stringify({ redirect_uris: [CALLBACK] }), method: "POST" }),
    )
  ).json()) as { client_id: string }
  return fetch(
    new Request(
      `${BASE}/oauth/authorize?${new URLSearchParams({ client_id, code_challenge: "c".repeat(43), code_challenge_method: "S256", redirect_uri: CALLBACK, response_type: "code" })}`,
    ),
  )
}

describe("the Azure provider", () => {
  it("signs in at login.microsoftonline.com for the tenant, common by default", async () => {
    const fake = createFakeProvider()
    const res = await authorizeStep(azure({ consentRequired: false, fetch: fake.fetch, tenantId: "contoso" }))
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/contoso\/oauth2\/v2\.0\/authorize\?/,
    )
    const common = await authorizeStep(azure({ consentRequired: false }))
    expect(common.headers.get("location")).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/,
    )
  })

  it("asks for openid profile email unless told otherwise", async () => {
    expect((await metadataOf(azure())).scopes_supported).toEqual(["openid", "profile", "email"])
    expect((await metadataOf(azure({ scopes: ["User.Read"] }))).scopes_supported).toEqual(["User.Read"])
  })

  it("uses the server's defaults for options it is not given: plain PKCE, iss, and consent", async () => {
    const metadata = await metadataOf(azure())
    expect(metadata.code_challenge_methods_supported).toEqual(["S256", "plain"])
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true)
    expect((await authorizeStep(azure())).status).toBe(200)
  })

  it("passes the options it is given on to the server", async () => {
    const metadata = await metadataOf(azure({ allowPlainPkce: false, authorizationResponseIss: false }))
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"])
    expect(metadata).not.toHaveProperty("authorization_response_iss_parameter_supported")
    expect((await authorizeStep(azure({ consentRequired: false }))).status).toBe(302)
  })
})

describe("authenticate", () => {
  it.each([
    ["no request (stdio)", undefined],
    ["no Authorization header", new Request(BASE)],
    ["a scheme other than Bearer", new Request(BASE, { headers: { authorization: "Basic eDp5" } })],
    ["an empty Bearer token", new Request(BASE, { headers: { authorization: "Bearer " } })],
    ["a token this server did not issue", new Request(BASE, { headers: { authorization: "Bearer not.a.token" } })],
  ])("finds no session with %s", async (_name, request) => {
    expect(await azure().authenticate(request)).toBeUndefined()
  })

  it("is the provider's whole contract with createServer: authenticate, challenge, routes", () => {
    const provider = azure()
    expect(typeof provider.authenticate).toBe("function")
    expect(typeof provider.challenge).toBe("function")
    expect(provider.routes?.(() => "/mcp").map((r) => r.path)).toEqual([
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/*",
      "/oauth/register",
      "/oauth/authorize",
      "/oauth/consent",
      "/oauth/callback",
      "/oauth/token",
    ])
  })
})

describe("startup warnings", () => {
  it("say when tokens will not survive a restart", () => {
    const warn = vi.fn()
    const provider = createOAuthProxyProvider({
      baseUrl: BASE,
      logger: { error: () => {}, warn },
      scopes: [],
      store: createMemoryStore(),
      upstream: {
        authorizationEndpoint: "https://a.test",
        clientId: "c",
        clientSecret: "s",
        name: "A",
        tokenEndpoint: "https://t.test",
      },
    })
    made.push(provider)
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("no encryptionKey"),
      expect.stringContaining("no jwtSigningKey"),
    ])
  })

  it("stay quiet when both keys are set", () => {
    const warn = vi.fn()
    azure({ logger: { error: () => {}, warn } })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("the pages", () => {
  it("escape the five HTML special characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    )
  })

  const screen = {
    action: `${BASE}/oauth/consent`,
    clientName: Option<string>(undefined),
    provider: "Microsoft",
    returnsTo: "claude.ai",
    scope: [] as string[],
    transactionId: "t-1",
  }

  it("call a client without a registered name 'An app', and leave out an empty scope list", () => {
    const html = consentPage(screen, "ms365.test")
    expect(html).toContain("<h1>Allow An app to use this server?</h1>")
    expect(html).toContain("registered no name")
    expect(html).not.toContain("Access requested")
    expect(html).toContain('<p class="host">ms365.test</p>')
  })

  it("put the app's first letter in its tile, escaped", () => {
    expect(consentPage({ ...screen, clientName: Option("claude") }, "ms365.test")).toContain(
      '<div class="tile">C</div>',
    )
    expect(consentPage({ ...screen, clientName: Option("<x>") }, "ms365.test")).toContain(
      '<div class="tile">&lt;</div>',
    )
  })

  it("show a short scope list in full, with no fold", () => {
    const scope = Array.from({ length: VISIBLE_SCOPES }, (_, n) => `Scope.${n}`)
    const html = consentPage({ ...screen, scope }, "ms365.test")
    expect(html).toContain(`<span class="count">${VISIBLE_SCOPES}</span>`)
    expect(html).not.toContain("<details>")
    for (const name of scope) expect(html).toContain(`<li class="chip">${name}</li>`)
  })

  it("fold a long scope list behind 'Show all', keeping every scope on the page", () => {
    // The Microsoft 365 server asks for 22 by default.
    const scope = [...Array.from({ length: 21 }, (_, n) => `Scope.${n}`), "https://graph.microsoft.com/.default"]
    const html = consentPage({ ...screen, scope }, "ms365.test")
    expect(html).toContain('<span class="count">22</span>')
    expect(html).toContain("Show all 22")
    const [shown, folded] = html.split("<details>")
    for (const name of scope.slice(0, VISIBLE_SCOPES)) expect(shown).toContain(`<li class="chip">${name}</li>`)
    for (const name of scope.slice(VISIBLE_SCOPES)) {
      expect(shown).not.toContain(`>${name}<`)
      expect(folded).toContain(`<li class="chip">${name}</li>`)
    }
  })

  it("show the error's code and description on the error page", () => {
    const html = errorPage("invalid_request", 'Bad "thing"', "ms365.test")
    expect(html).toContain("<code>invalid_request</code>")
    expect(html).toContain("Bad &quot;thing&quot;")
  })

  it("fit a phone: a viewport, a 16px gutter, and chips that wrap", () => {
    const html = consentPage(screen, "ms365.test")
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(html).toContain("padding: 40px 16px")
    expect(html).toContain("max-width: 452px")
    expect(html).toContain("overflow-wrap: anywhere")
  })
})
