// The HTML the OAuth server shows people: the consent page, and a page for errors that
// cannot go back to the app. Both share the dashboard's palette and work at phone width.
import type { ConsentScreen } from "./authorization.js"

const ESCAPES: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
}

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** No scripts, no frames, nothing loaded from elsewhere: the page is styles and a form. */
export const PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
}

const STYLES = `
:root {
  color-scheme: dark light;
  --bg: #0a0a0a; --surface: #141414; --border: #262626; --text: #ededed; --muted: #8f8f8f;
  --chip: #1f1f1f; --primary: #fafafa; --primary-text: #0a0a0a; --note: #2a2110; --note-text: #f5d58a;
  --danger: #f87171;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f5f4; --surface: #ffffff; --border: #e4e4e2; --text: #171717; --muted: #6b6b6b;
    --chip: #f1f1ef; --primary: #171717; --primary-text: #ffffff; --note: #fdf6e3; --note-text: #6b4e0f;
    --danger: #b91c1c;
  }
}
* { box-sizing: border-box; margin: 0; }
body {
  min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
  background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main {
  width: 100%; max-width: 440px; padding: 28px 24px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
}
.eyebrow { color: var(--muted); font-size: 13px; letter-spacing: 0.02em; }
h1 { margin: 6px 0 10px; font-size: 21px; line-height: 1.3; font-weight: 650; overflow-wrap: anywhere; }
p { color: var(--muted); }
p strong { color: var(--text); font-weight: 600; }
section { margin-top: 22px; }
h2 { margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
ul { display: flex; flex-wrap: wrap; gap: 6px; padding: 0; list-style: none; }
code, .chip {
  font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--chip); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px;
  overflow-wrap: anywhere;
}
.note { margin-top: 22px; padding: 12px 14px; border-radius: 10px; background: var(--note); color: var(--note-text); font-size: 14px; }
form { display: flex; gap: 10px; margin-top: 24px; }
button {
  flex: 1; min-height: 44px; padding: 10px 16px; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--text);
}
button.approve { background: var(--primary); border-color: var(--primary); color: var(--primary-text); }
button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
.code { margin-top: 18px; color: var(--danger); }
`

const page = (title: string, eyebrow: string, body: string): string => `<!doctype html>
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
<div class="eyebrow">${escapeHtml(eyebrow)}</div>
${body}
</main>
</body>
</html>
`

/** The page that asks the user to approve an app. `server` is the server's own host. */
export const consentPage = (screen: ConsentScreen, server: string): string => {
  const app = screen.clientName.fold(
    () => "An app",
    (name) => name,
  )
  const scopes = screen.scope.map((scope) => `<li class="chip">${escapeHtml(scope)}</li>`).join("")
  return page(
    `Authorize ${app}`,
    server,
    `<h1>Authorize ${escapeHtml(app)}</h1>
<p><strong>${escapeHtml(app)}</strong> wants to use this server on your behalf. You'll sign in with <strong>${escapeHtml(screen.provider)}</strong> next.</p>
<section>
<h2>Returns to</h2>
<ul><li class="chip">${escapeHtml(screen.returnsTo)}</li></ul>
</section>
${scopes === "" ? "" : `<section>\n<h2>Access requested</h2>\n<ul>${scopes}</ul>\n</section>`}
<div class="note">Approve only if you started this from <strong>${escapeHtml(screen.returnsTo)}</strong>. The app will act with your ${escapeHtml(screen.provider)} account.</div>
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
    "Sign-in can't continue",
    server,
    `<h1>Sign-in can't continue</h1>
<p>${escapeHtml(description)}</p>
<p class="code"><code>${escapeHtml(code)}</code></p>
<div class="note">Go back to your app and start the sign-in again.</div>`,
  )
