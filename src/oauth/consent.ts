import type { Express } from "express";
import express from "express";
import type { ToolName } from "../security.js";
import type { PlatterOAuthProvider } from "./provider.js";

interface ToolInfo {
  name: ToolName;
  scope: string;
  checked: boolean;
}

function consentPageHtml(requestId: string, clientName: string, tools: ToolInfo[], error?: string): string {
  const escapedName = clientName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const toolCheckboxes = tools
    .map(
      (t) =>
        `<label class="tool">
        <input type="checkbox" name="scope" value="${t.scope}"${t.checked ? " checked" : ""}>
        <span>${t.name}</span>
      </label>`,
    )
    .join("\n      ");

  const errorHtml = error
    ? `<div class="error" role="alert">${error.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Platter - Authorization</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0f0f0f;
    color: #e0e0e0;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 1rem;
  }
  .card {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 2rem;
    max-width: 420px;
    width: 100%;
  }
  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .client-name {
    color: #7eb8ff;
    font-weight: 600;
  }
  p { color: #aaa; margin-bottom: 1rem; font-size: 0.9rem; }
  .confirm {
    margin-bottom: 1.25rem;
  }
  .confirm label {
    display: block;
    font-size: 0.85rem;
    font-weight: 500;
    margin-bottom: 0.25rem;
    color: #ccc;
  }
  .confirm .hint {
    font-size: 0.8rem;
    color: #888;
    margin-bottom: 0.5rem;
  }
  .confirm input {
    width: 100%;
    padding: 0.55rem 0.75rem;
    background: #111;
    border: 1px solid #444;
    border-radius: 6px;
    color: #fff;
    font-family: monospace;
    font-size: 1.1rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    text-align: center;
  }
  .confirm input:focus {
    outline: none;
    border-color: #7eb8ff;
  }
  .error {
    background: #3a1c1c;
    border: 1px solid #6b2c2c;
    color: #f5a5a5;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
    margin-bottom: 1rem;
  }
  .tools {
    margin-bottom: 1.5rem;
    padding: 0.75rem 1rem;
    background: #111;
    border-radius: 8px;
    border: 1px solid #2a2a2a;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .tool {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-family: monospace;
    font-size: 0.85rem;
    color: #ccc;
    cursor: pointer;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    transition: background 0.1s;
  }
  .tool:hover { background: #222; }
  .tool input { accent-color: #4caf50; }
  .actions {
    display: flex;
    gap: 0.75rem;
  }
  button {
    flex: 1;
    padding: 0.65rem 1rem;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  button:hover { opacity: 0.85; }
  .approve { background: #2e7d32; color: #fff; }
  .deny { background: #333; color: #ccc; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorization Request</h1>
  <p><span class="client-name">${escapedName}</span> wants to connect to Platter.</p>
  ${errorHtml}
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="request_id" value="${requestId}">
    <div class="confirm">
      <label for="confirmation_code">Confirmation code</label>
      <p class="hint">Enter the code shown in your terminal or system tray</p>
      <input type="text" id="confirmation_code" name="confirmation_code" required
             autocomplete="off" spellcheck="false" maxlength="6"
             pattern="[A-Za-z0-9]{6}" autofocus>
    </div>
    <p>Grant access to:</p>
    <div class="tools">
      ${toolCheckboxes}
    </div>
    <div class="actions">
      <button type="submit" name="action" value="approve" class="approve">Approve</button>
      <button type="submit" name="action" value="deny" class="deny">Deny</button>
    </div>
  </form>
</div>
</body>
</html>`;
}

export function toolScope(tool: ToolName): string {
  return `tools:${tool}`;
}

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
};

function setSecurityHeaders(res: import("express").Response): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(k, v);
  }
}

/**
 * Reject cross-site requests to the consent POST. Uses Sec-Fetch-Site when
 * available (unforgeable in modern browsers), falls back to Origin header.
 * Returns true if the request was rejected.
 */
function rejectCrossSite(req: import("express").Request, res: import("express").Response): boolean {
  const fetchSite = req.headers["sec-fetch-site"] as string | undefined;
  if (fetchSite) {
    // "same-origin" and "none" (direct navigation) are allowed.
    // "cross-site" and "same-site" (different subdomain) are not.
    if (fetchSite !== "same-origin" && fetchSite !== "none") {
      res.status(403).json({ error: "Cross-site consent submissions are not allowed" });
      return true;
    }
    return false;
  }

  // Fallback: check Origin header. Present on cross-origin POSTs in all
  // modern browsers. If present and doesn't match Host, reject.
  const origin = req.headers.origin;
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const requestHost = req.headers.host;
      if (requestHost && originHost !== requestHost) {
        res.status(403).json({ error: "Cross-origin consent submissions are not allowed" });
        return true;
      }
    } catch {
      res.status(403).json({ error: "Invalid Origin header" });
      return true;
    }
  }

  return false;
}

export function installConsentRoutes(
  app: Express,
  provider: PlatterOAuthProvider,
  getEnabledTools: () => ToolName[],
): void {
  app.get("/oauth/consent", (req, res) => {
    const requestId = req.query.request_id;
    if (typeof requestId !== "string" || !requestId) {
      res.status(400).json({ error: "Missing request_id" });
      return;
    }

    const entry = provider.getPending(requestId);
    if (!entry) {
      res.status(404).json({ error: "Authorization request not found or expired" });
      return;
    }

    const clientName = entry.client.client_name || entry.client.client_id;
    const requestedScopes = new Set(entry.params.scopes ?? []);
    const enabledTools = getEnabledTools();

    // Build tool info: each globally-enabled tool gets a checkbox.
    // Pre-checked if: client requested this scope, or client requested no
    // specific scopes (default = all).
    const tools: ToolInfo[] = enabledTools.map((name) => ({
      name,
      scope: toolScope(name),
      checked: requestedScopes.size === 0 || requestedScopes.has(toolScope(name)),
    }));

    const error = req.query.error;
    const errorMsg =
      error === "invalid_code"
        ? "Invalid confirmation code. Check your terminal or system tray and try again."
        : error === "too_many_attempts"
          ? "Too many failed attempts. Please start a new authorization request."
          : undefined;

    setSecurityHeaders(res);
    res.type("html").send(consentPageHtml(requestId, clientName, tools, errorMsg));
  });

  app.post("/oauth/consent", express.urlencoded({ extended: false }), (req, res) => {
    setSecurityHeaders(res);

    if (rejectCrossSite(req, res)) return;

    const requestId = req.body?.request_id;
    const action = req.body?.action;

    if (typeof requestId !== "string" || !requestId) {
      res.status(400).json({ error: "Missing request_id" });
      return;
    }

    try {
      if (action === "approve") {
        const confirmationCode = req.body?.confirmation_code;
        if (typeof confirmationCode !== "string" || !confirmationCode) {
          res.redirect(`/oauth/consent?request_id=${encodeURIComponent(requestId)}&error=invalid_code`);
          return;
        }

        // Collect granted scopes from checked checkboxes and filter to
        // only those corresponding to currently-enabled tools.
        const enabledScopes = new Set(getEnabledTools().map(toolScope));
        const raw = req.body?.scope;
        const rawScopes: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
        const grantedScopes = rawScopes.filter((s) => enabledScopes.has(s));

        const redirectUrl = provider.approveAuthorization(requestId, confirmationCode, grantedScopes);
        res.redirect(redirectUrl);
      } else {
        const redirectUrl = provider.denyAuthorization(requestId);
        res.redirect(redirectUrl);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "Invalid confirmation code") {
        res.redirect(`/oauth/consent?request_id=${encodeURIComponent(requestId)}&error=invalid_code`);
      } else if (msg === "Too many failed attempts") {
        res.redirect(`/oauth/consent?request_id=${encodeURIComponent(requestId)}&error=too_many_attempts`);
      } else {
        res.status(404).json({ error: "Authorization request not found or expired" });
      }
    }
  });
}
