// The HTML the OAuth server shows people: the consent page, and a page for errors that
// cannot go back to the app. Both work at phone width, in dark and light mode, with no scripts.
import { Option } from "functype"

import type { ConsentScreen } from "./authorization.js"

const ESCAPES: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
}

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** No scripts, no frames, nothing loaded from elsewhere: the page is styles, inline SVG and a form. */
export const PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
}

/** Scopes shown before the rest fold into "Show all". Microsoft servers often ask for twenty or more. */
export const VISIBLE_SCOPES = 8

const STYLES = `
:root {
  color-scheme: dark light;
  --bg: #0b0b0c; --surface: #141416; --border: #26262a; --tile: #1f1f23; --tile-border: #2e2e33;
  --line: #3a3a40; --text: #ededef; --chip-text: #e4e4e7; --muted: #a1a1aa; --label: #8b8b94;
  --accent: #60a5fa; --accent-text: #0b0b0c; --primary: #fafafa; --primary-text: #0b0b0c;
  --note: #2a2010; --note-text: #f3d38a; --panel: #1b1b1f; --panel-text: #d4d4d8;
  --danger: #fca5a5; --danger-tile: #2a1414; --danger-border: #4a2020;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f5f3; --surface: #ffffff; --border: #e5e5e2; --tile: #f4f4f2; --tile-border: #e5e5e2;
    --line: #d4d4d0; --text: #18181b; --chip-text: #27272a; --muted: #52525b; --label: #6b6b73;
    --accent: #2563eb; --accent-text: #ffffff; --primary: #18181b; --primary-text: #ffffff;
    --note: #fdf6e3; --note-text: #6b4e0f; --panel: #f4f4f2; --panel-text: #3f3f46;
    --danger: #b91c1c; --danger-tile: #fef2f2; --danger-border: #fecaca;
  }
}
* { box-sizing: border-box; margin: 0; }
body {
  min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 16px;
  background: var(--bg); color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main {
  width: 100%; max-width: 452px; padding: 32px 28px 28px; overflow-wrap: anywhere;
  background: var(--surface); border: 1px solid var(--border); border-radius: 18px;
}
@media (max-width: 480px) { main { padding: 28px 22px 24px; } }
svg { display: block; }
.tiles { display: flex; align-items: center; gap: 12px; }
.tile {
  flex: none; width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
  background: var(--tile); border: 1px solid var(--tile-border); color: var(--text); font-size: 20px; font-weight: 650;
}
.link { flex: 1; display: flex; align-items: center; gap: 8px; color: var(--muted); }
.link::before, .link::after { content: ""; flex: 1; border-top: 1px dashed var(--line); }
.tile.danger { width: 44px; height: 44px; background: var(--danger-tile); border-color: var(--danger-border); color: var(--danger); }
.host { margin-top: 22px; font-size: 13px; color: var(--muted); letter-spacing: 0.01em; }
h1 { margin-top: 6px; font-size: 23px; line-height: 1.3; font-weight: 650; }
.lede { margin-top: 10px; color: var(--muted); }
section { margin-top: 24px; }
h2 { margin-bottom: 10px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--label); }
h2 .count { margin-left: 2px; letter-spacing: 0; text-transform: none; font-weight: 500; }
ol { padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
ol li { display: flex; gap: 12px; align-items: flex-start; line-height: 24px; }
.step {
  flex: none; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--line); color: var(--muted); font-size: 13px; font-weight: 600; line-height: 1;
}
.step.now { border-color: var(--accent); background: var(--accent); color: var(--accent-text); font-weight: 700; }
strong { font-weight: 600; }
code, .chip {
  font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--tile); border: 1px solid var(--tile-border); border-radius: 6px; color: var(--chip-text);
}
code { padding: 2px 7px; }
.chips { padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { min-width: 0; max-width: 100%; padding: 4px 9px; }
details { margin-top: 8px; }
details .chips { margin-top: 8px; }
summary { cursor: pointer; width: fit-content; font-size: 14px; font-weight: 600; color: var(--accent); }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
details[open] .closed, details:not([open]) .opened { display: none; }
.note {
  margin-top: 24px; display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px;
  background: var(--note); color: var(--note-text); font-size: 14px; line-height: 1.5;
}
.note svg { flex: none; margin-top: 2px; }
.note strong { font-weight: 650; }
.panel {
  margin-top: 22px; padding: 12px 14px; border-radius: 12px;
  background: var(--panel); border: 1px solid var(--border); color: var(--panel-text); font-size: 14px; line-height: 1.5;
}
.code { margin-top: 18px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--label); }
.code code { color: var(--danger); }
form { display: flex; gap: 10px; margin-top: 24px; }
button {
  flex: 1; min-height: 46px; padding: 10px 16px; border-radius: 11px; font: inherit; font-weight: 600; cursor: pointer;
  border: 1px solid var(--line); background: transparent; color: var(--text);
}
button.approve { background: var(--primary); border-color: var(--primary); color: var(--primary-text); font-weight: 650; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`

const icon = (size: number, body: string): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

const LOCK = icon(
  16,
  `<rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>`,
)
const SERVER = icon(
  22,
  `<rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path>`,
)
const APP = icon(22, `<rect x="4" y="4" width="16" height="16" rx="4"></rect><path d="M9 12h6M12 9v6"></path>`)
const WARNING = icon(
  16,
  `<path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>`,
)
const ALERT = icon(20, `<circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path>`)

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`

const chips = (scopes: ReadonlyArray<string>): string =>
  `<ul class="chips" role="list">${scopes.map((scope) => `<li class="chip">${escapeHtml(scope)}</li>`).join("")}</ul>`

/** Every scope stays on the page; past VISIBLE_SCOPES the rest sit one tap away. */
const accessSection = (scopes: ReadonlyArray<string>): string => {
  if (scopes.length === 0) return ""
  const rest = scopes.slice(VISIBLE_SCOPES)
  const more =
    rest.length === 0
      ? ""
      : `\n<details>\n<summary><span class="closed">Show all ${scopes.length}</span><span class="opened">Show fewer</span></summary>\n${chips(rest)}\n</details>`
  return `<section>
<h2>Access requested <span class="count">${scopes.length}</span></h2>
${chips(scopes.slice(0, VISIBLE_SCOPES))}${more}
</section>`
}

/** The app's tile: its first letter, or a plain glyph when it registered no name. */
const appTile = (name: Option<string>): string =>
  name
    .flatMap((value) => Option(Array.from(value.trim())[0]))
    .fold(
      () => `<div class="tile">${APP}</div>`,
      (letter) => `<div class="tile">${escapeHtml(letter.toUpperCase())}</div>`,
    )

/** A registered name proves nothing, so the warning points at the return address instead. */
const proof = (name: Option<string>): string =>
  name.fold(
    () => "The app registered no name, so its return address is all that identifies it.",
    (value) => `Any app can register as “${escapeHtml(value)}”; only the return address proves where it comes from.`,
  )

/** The page that asks the user to approve an app. `server` is the server's own host. */
export const consentPage = (screen: ConsentScreen, server: string): string => {
  const name = screen.clientName.orElse("an app")
  const app = escapeHtml(name)
  const provider = escapeHtml(screen.provider)
  const returnsTo = escapeHtml(screen.returnsTo)
  return page(
    `Allow ${name} to use this server?`,
    `<div class="tiles">
${appTile(screen.clientName)}
<div class="link">${LOCK}</div>
<div class="tile">${SERVER}</div>
</div>
<p class="host">${escapeHtml(server)}</p>
<h1>Allow ${app} to use this server?</h1>
<p class="lede">It will act with your ${provider} account${screen.scope.length === 0 ? "" : ", within the access below"}.</p>
<section>
<h2>What happens next</h2>
<ol role="list">
<li aria-current="step"><span class="step now">1</span><span>You approve here.</span></li>
<li><span class="step">2</span><span>You sign in with <strong>${provider}</strong>. This server never sees your password.</span></li>
<li><span class="step">3</span><span>You return to <code>${returnsTo}</code>.</span></li>
</ol>
</section>
${accessSection(screen.scope)}
<div class="note">${WARNING}<span>Approve only if you started this from <strong>${returnsTo}</strong>. ${proof(screen.clientName)}</span></div>
<form method="post" action="${escapeHtml(screen.action)}">
<input type="hidden" name="transaction_id" value="${escapeHtml(screen.transactionId)}">
<button type="submit" name="action" value="deny">Deny</button>
<button type="submit" name="action" value="approve" class="approve">Approve</button>
</form>`,
  )
}

/** The page for an error that cannot be sent back to the app. */
export const errorPage = (code: string, description: string, server: string): string =>
  page(
    "This sign-in can't continue",
    `<div class="tile danger">${ALERT}</div>
<p class="host">${escapeHtml(server)}</p>
<h1>This sign-in can't continue</h1>
<p class="lede">${escapeHtml(description)}</p>
<div class="code"><span>Error code</span><code>${escapeHtml(code)}</code></div>
<div class="panel">Go back to the app you were connecting, and start the sign-in again. If it keeps failing, give its owner the error code above.</div>`,
  )
