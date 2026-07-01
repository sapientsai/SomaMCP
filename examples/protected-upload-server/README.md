# protected-upload-server

Example showing how to wire the `1.1.0` protected-routes surface end-to-end on somamcp:

- **`authenticate`** at `createServer` — gates both the MCP transport and any protected route.
- **`addRoute({ protected: true })`** — a method-aware `POST /upload` behind the same auth gate.
- **`getRequestHeader`** — hides the `Hono Request` vs `http.IncomingMessage` shape difference so `authenticate` can be written once.
- **Content-array tool return** — a tool that returns `{ content: [text, image] }` proves multimodal returns flow through the telemetry wrapper unchanged.
- **`onUnauthorized`** — a custom 401 response with a `WWW-Authenticate` header.

Doubles as the make-or-break fixture for the `addRoute` + `getRequestHeader` surfaces shipped in somamcp `1.1.0`.

## Running

```bash
# HTTP mode (default) — http://localhost:3333
API_KEY=dev-secret pnpm dev

# stdio transport (auth still runs, header comes from the client's initial handshake)
pnpm dev:stdio
```

Endpoints (HTTP mode):

- `POST /mcp` — MCP transport
- `POST /upload` — protected upload relay (Authorization: Bearer $API_KEY)
- `GET  /dashboard` — auto-registered somamcp dashboard
- `GET  /health` / `GET /info` — auto-registered health + info artifacts

## Try it

```bash
# Rejected (no bearer)
curl -i http://localhost:3333/upload -X POST -d 'hi'
# → HTTP/1.1 401
# → {"error":"unauthorized","hint":"provide `Authorization: Bearer <API_KEY>`"}

# Accepted
curl -i -H "Authorization: Bearer dev-secret" -X POST \
  --data-binary '@/path/to/file' \
  http://localhost:3333/upload
# → 200 {"bytes":N,"contentType":"…","status":"accepted"}
```

## What to read

- [`src/index.ts`](src/index.ts) — the whole example is under 100 lines.
- The somamcp README's "Protected routes" section — narrative for the same wiring.
