// Cross-check: somamcp/node's OAuth proxy writes, fastmcp 4.22.10 reads, and back, over shared
// DiskStore directories. It is the guard for the write side: oauth-compat.test.ts proves that
// what FastMCP wrote reads here, and this proves that what we write, FastMCP reads, which a
// rolling deploy (or a rollback to FastMCP) depends on. Run it after changing src/node/oauth/:
//
//   pnpm build && node test/fixtures/fastmcp-4.22.10-oauth/xcheck.mjs dist/node/index.js <fastmcp-4.22.10 dist dir>
//
// fastmcp is not a dependency of somamcp; point at any install of 4.22.10.
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const [portArg, fmArg] = process.argv.slice(2)
if (!portArg || !fmArg) {
  console.error("usage: node xcheck.mjs <somamcp dist/node/index.js> <fastmcp-4.22.10 dist dir>")
  process.exit(2)
}
const PORT = resolve(portArg)
const FM = resolve(fmArg)

const port = await import(PORT)
const fm = await import(join(FM, "auth/index.js"))
const { FastMCP } = await import(join(FM, "FastMCP.js"))

const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const config = {
  baseUrl: "https://xcheck.invalid",
  clientId: "upstream-client",
  clientSecret: "upstream-secret",
  tenantId: "common",
  scopes: ["offline_access", "User.Read", "Mail.Read"],
  jwtSigningKey: "xcheck-signing-key",
  encryptionKey: "xcheck-encryption-key",
  allowedRedirectUriPatterns: ["https://claude.ai/*", "http://localhost:*/*"],
}
const redirectUri = "https://claude.ai/api/mcp/auth_callback"

// ── upstream stub, shared by both sides ────────────────────────────────
let upstreamCalls = 0
let nextUpstreamError = null // { status, body } served once
const upstreamFor = (n) => ({
  access_token: `graph-access-${n}`,
  id_token: `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ oid: "oid-1", name: "X" })).toString("base64url")}.sig`,
  refresh_token: `graph-refresh-${n}`,
  expires_in: 3599,
  token_type: "Bearer",
  scope: "User.Read Mail.Read",
})
const upstream = async (url, init) => {
  if (!String(url).startsWith("https://login.microsoftonline.com/")) throw new Error(`unexpected fetch ${url}`)
  if (nextUpstreamError) {
    const e = nextUpstreamError
    nextUpstreamError = null
    return new Response(e.raw ?? JSON.stringify(e.body), {
      status: e.status,
      statusText: e.status === 503 ? "Service Unavailable" : "Bad Request",
      headers: { "content-type": e.raw ? "text/plain" : "application/json" },
    })
  }
  upstreamCalls += 1
  return new Response(JSON.stringify(upstreamFor(upstreamCalls)), { headers: { "content-type": "application/json" } })
}
const realFetch = globalThis.fetch
globalThis.fetch = (url, init) =>
  String(url).startsWith("https://login.microsoftonline.com/") ? upstream(url, init) : realFetch(url, init)

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}
const txnOf = (html) => /name="transaction_id" value="([^"]+)"/.exec(html)[1]

// Adapters so both proxies look the same.
const portProxy = (dir, extra = {}) => {
  const provider = port.createAzureProvider({
    ...config,
    fetch: upstream,
    tokenStorage: port.createDiskStore({ directory: dir }),
    ...extra,
  })
  const p = provider.getProxy()
  const un = (e) =>
    e.fold(
      (err) => {
        throw Object.assign(new Error(err.description ?? err.code), err)
      },
      (v) => v,
    )
  return {
    kind: "port",
    provider,
    authenticate: (token) =>
      provider.authenticate(new Request(`${config.baseUrl}/mcp`, { headers: { authorization: `Bearer ${token}` } })),
    register: async (req) => un(await p.registerClient(req)),
    authorize: async (params) => un(await p.authorize(params)),
    consent: async (transactionId, action = "approve") =>
      un(await p.handleConsent(new URLSearchParams({ transaction_id: transactionId, action }))),
    callback: async (url) => un(await p.handleCallback(new Request(url))),
    exchange: async (req) => un(await p.exchangeAuthorizationCode(req)),
    exchangeRaw: (req) => p.exchangeAuthorizationCode(req),
    refresh: async (req) => un(await p.exchangeRefreshToken(req)),
    refreshRaw: (req) => p.exchangeRefreshToken(req),
    load: async (token) => (await p.loadUpstreamTokens(token)).orUndefined() ?? null,
    destroy: () => provider.destroy(),
  }
}
const fmProxy = (dir) => {
  const provider = new fm.AzureProvider({ ...config, tokenStorage: new fm.DiskStore({ directory: dir }) })
  const p = provider.getProxy()
  return {
    kind: "fastmcp",
    provider,
    authenticate: (token) => provider.authenticate({ headers: { authorization: `Bearer ${token}` } }),
    register: (req) => p.registerClient(req),
    authorize: (params) => p.authorize(params),
    consent: (transactionId, action = "approve") =>
      p.handleConsent(
        new Request(`${config.baseUrl}/oauth/consent`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ transaction_id: transactionId, action }),
        }),
      ),
    callback: (url) => p.handleCallback(new Request(url)),
    exchange: (req) => p.exchangeAuthorizationCode(req),
    refresh: (req) => p.exchangeRefreshToken(req),
    load: (token) => p.loadUpstreamTokens(token),
    destroy: () => p.destroy(),
  }
}

const startFlow = async (px, clientId, state) => {
  const k = pkce()
  const page = await px.authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: k.challenge,
    code_challenge_method: "S256",
    state,
  })
  const transactionId = txnOf(await page.text())
  return { ...k, transactionId }
}
const approveAndCallback = async (approver, callbacker, transactionId, upstreamCode) => {
  const consent = await approver.consent(transactionId)
  const up = new URL(consent.headers.get("Location"))
  const cb = await callbacker.callback(
    `${config.baseUrl}/oauth/callback?code=${upstreamCode}&state=${up.searchParams.get("state")}`,
  )
  const back = new URL(cb.headers.get("Location"))
  return { code: back.searchParams.get("code"), back }
}
const fullSignIn = async (writer, exchanger, clientId, label) => {
  const f = await startFlow(writer, clientId, `state-${label}`)
  const { code, back } = await approveAndCallback(writer, writer, f.transactionId, `ms-code-${label}`)
  const tokens = await exchanger.exchange({
    client_id: clientId,
    code,
    code_verifier: f.verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  })
  return { tokens, back }
}

const dirs = []
const tmp = (label) => {
  const d = mkdtempSync(join(tmpdir(), `xcheck-${label}-`))
  dirs.push(d)
  return d
}

try {
  // ── A. port writes everything, fastmcp reads ─────────────────────────
  {
    const dir = tmp("A")
    const w = portProxy(dir)
    const reg = await w.register({ redirect_uris: [redirectUri], client_name: "Claude" })
    const { tokens, back } = await fullSignIn(w, w, reg.client_id, "a1")
    check("A0 port sign-in issues a JWT pair", tokens.access_token.split(".").length === 3 && !!tokens.refresh_token)
    check(
      "A0b port callback redirect carries state+iss",
      back.searchParams.get("state") === "state-a1" && back.searchParams.get("iss") === config.baseUrl,
    )
    // live code, never exchanged
    const f2 = await startFlow(w, reg.client_id, "state-a2")
    const live = await approveAndCallback(w, w, f2.transactionId, "ms-code-a2")
    // pending transaction
    const f3 = await startFlow(w, reg.client_id, "state-a3")

    // permissions
    const dmode = statSync(dir).mode & 0o777
    const fmodes = readdirSync(dir).map((f) => statSync(join(dir, f)).mode & 0o777)
    check(
      "A1 files written by the port are 0600 (dir pre-existed from mkdtemp, so dir mode not asserted)",
      fmodes.every((m) => m === 0o600),
      `dir=${dmode.toString(8)} files=${[...new Set(fmodes.map((m) => m.toString(8)))]}`,
    )
    const freshDir = join(dir, "fresh")
    const fresh = port.createDiskStore({ directory: freshDir })
    await fresh.save("k", 1)
    check(
      "A1b a directory the port creates is 0700",
      (statSync(freshDir).mode & 0o777) === 0o700,
      (statSync(freshDir).mode & 0o777).toString(8),
    )
    fresh.destroy?.()

    // raw decrypt with fastmcp's own classes
    const rawFm = new fm.EncryptedTokenStorage(new fm.DiskStore({ directory: dir }), config.encryptionKey)
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    const keyOf = (f) => f.replace(/\.json$/, "").replace(/^(client|code|transaction|mapping|upstream)_/, "$1:")
    let rawOk = 0
    for (const f of files) {
      const v = await rawFm.get(keyOf(f))
      if (v !== null && typeof v === "object") rawOk += 1
      else console.log("   raw miss:", f, v)
    }
    check(
      "A2 fastmcp EncryptedTokenStorage(DiskStore) decrypts every file the port wrote",
      rawOk === files.length,
      `${rawOk}/${files.length}`,
    )
    const fmClient = await rawFm.get(`client:${reg.client_id}`)
    check(
      "A2b registered client record round-trips (clientSecret, redirectUris, registeredAt ISO)",
      fmClient?.clientSecret === reg.client_secret &&
        eq(fmClient?.redirectUris, [redirectUri]) &&
        typeof fmClient?.registeredAt === "string" &&
        !Number.isNaN(Date.parse(fmClient.registeredAt)),
    )

    const r = fmProxy(dir)
    const up = await r.load(tokens.access_token)
    check(
      "A3 fastmcp loadUpstreamTokens(port access JWT)",
      up?.accessToken === "graph-access-1" && up?.refreshToken === "graph-refresh-1",
      JSON.stringify(up)?.slice(0, 120),
    )
    const sess = await r.authenticate(tokens.access_token)
    check("A4 fastmcp authenticate(port access JWT) -> session.accessToken", sess?.accessToken === "graph-access-1")
    const refreshed = await r.refresh({
      client_id: reg.client_id,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    })
    check(
      "A5 fastmcp refreshes with the port's refresh JWT",
      refreshed?.access_token?.split(".").length === 3 && !!refreshed.refresh_token,
    )
    const again = await r
      .refresh({ client_id: reg.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token })
      .catch((e) => e)
    check(
      "A6 second use of the port's refresh JWT at fastmcp is rejected as already used",
      again instanceof Error && again.description === "Refresh token already used or expired",
      again?.description,
    )
    // fastmcp's new access token is then readable by the port (rotation handoff back)
    const w2 = portProxy(dir)
    const backAgain = await w2.load(refreshed.access_token)
    const fmView = await r.load(refreshed.access_token)
    check(
      "A7 port loadUpstreamTokens(fastmcp-refreshed access JWT) == fastmcp's view",
      !!backAgain && eq(backAgain, fmView),
      JSON.stringify(backAgain)?.slice(0, 80),
    )
    // fastmcp redeems the port's live code
    const redeemed = await r.exchange({
      client_id: reg.client_id,
      code: live.code,
      code_verifier: f2.verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    })
    check("A8 fastmcp redeems a live code the port issued (PKCE)", redeemed?.access_token?.split(".").length === 3)
    const spent = await r
      .exchange({
        client_id: reg.client_id,
        code: live.code,
        code_verifier: f2.verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      })
      .catch((e) => e)
    check(
      "A9 ...and the tombstone fastmcp wrote reads as already used at the port",
      (
        await w2.exchangeRaw({
          client_id: reg.client_id,
          code: live.code,
          code_verifier: f2.verifier,
          grant_type: "authorization_code",
        })
      ).fold(
        (e) => e.description,
        () => "ok",
      ) === "Authorization code already used",
      spent?.description,
    )
    // fastmcp approves the port's pending transaction
    const consent = await r.consent(f3.transactionId)
    const upUrl = new URL(consent.headers.get("Location"))
    check(
      "A10 fastmcp approves a transaction the port stored",
      consent.status === 302 &&
        upUrl.hostname === "login.microsoftonline.com" &&
        upUrl.searchParams.get("state") === f3.transactionId,
    )
    // and the port completes that callback (fastmcp re-saved the transaction with consentGiven)
    const cb3 = await w2.callback(`${config.baseUrl}/oauth/callback?code=ms-code-a3&state=${f3.transactionId}`)
    const code3 = new URL(cb3.headers.get("Location")).searchParams.get("code")
    const t3 = await w2.exchange({
      client_id: reg.client_id,
      code: code3,
      code_verifier: f3.verifier,
      grant_type: "authorization_code",
    })
    check(
      "A11 port finishes the callback+exchange on a transaction fastmcp approved",
      t3.access_token.split(".").length === 3,
    )
    w.destroy()
    w2.destroy()
    r.destroy()
  }

  // ── B. fastmcp writes everything, the port reads (fresh data, real clock) ─
  {
    const dir = tmp("B")
    const w = fmProxy(dir)
    const reg = await w.register({ redirect_uris: [redirectUri], client_name: "Claude" })
    const { tokens } = await fullSignIn(w, w, reg.client_id, "b1")
    const f2 = await startFlow(w, reg.client_id, "state-b2")
    const live = await approveAndCallback(w, w, f2.transactionId, "ms-code-b2")
    const f3 = await startFlow(w, reg.client_id, "state-b3")
    const r = portProxy(dir)
    const up = await r.load(tokens.access_token)
    check("B1 port loadUpstreamTokens(fastmcp access JWT), fresh data", up?.accessToken?.startsWith("graph-access-"))
    const sess = await r.authenticate(tokens.access_token)
    check(
      "B2 port authenticate(fastmcp access JWT)",
      sess?.accessToken === up?.accessToken && Array.isArray(sess?.scopes),
    )
    const refreshed = await r.refresh({
      client_id: reg.client_id,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    })
    check("B3 port refreshes with fastmcp's refresh JWT", refreshed.access_token.split(".").length === 3)
    const fmReads = await w.load(refreshed.access_token)
    check(
      "B4 fastmcp reads the mapping/upstream the port's refresh wrote",
      fmReads?.accessToken?.startsWith("graph-access-"),
    )
    const redeemed = await r.exchange({
      client_id: reg.client_id,
      code: live.code,
      code_verifier: f2.verifier,
      grant_type: "authorization_code",
    })
    check("B5 port redeems fastmcp's live code", redeemed.access_token.split(".").length === 3)
    const consent = await r.consent(f3.transactionId)
    check("B6 port approves fastmcp's pending transaction", consent.status === 302)
    // fastmcp finishes that callback and exchange (port wrote consentGiven transaction)
    const cb = await w.callback(`${config.baseUrl}/oauth/callback?code=ms-code-b3&state=${f3.transactionId}`)
    const code3 = new URL(cb.headers.get("Location")).searchParams.get("code")
    const t3 = await w.exchange({
      client_id: reg.client_id,
      code: code3,
      code_verifier: f3.verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    })
    check(
      "B7 fastmcp finishes callback+exchange on a transaction the port approved",
      t3.access_token.split(".").length === 3,
    )
    // mid-flow: port authorize+consent -> fastmcp callback -> port exchange
    const f4 = await startFlow(r, reg.client_id, "state-b4")
    const h = await approveAndCallback(r, w, f4.transactionId, "ms-code-b4")
    const t4 = await r.exchange({
      client_id: reg.client_id,
      code: h.code,
      code_verifier: f4.verifier,
      grant_type: "authorization_code",
    })
    check("B8 port authorize/consent -> fastmcp callback -> port exchange", t4.access_token.split(".").length === 3)
    // JWT header bytes identical
    check(
      "B9 JWT header segment identical",
      tokens.access_token.split(".")[0] === t4.access_token.split(".")[0],
      `${tokens.access_token.split(".")[0]} vs ${t4.access_token.split(".")[0]}`,
    )
    const claimsFm = Object.keys(JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()))
    const claimsPort = Object.keys(JSON.parse(Buffer.from(t4.access_token.split(".")[1], "base64url").toString()))
    check("B10 JWT claim keys and order identical", eq(claimsFm, claimsPort), `${claimsFm} | ${claimsPort}`)
    w.destroy()
    r.destroy()
  }

  // ── C. port alone: concurrency, refresh-restore, upstream error mapping ─
  {
    const dir = tmp("C")
    const w = portProxy(dir)
    const reg = await w.register({ redirect_uris: [redirectUri] })
    const f = await startFlow(w, reg.client_id, "s")
    const live = await approveAndCallback(w, w, f.transactionId, "ms-code-c1")
    const req = {
      client_id: reg.client_id,
      code: live.code,
      code_verifier: f.verifier,
      grant_type: "authorization_code",
    }
    // two processes sharing the directory are modelled by two DiskStore instances
    const w2 = portProxy(dir)
    const [x, y] = await Promise.all([w.exchangeRaw(req), w2.exchangeRaw(req)])
    const rights = [x, y].filter((e) => e.isRight()).length
    check(
      "C1 two concurrent exchanges of one code over DiskStore -> exactly one succeeds",
      rights === 1,
      [x, y]
        .map((e) =>
          e.fold(
            (er) => er.description,
            () => "ok",
          ),
        )
        .join(" / "),
    )
    const { tokens } = await fullSignIn(w, w, reg.client_id, "c2")
    nextUpstreamError = {
      status: 400,
      body: { error: "invalid_grant", error_description: "AADSTS70008: The refresh token has expired" },
    }
    const failed = await w.refreshRaw({
      client_id: reg.client_id,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    })
    check(
      "C2 upstream 400 is relayed with upstream's error and description",
      failed.isLeft() &&
        failed.fold(
          (e) => e.code === "invalid_grant" && e.description === "AADSTS70008: The refresh token has expired",
          () => false,
        ),
      failed.fold(
        (e) => `${e.code}: ${e.description}`,
        () => "ok",
      ),
    )
    const retry = await w.refreshRaw({
      client_id: reg.client_id,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    })
    check(
      "C3 the same refresh JWT works after the upstream failure (mapping restored)",
      retry.isRight(),
      retry.fold(
        (e) => e.description,
        () => "ok",
      ),
    )
    const { tokens: t3 } = await fullSignIn(w, w, reg.client_id, "c3")
    nextUpstreamError = { status: 503, raw: "not json" }
    const failed2 = await w.refreshRaw({
      client_id: reg.client_id,
      grant_type: "refresh_token",
      refresh_token: t3.refresh_token,
    })
    check(
      "C4 non-JSON upstream error -> invalid_grant 'Upstream returned HTTP 503 ...'",
      failed2.fold(
        (e) => e.code === "invalid_grant" && /Upstream returned HTTP 503/.test(e.description ?? ""),
        () => false,
      ),
      failed2.fold(
        (e) => `${e.code}: ${e.description}`,
        () => "ok",
      ),
    )
    // wrong client at exchange
    const f5 = await startFlow(w, reg.client_id, "s5")
    const live5 = await approveAndCallback(w, w, f5.transactionId, "ms-code-c5")
    const reg2 = await w.register({ redirect_uris: [redirectUri] })
    const mism = await w.exchangeRaw({
      client_id: reg2.client_id,
      code: live5.code,
      code_verifier: f5.verifier,
      grant_type: "authorization_code",
    })
    check(
      "C5 client mismatch -> invalid_client 'Client ID mismatch', and the code is spent",
      mism.fold(
        (e) => e.code === "invalid_client" && e.description === "Client ID mismatch",
        () => false,
      ) &&
        (
          await w.exchangeRaw({
            client_id: reg.client_id,
            code: live5.code,
            code_verifier: f5.verifier,
            grant_type: "authorization_code",
          })
        ).fold(
          (e) => e.description,
          () => "ok",
        ) === "Authorization code already used",
    )
    w.destroy()
    w2.destroy()
  }

  // ── D. HTTP headers: real fastmcp server vs the port's server.fetch ─────
  {
    const dirF = tmp("Dfm"),
      dirP = tmp("Dport")
    const base = "http://127.0.0.1:39418"
    const fmProvider = new fm.AzureProvider({
      ...config,
      baseUrl: base,
      tokenStorage: new fm.DiskStore({ directory: dirF }),
    })
    const server = new FastMCP({ name: "x", version: "0.0.0", auth: fmProvider })
    await server.start({ transportType: "httpStream", httpStream: { port: 39418, host: "127.0.0.1", stateless: true } })
    const portProvider = port.createAzureProvider({
      ...config,
      baseUrl: base,
      fetch: upstream,
      tokenStorage: port.createDiskStore({ directory: dirP }),
    })
    const ps = port.createServer({
      auth: portProvider,
      name: "x",
      version: "0.0.0",
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableInfoEndpoint: false,
    })
    const cases = [
      [
        "POST /oauth/token password grant",
        "/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=password",
        },
      ],
      [
        "POST /oauth/token bad refresh",
        "/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=refresh_token&refresh_token=nope&client_id=x",
        },
      ],
      [
        "POST /oauth/register bad json",
        "/oauth/register",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{" },
      ],
      [
        "POST /oauth/register bad redirect",
        "/oauth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: ["https://evil.example/"] }),
        },
      ],
      [
        "POST /oauth/register ok",
        "/oauth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: [redirectUri] }),
        },
      ],
      ["GET /oauth/authorize missing params", "/oauth/authorize?x=1", {}],
      ["GET /oauth/callback missing", "/oauth/callback", {}],
      ["GET /oauth/callback upstream error", "/oauth/callback?error=access_denied&error_description=nope", {}],
      [
        "POST /oauth/consent missing",
        "/oauth/consent",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "action=approve" },
      ],
      [
        "POST /oauth/consent 2MiB",
        "/oauth/consent",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "a".repeat(2 * 1024 * 1024),
        },
      ],
      ["GET /.well-known/oauth-protected-resource/other", "/.well-known/oauth-protected-resource/other", {}],
    ]
    const strip = (h) =>
      Object.fromEntries(
        [...h].filter(
          ([k]) => !["date", "connection", "keep-alive", "transfer-encoding", "content-length"].includes(k),
        ),
      )
    for (const [name, path, init] of cases) {
      const a = await realFetch(`${base}${path}`, { ...init, redirect: "manual" })
      const b = await ps.fetch(new Request(`${base}${path}`, init))
      const ha = strip(a.headers),
        hb = strip(b.headers)
      const ba = await a.text(),
        bb = await b.text()
      // normalize register ok: random ids
      const norm = (s) =>
        s
          .replace(/"client_id":"[^"]+"/, '"client_id":"*"')
          .replace(/"client_secret":"[^"]+"/, '"client_secret":"*"')
          .replace(/"client_id_issued_at":\d+/, '"client_id_issued_at":0')
      const same = a.status === b.status && eq(ha, hb) && norm(ba) === norm(bb)
      check(
        `D ${name}`,
        same,
        same
          ? `${a.status} ${JSON.stringify(ha)}`
          : `fastmcp ${a.status} ${JSON.stringify(ha)} ${ba.slice(0, 120)} || port ${b.status} ${JSON.stringify(hb)} ${bb.slice(0, 120)}`,
      )
    }
    // consent page content-type
    {
      const regA = await (
        await realFetch(`${base}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: [redirectUri] }),
        })
      ).json()
      const regB = await (
        await ps.fetch(
          new Request(`${base}/oauth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ redirect_uris: [redirectUri] }),
          }),
        )
      ).json()
      const q = (id) =>
        `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: redirectUri, code_challenge: "abc", code_challenge_method: "S256", state: "s" })}`
      const a = await realFetch(`${base}${q(regA.client_id)}`)
      const b = await ps.fetch(new Request(`${base}${q(regB.client_id)}`))
      check(
        "D consent page status+content-type",
        a.status === b.status && a.headers.get("content-type") === b.headers.get("content-type"),
        `fastmcp ${a.status} ${a.headers.get("content-type")} || port ${b.status} ${b.headers.get("content-type")}`,
      )
      const bodyA = (await a.text()).replace(/value="[^"]+"/, "").trim(),
        bodyB = (await b.text()).replace(/value="[^"]+"/, "").trim()
      check("D consent HTML identical modulo transaction id", bodyA === bodyB, `${bodyA.length} vs ${bodyB.length}`)
    }
    await server.stop()
    portProvider.destroy()
  }
} catch (e) {
  console.error("SCRIPT ERROR", e)
  results.push({ name: "script completed", ok: false, detail: String(e?.stack ?? e) })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
for (const d of dirs) await import("node:fs/promises").then((fs) => fs.rm(d, { recursive: true, force: true }))
process.exit(failed.length ? 1 : 0)
