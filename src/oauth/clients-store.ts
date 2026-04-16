import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ensureConfigDir, getClientsPath } from "../config.js";

/**
 * Persists registered OAuth clients to ~/.config/platter/clients.json.
 * Loaded into memory on construction; written back on every registration.
 */
export class PlatterClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  constructor() {
    this.load();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    this.clients.set(client.client_id, client);
    this.persist();
    return client;
  }

  private load(): void {
    const path = getClientsPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      if (!Array.isArray(raw)) return;
      for (const entry of raw) {
        if (typeof entry?.client_id === "string") {
          this.clients.set(entry.client_id, entry);
        }
      }
    } catch {
      // Corrupt file — start fresh.
    }
  }

  private persist(): void {
    ensureConfigDir();
    const path = getClientsPath();
    const tmp = `${path}.tmp`;
    const data = JSON.stringify([...this.clients.values()], null, 2);
    writeFileSync(tmp, `${data}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }
}
