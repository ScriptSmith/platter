import type { Express } from "express";
import express from "express";
import type { ToolName } from "../security.js";
import type { PlatterOAuthProvider } from "./provider.js";

interface ToolInfo {
  name: ToolName;
  scope: string;
  checked: boolean;
}

function consentPageHtml(requestId: string, clientName: string, tools: ToolInfo[]): string {
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
  <p>Grant access to:</p>
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="request_id" value="${requestId}">
    <div class="tools">
      ${toolCheckboxes}
    </div>
    <div class="actions">
      <button type="submit" name="action" value="approve" class="approve" autofocus>Approve</button>
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

    res.type("html").send(consentPageHtml(requestId, clientName, tools));
  });

  app.post("/oauth/consent", express.urlencoded({ extended: false }), (req, res) => {
    const requestId = req.body?.request_id;
    const action = req.body?.action;

    if (typeof requestId !== "string" || !requestId) {
      res.status(400).json({ error: "Missing request_id" });
      return;
    }

    try {
      if (action === "approve") {
        // Collect granted scopes from checked checkboxes.
        const raw = req.body?.scope;
        const grantedScopes: string[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
        const redirectUrl = provider.approveAuthorization(requestId, grantedScopes);
        res.redirect(redirectUrl);
      } else {
        const redirectUrl = provider.denyAuthorization(requestId);
        res.redirect(redirectUrl);
      }
    } catch {
      res.status(404).json({ error: "Authorization request not found or expired" });
    }
  });
}
