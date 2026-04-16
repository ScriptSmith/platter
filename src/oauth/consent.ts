import type { Express } from "express";
import express from "express";
import type { PlatterOAuthProvider } from "./provider.js";

function consentPageHtml(requestId: string, clientName: string, scopes: string[]): string {
  const escapedName = clientName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const scopeList =
    scopes.length > 0
      ? scopes.map((s) => `<li>${s.replace(/</g, "&lt;")}</li>`).join("")
      : "<li><em>default access</em></li>";

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
  ul {
    list-style: none;
    margin-bottom: 1.5rem;
    padding: 0.75rem 1rem;
    background: #111;
    border-radius: 8px;
    border: 1px solid #2a2a2a;
  }
  li {
    padding: 0.25rem 0;
    font-family: monospace;
    font-size: 0.85rem;
    color: #ccc;
  }
  li::before { content: "\\2022  "; color: #555; }
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
  <p>Requested permissions:</p>
  <ul>${scopeList}</ul>
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="request_id" value="${requestId}">
    <div class="actions">
      <button type="submit" name="action" value="approve" class="approve" autofocus>Approve</button>
      <button type="submit" name="action" value="deny" class="deny">Deny</button>
    </div>
  </form>
</div>
</body>
</html>`;
}

export function installConsentRoutes(app: Express, provider: PlatterOAuthProvider): void {
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
    const scopes = entry.params.scopes ?? [];
    res.type("html").send(consentPageHtml(requestId, clientName, scopes));
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
        const redirectUrl = provider.approveAuthorization(requestId);
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
