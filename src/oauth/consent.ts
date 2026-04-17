import type { Express } from "express";
import express from "express";
import type { SandboxConfig, SandboxFsMode, ToolName } from "../security.js";
import type { ClientGrant, PlatterOAuthProvider } from "./provider.js";

/**
 * Snapshot of the global CLI-configured restrictions, passed into the
 * consent page so the form can pre-fill from them and explain which
 * narrowings a per-client grant is forced to obey.
 */
export interface GlobalRestrictions {
  enabledTools: ToolName[];
  allowedPaths?: string[];
  allowedCommands?: string[];
  sandbox?: SandboxConfig;
}

interface ToolInfo {
  name: ToolName;
  scope: string;
  checked: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitLines(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function consentPageHtml(
  requestId: string,
  clientName: string,
  tools: ToolInfo[],
  global: GlobalRestrictions,
  error?: string,
): string {
  const escapedName = escapeHtml(clientName);

  const toolCheckboxes = tools
    .map(
      (t) =>
        `<label class="tool">
        <input type="checkbox" name="scope" value="${t.scope}"${t.checked ? " checked" : ""}>
        <span>${t.name}</span>
      </label>`,
    )
    .join("\n      ");

  const jsEnabled = tools.some((t) => t.name === "js");
  const bashEnabled = tools.some((t) => t.name === "bash");
  const dangerousToolsWarning =
    jsEnabled || bashEnabled
      ? `<p class="warn">⚠ ${
          jsEnabled && bashEnabled
            ? "<code>bash</code> and <code>js</code> can execute arbitrary code."
            : jsEnabled
              ? "<code>js</code> can execute arbitrary code."
              : "<code>bash</code> can execute arbitrary code."
        }${
          jsEnabled
            ? ` <code>js</code> runs in a Node.js <code>vm</code> context — <strong>not a security sandbox</strong>. It has unrestricted <code>fetch</code> (network) access and is not limited by the path, command, or sandbox settings below.`
            : ""
        }</p>`
      : "";

  const errorHtml = error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : "";

  const pathScopeNote = `Applies to <code>read</code>, <code>write</code>, <code>edit</code>, <code>glob</code>, <code>grep</code>. Does not restrict <code>bash</code> or <code>js</code>.`;
  const pathsHint = global.allowedPaths?.length
    ? `<p class="hint">Server restricts paths to: ${global.allowedPaths.map(escapeHtml).join(", ")}. ${pathScopeNote}</p>`
    : `<p class="hint">Leave empty for unrestricted. One absolute path per line. ${pathScopeNote}</p>`;
  const pathsPrefill = global.allowedPaths?.length ? escapeHtml(global.allowedPaths.join("\n")) : "";

  const commandScopeNote = `Applies to <code>bash</code> only; does not restrict <code>js</code>.`;
  const commandsHint = global.allowedCommands?.length
    ? `<p class="hint">Server restricts commands to: <code>${global.allowedCommands.map(escapeHtml).join("</code>, <code>")}</code>. ${commandScopeNote}</p>`
    : `<p class="hint">Leave empty for unrestricted. One regex per line; patterns must match the entire command. ${commandScopeNote}</p>`;
  const commandsPrefill = global.allowedCommands?.length ? escapeHtml(global.allowedCommands.join("\n")) : "";

  const sandboxGloballyOn = global.sandbox?.enabled === true;
  const sandboxCheckedAttr = sandboxGloballyOn ? " checked disabled" : "";
  const sandboxHiddenForced = sandboxGloballyOn ? '<input type="hidden" name="sandbox_enabled" value="1">' : "";
  const sandboxLockedNote = sandboxGloballyOn
    ? `<p class="hint">Server forces sandbox on. Mode and URLs below are ignored.</p>`
    : "";

  const fsModes: SandboxFsMode[] = ["memory", "overlay", "readwrite"];
  const currentFsMode = global.sandbox?.fsMode ?? "readwrite";
  const sandboxFsOptions = fsModes
    .map((mode) => `<option value="${mode}"${mode === currentFsMode ? " selected" : ""}>${mode}</option>`)
    .join("");

  const sandboxUrlsPrefill = global.sandbox?.allowedUrls?.length
    ? escapeHtml(global.sandbox.allowedUrls.join("\n"))
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
    align-items: flex-start;
    min-height: 100vh;
    padding: 2rem 1rem;
  }
  .card {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 2rem;
    max-width: 480px;
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
  p { color: #aaa; margin-bottom: 0.5rem; font-size: 0.9rem; }
  .section { margin-bottom: 1.25rem; }
  .section > label.title {
    display: block;
    font-size: 0.85rem;
    font-weight: 500;
    margin-bottom: 0.25rem;
    color: #ccc;
  }
  .hint {
    font-size: 0.78rem;
    color: #888;
    margin-bottom: 0.4rem;
  }
  .hint code {
    background: #111;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    border: 1px solid #2a2a2a;
    font-size: 0.78rem;
  }
  .confirm input[type=text], textarea, select {
    width: 100%;
    padding: 0.55rem 0.75rem;
    background: #111;
    border: 1px solid #444;
    border-radius: 6px;
    color: #fff;
    font-family: monospace;
    font-size: 0.85rem;
  }
  .confirm input[type=text] {
    font-size: 1.1rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    text-align: center;
  }
  textarea {
    min-height: 4.5rem;
    resize: vertical;
  }
  .confirm input:focus, textarea:focus, select:focus {
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
  .warn {
    background: #3a2e1c;
    border: 1px solid #6b5a2c;
    color: #f5d98a;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.78rem;
    margin-top: 0.5rem;
    line-height: 1.4;
  }
  .warn code {
    background: #111;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    border: 1px solid #2a2a2a;
    font-size: 0.75rem;
  }
  .warn strong { color: #ffcc66; }
  .tools {
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
  .sandbox-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    font-size: 0.9rem;
    color: #ccc;
  }
  .sandbox-row input[type=checkbox] { accent-color: #4caf50; }
  .sandbox-details {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.5rem;
  }
  .sandbox-details select { width: auto; }
  .actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
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
    <div class="section confirm">
      <label class="title" for="confirmation_code">Confirmation code</label>
      <p class="hint">Enter the code shown in your terminal or system tray.</p>
      <input type="text" id="confirmation_code" name="confirmation_code" required
             autocomplete="off" spellcheck="false" maxlength="6"
             pattern="[A-Za-z0-9]{6}" autofocus>
    </div>

    <div class="section">
      <label class="title">Grant access to tools</label>
      <div class="tools">
      ${toolCheckboxes}
      </div>
      ${dangerousToolsWarning}
    </div>

    <div class="section">
      <label class="title" for="allowed_paths">Restrict file access to paths</label>
      ${pathsHint}
      <textarea id="allowed_paths" name="allowed_paths" spellcheck="false" autocomplete="off">${pathsPrefill}</textarea>
    </div>

    <div class="section">
      <label class="title" for="allowed_commands">Allow bash commands matching</label>
      ${commandsHint}
      <textarea id="allowed_commands" name="allowed_commands" spellcheck="false" autocomplete="off">${commandsPrefill}</textarea>
    </div>

    <div class="section">
      <label class="title">Sandbox (<code>bash</code> only)</label>
      <p class="hint">Runs bash in a TypeScript-reimplemented shell with a virtual filesystem. Does not affect <code>js</code>, which is never sandboxed.</p>
      ${sandboxLockedNote}
      <div class="sandbox-row">
        <input type="checkbox" id="sandbox_enabled" name="sandbox_enabled" value="1"${sandboxCheckedAttr}>
        <label for="sandbox_enabled">Enable sandbox (just-bash)</label>
        ${sandboxHiddenForced}
      </div>
      <div class="sandbox-details">
        <label for="sandbox_fs_mode">Mode</label>
        <select id="sandbox_fs_mode" name="sandbox_fs_mode">${sandboxFsOptions}</select>
        <label for="sandbox_allowed_urls">Allowed URLs</label>
        <textarea id="sandbox_allowed_urls" name="sandbox_allowed_urls" spellcheck="false" autocomplete="off" placeholder="One URL prefix per line">${sandboxUrlsPrefill}</textarea>
      </div>
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
  getGlobalRestrictions: () => GlobalRestrictions,
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
    const global = getGlobalRestrictions();

    // Build tool info: each globally-enabled tool gets a checkbox.
    // Pre-checked if: client requested this scope, or client requested no
    // specific scopes (default = all).
    const tools: ToolInfo[] = global.enabledTools.map((name) => ({
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
          : error === "invalid_regex"
            ? "One or more command patterns are invalid regex."
            : undefined;

    setSecurityHeaders(res);
    res.type("html").send(consentPageHtml(requestId, clientName, tools, global, errorMsg));
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

        const global = getGlobalRestrictions();

        // Tools: keep only checked scopes that correspond to currently-enabled tools.
        const enabledByScope = new Map(global.enabledTools.map((t) => [toolScope(t), t] as const));
        const raw = req.body?.scope;
        const rawScopes: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
        const grantTools: ToolName[] = [];
        for (const s of rawScopes) {
          const t = enabledByScope.get(s);
          if (t && !grantTools.includes(t)) grantTools.push(t);
        }

        const allowedPaths = splitLines(req.body?.allowed_paths);
        const allowedCommands = splitLines(req.body?.allowed_commands);

        // Reject invalid regex up front so the user sees the form again.
        for (const pat of allowedCommands) {
          try {
            new RegExp(pat);
          } catch {
            res.redirect(`/oauth/consent?request_id=${encodeURIComponent(requestId)}&error=invalid_regex`);
            return;
          }
        }

        // Sandbox: if the server forces it on, ignore the client form and
        // let buildSessionSecurity fall back to the global config.
        const globallyForcedSandbox = global.sandbox?.enabled === true;
        const sandboxChecked = req.body?.sandbox_enabled === "1" || req.body?.sandbox_enabled === "on";
        let sandboxGrant: ClientGrant["sandbox"] | undefined;
        if (!globallyForcedSandbox && sandboxChecked) {
          const fsMode = req.body?.sandbox_fs_mode;
          const validFs: SandboxFsMode[] = ["memory", "overlay", "readwrite"];
          const chosenFs: SandboxFsMode = validFs.includes(fsMode) ? fsMode : "readwrite";
          const allowedUrls = splitLines(req.body?.sandbox_allowed_urls);
          sandboxGrant = {
            enabled: true,
            fsMode: chosenFs,
            allowedUrls: allowedUrls.length ? allowedUrls : undefined,
          };
        }

        const grant: ClientGrant = {
          tools: grantTools,
          allowedPaths: allowedPaths.length ? allowedPaths : undefined,
          allowedCommands: allowedCommands.length ? allowedCommands : undefined,
          sandbox: sandboxGrant,
        };

        const redirectUrl = provider.approveAuthorization(requestId, confirmationCode, grant);
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
