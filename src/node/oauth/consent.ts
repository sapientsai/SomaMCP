// The consent screen the OAuth proxy shows before redirecting to the upstream provider.
// Ported verbatim from fastmcp 4.22.10 (MIT, src/auth/utils/consent.ts).

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#x27;",
  "/": "&#x2F;",
  "<": "&lt;",
  ">": "&gt;",
}

const escapeHtml = (text: string): string => text.replace(/[&<>"'/]/g, (char) => HTML_ESCAPES[char] ?? char)

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  email: "Access your email address",
  openid: "Verify your identity",
  profile: "View your basic profile information",
  "read:user": "Read your user information",
  "write:user": "Modify your user information",
}

const formatScope = (scope: string): string => SCOPE_LABELS[scope] ?? scope.replace(/_/g, " ").replace(/:/g, " - ")

export type ConsentScreen = {
  clientName?: string
  provider: string
  scope: ReadonlyArray<string>
  transactionId: string
}

export const consentHtml = ({ clientName, provider, scope, transactionId }: ConsentScreen): string =>
  `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authorization Request</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }

        .consent-container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 480px;
            width: 100%;
            padding: 40px;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
        }

        .header h1 {
            color: #1a202c;
            font-size: 24px;
            margin-bottom: 8px;
        }

        .header p {
            color: #718096;
            font-size: 14px;
        }

        .app-info {
            background: #f7fafc;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 24px;
        }

        .app-info h2 {
            color: #2d3748;
            font-size: 18px;
            margin-bottom: 12px;
        }

        .app-name {
            color: #667eea;
            font-weight: 600;
        }

        .permissions {
            margin-top: 16px;
        }

        .permissions h3 {
            color: #4a5568;
            font-size: 14px;
            margin-bottom: 8px;
            font-weight: 600;
        }

        .permissions ul {
            list-style: none;
        }

        .permissions li {
            color: #718096;
            font-size: 14px;
            padding: 6px 0;
            padding-left: 24px;
            position: relative;
        }

        .permissions li:before {
            content: "\u2713";
            position: absolute;
            left: 0;
            color: #48bb78;
            font-weight: bold;
        }

        .warning {
            background: #fffaf0;
            border-left: 4px solid #ed8936;
            padding: 12px 16px;
            margin-bottom: 24px;
            border-radius: 4px;
        }

        .warning p {
            color: #744210;
            font-size: 13px;
            line-height: 1.5;
        }

        .actions {
            display: flex;
            gap: 12px;
        }

        button {
            flex: 1;
            padding: 14px 24px;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .approve {
            background: #667eea;
            color: white;
        }

        .approve:hover {
            background: #5a67d8;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .deny {
            background: #e2e8f0;
            color: #4a5568;
        }

        .deny:hover {
            background: #cbd5e0;
        }

        .footer {
            margin-top: 24px;
            text-align: center;
            color: #a0aec0;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="consent-container">
        <div class="header">
            <h1>\u{1F510} Authorization Request</h1>
            <p>via ${escapeHtml(provider)}</p>
        </div>

        <div class="app-info">
            <h2>
                <span class="app-name">${escapeHtml(clientName ?? "An application")}</span>
                requests access
            </h2>

            <div class="permissions">
                <h3>This will allow the app to:</h3>
                <ul>
                    ${scope.map((s) => `<li>${escapeHtml(formatScope(s))}</li>`).join("")}
                </ul>
            </div>
        </div>

        <div class="warning">
            <p>
                <strong>\u26A0\uFE0F Important:</strong> Only approve if you trust this application.
                By approving, you authorize it to access your account information.
            </p>
        </div>

        <form method="POST" action="/oauth/consent">
            <input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}">
            <div class="actions">
                <button type="submit" name="action" value="deny" class="deny">
                    Deny
                </button>
                <button type="submit" name="action" value="approve" class="approve">
                    Approve
                </button>
            </div>
        </form>

        <div class="footer">
            <p>This consent is required to prevent unauthorized access.</p>
        </div>
    </div>
</body>
</html>
    `.trim()
