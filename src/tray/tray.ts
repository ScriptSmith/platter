import { execSync, spawn } from "node:child_process";
import dbus from "dbus-next";
import packageJson from "../../package.json";
import { getConfigDir, getConfigPath, getLogPath, type PlatterConfig, saveConfig } from "../config.js";
import { ALL_TOOL_NAMES, type SecurityConfig, setToolEnabled, type ToolName } from "../security.js";
import { copyToClipboard } from "./clipboard.js";
import { DBusMenu, type MenuItem } from "./dbus-menu.js";
import type { HttpController } from "./http-controller.js";
import { saveToKeyring } from "./keyring.js";
import { StatusNotifierItem } from "./sni.js";

const MENU_PATH = "/MenuBar";

const WEBAPP_URL = "https://app.hadriangateway.com";

const TOOL_LABELS: Record<ToolName, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  bash: "bash",
  glob: "glob",
  grep: "grep",
  js: "js",
};

// Menu item IDs — static so we can refresh them by id without a lookup.
const ID = {
  root: 0,
  status: 1,
  copyUrl: 12,
  copyToken: 10,
  regenToken: 11,
  toolsSubmenu: 20,
  toolBase: 100, // tool ids are 100 + index
  start: 30,
  stop: 31,
  restart: 32,
  openWebApp: 13,
  openConfig: 40,
  openLog: 41,
  about: 42,
  quit: 43,
} as const;

function toolId(tool: ToolName): number {
  return ID.toolBase + ALL_TOOL_NAMES.indexOf(tool);
}

export interface RunTrayOptions {
  http: HttpController;
  security: SecurityConfig;
  config: PlatterConfig;
  oauthProvider?: import("../oauth/provider.js").PlatterOAuthProvider;
  onQuit: () => Promise<void> | void;
}

export async function runTray(opts: RunTrayOptions): Promise<{ dispose: () => Promise<void> }> {
  const { http, security, config, onQuit } = opts;

  const menu = buildMenu(http, security, config);
  const dbusMenu = new DBusMenu(menu);
  const sni = new StatusNotifierItem({
    title: "Platter",
    tooltipTitle: "Platter",
    tooltipText: http.url(),
    menuPath: MENU_PATH,
  });

  const bus = dbus.sessionBus();
  bus.export(MENU_PATH, dbusMenu);
  const uniqueName = await sni.register(bus);

  // Wire the HTTP controller's tool-change hook so toggles initiated
  // elsewhere (e.g. future admin API) also refresh the menu.
  const prevHook = security.onToolsChanged;
  security.onToolsChanged = (tool, enabled) => {
    prevHook?.(tool, enabled);
    refreshToolCheckboxes(dbusMenu, security);
  };

  // Wire menu actions -------------------------------------------------------

  const handlers = buildHandlers({
    http,
    security,
    config,
    menu: dbusMenu,
    sni,
    onQuit: async () => {
      await sni.unregister(bus, uniqueName);
      try {
        bus.disconnect();
      } catch {
        // ignore
      }
      await onQuit();
    },
  });

  attachHandlers(menu, handlers);
  // Rebuild the index so the DBusMenu knows about the attached onClicked refs.
  dbusMenu.refreshLayout();

  // Expose a way to update the status header whenever HTTP state changes.
  const refreshStatus = () => {
    updateStatus(menu, http, dbusMenu);
    sni.setTitle("Platter", "Platter", http.isRunning() ? http.url() : "stopped");
  };

  // Poll HTTP state to keep Start/Stop enabled-ness in sync. Cheap — just
  // reads a boolean and maybe emits a property-change signal.
  let lastRunning = http.isRunning();
  const pollHandle = setInterval(() => {
    const running = http.isRunning();
    if (running !== lastRunning) {
      lastRunning = running;
      refreshStatus();
      refreshLifecycleButtons(menu, http, dbusMenu);
    }
  }, 1000);
  pollHandle.unref();

  refreshStatus();
  refreshLifecycleButtons(menu, http, dbusMenu);

  // When an OAuth authorization request arrives, notify the user via the
  // desktop notification system. The browser-based client that initiated
  // the flow is already being redirected to the consent page, so we do NOT
  // auto-open a second window here — that would cause a duplicate tab.
  const oauthProvider = opts.oauthProvider;
  if (oauthProvider) {
    oauthProvider.on("pending", ({ clientName }: { clientName: string }) => {
      notify("Authorization request", `${clientName} wants to connect to Platter`);
    });
  }

  return {
    dispose: async () => {
      clearInterval(pollHandle);
      await sni.unregister(bus, uniqueName);
      try {
        bus.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

// ---- Menu tree construction -------------------------------------------------

function buildMenu(http: HttpController, security: SecurityConfig, _config: PlatterConfig): MenuItem {
  const toolItems: MenuItem[] = ALL_TOOL_NAMES.map((name) => ({
    id: toolId(name),
    label: TOOL_LABELS[name],
    toggleType: "checkmark",
    toggleState: isToolOn(security, name) ? 1 : 0,
  }));

  return {
    id: ID.root,
    children: [
      {
        id: ID.status,
        label: http.isRunning() ? `● Running · ${http.url()}` : "○ Stopped",
        enabled: false,
      },
      { id: 2, type: "separator" },
      { id: ID.openWebApp, label: "Open Hadrian Gateway" },
      { id: 6, type: "separator" },
      { id: ID.copyUrl, label: "Copy URL", enabled: http.isRunning() },
      { id: ID.copyToken, label: "Copy auth token" },
      { id: ID.regenToken, label: "Regenerate auth token" },
      { id: 3, type: "separator" },
      {
        id: ID.toolsSubmenu,
        label: "Tools",
        children: toolItems,
      },
      { id: 4, type: "separator" },
      { id: ID.start, label: "Start", enabled: !http.isRunning() },
      { id: ID.stop, label: "Stop", enabled: http.isRunning() },
      { id: ID.restart, label: "Restart" },
      { id: 5, type: "separator" },
      { id: ID.openConfig, label: "Open config folder" },
      { id: ID.openLog, label: "Open log file" },
      { id: ID.about, label: `About Platter ${packageJson.version}`, enabled: false },
      { id: ID.quit, label: "Quit" },
    ],
  };
}

function isToolOn(security: SecurityConfig, tool: ToolName): boolean {
  return !security.allowedTools || security.allowedTools.has(tool);
}

function walk(item: MenuItem, fn: (item: MenuItem) => void): void {
  fn(item);
  if (item.children) {
    for (const child of item.children) walk(child, fn);
  }
}

// ---- Handler wiring ---------------------------------------------------------

interface HandlerContext {
  http: HttpController;
  security: SecurityConfig;
  config: PlatterConfig;
  menu: DBusMenu;
  sni: StatusNotifierItem;
  onQuit: () => Promise<void>;
}

function buildHandlers(ctx: HandlerContext): Map<number, () => void | Promise<void>> {
  const h = new Map<number, () => void | Promise<void>>();

  h.set(ID.copyUrl, async () => {
    try {
      await copyToClipboard(ctx.http.url());
      notify("URL copied", ctx.http.url());
    } catch (err: any) {
      notify("Clipboard failed", err?.message ?? String(err));
    }
  });

  h.set(ID.copyToken, async () => {
    const token = ctx.http.getAuthToken();
    if (!token) {
      notify("Auth disabled", "Platter is running without a bearer token.");
      return;
    }
    try {
      await copyToClipboard(token);
      notify("Auth token copied", "The Platter bearer token is on your clipboard.");
    } catch (err: any) {
      notify("Clipboard failed", err?.message ?? String(err));
    }
  });

  h.set(ID.regenToken, async () => {
    const token = ctx.http.regenerateAuthToken();
    try {
      await saveToKeyring(token);
      delete ctx.config.authToken;
    } catch {
      // Keyring unavailable — fall back to config file.
      ctx.config.authToken = token;
    }
    saveConfig(ctx.config);
    try {
      await copyToClipboard(token);
      notify("New auth token", "A fresh token was generated and copied to your clipboard.");
    } catch {
      notify("New auth token", "Token regenerated. Copy it from the tray menu.");
    }
  });

  h.set(ID.start, async () => {
    try {
      await ctx.http.start();
      notify("Platter started", ctx.http.url());
    } catch (err: any) {
      notify("Start failed", err?.message ?? String(err));
    }
  });

  h.set(ID.stop, async () => {
    try {
      await ctx.http.stop();
      notify("Platter stopped", "");
    } catch (err: any) {
      notify("Stop failed", err?.message ?? String(err));
    }
  });

  h.set(ID.restart, async () => {
    try {
      await ctx.http.restart();
      notify("Platter restarted", ctx.http.url());
    } catch (err: any) {
      notify("Restart failed", err?.message ?? String(err));
    }
  });

  h.set(ID.openWebApp, () => {
    openWebApp();
  });

  h.set(ID.openConfig, () => {
    xdgOpen(getConfigDir());
  });

  h.set(ID.openLog, () => {
    xdgOpen(getLogPath());
  });

  h.set(ID.quit, async () => {
    await ctx.onQuit();
    process.exit(0);
  });

  for (const tool of ALL_TOOL_NAMES) {
    h.set(toolId(tool), () => {
      const currentlyOn = isToolOn(ctx.security, tool);
      setToolEnabled(ctx.security, tool, !currentlyOn);
      ctx.config.enabledTools = [...(ctx.security.allowedTools ?? new Set(ALL_TOOL_NAMES))];
      saveConfig(ctx.config);
      refreshToolCheckboxes(ctx.menu, ctx.security);
    });
  }

  return h;
}

function attachHandlers(root: MenuItem, handlers: Map<number, () => void | Promise<void>>): void {
  walk(root, (item) => {
    const handler = handlers.get(item.id);
    if (handler) {
      item.onClicked = () => {
        const result = handler();
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            console.error("[tray] handler error:", err);
          });
        }
      };
    }
  });
}

// ---- Live refresh helpers ---------------------------------------------------

function refreshToolCheckboxes(dbusMenu: DBusMenu, security: SecurityConfig): void {
  const root = (dbusMenu as unknown as { root: MenuItem }).root ?? null;
  // The root isn't exposed; instead iterate the known tool ids and patch
  // via the public refreshProperties helper.
  const patched: number[] = [];
  for (const tool of ALL_TOOL_NAMES) {
    const id = toolId(tool);
    const item = findById(dbusMenu, id);
    if (!item) continue;
    item.toggleState = isToolOn(security, tool) ? 1 : 0;
    patched.push(id);
  }
  if (patched.length > 0) {
    dbusMenu.refreshProperties(patched, ["toggle-state"]);
  }
  void root;
}

function refreshLifecycleButtons(_root: MenuItem, http: HttpController, dbusMenu: DBusMenu): void {
  const start = findById(dbusMenu, ID.start);
  const stop = findById(dbusMenu, ID.stop);
  const copyUrl = findById(dbusMenu, ID.copyUrl);
  if (start) start.enabled = !http.isRunning();
  if (stop) stop.enabled = http.isRunning();
  if (copyUrl) copyUrl.enabled = http.isRunning();
  dbusMenu.refreshProperties([ID.start, ID.stop, ID.copyUrl], ["enabled"]);
}

function updateStatus(_root: MenuItem, http: HttpController, dbusMenu: DBusMenu): void {
  const status = findById(dbusMenu, ID.status);
  if (!status) return;
  status.label = http.isRunning() ? `● Running · ${http.url()}` : "○ Stopped";
  dbusMenu.refreshProperties([ID.status], ["label"]);
}

function findById(dbusMenu: DBusMenu, id: number): MenuItem | undefined {
  // DBusMenu keeps a private `index` map. Reach in for direct access — the
  // tray is the sole owner of the menu tree so this is safe.
  const index = (dbusMenu as unknown as { index: Map<number, MenuItem> }).index;
  return index?.get(id);
}

// ---- Desktop notifications / xdg-open --------------------------------------

function notify(title: string, body: string): void {
  const child = spawn("notify-send", ["--app-name=Platter", title, body], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {
    console.error(`[tray] ${title}${body ? ` — ${body}` : ""}`);
  });
  child.unref();
}

function xdgOpen(target: string): void {
  const child = spawn("xdg-open", [target], { stdio: "ignore", detached: true });
  child.on("error", (err) => {
    console.error(`[tray] xdg-open ${target} failed:`, err.message);
  });
  child.unref();
}

/** Browser candidates that support `--app=<url>` for a chromeless window. */
const APP_BROWSERS = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

const WEBAPP_WIDTH = 1280;
const WEBAPP_HEIGHT = 800;

function openWebApp(): void {
  tryAppBrowser(0);
}

function getScreenCenter(): { x: number; y: number } | null {
  try {
    const output = execSync("xrandr 2>/dev/null", { encoding: "utf8" });
    const match = output.match(/(\d+)x(\d+)\+0\+0/);
    if (match) {
      const screenW = Number(match[1]);
      const screenH = Number(match[2]);
      return { x: Math.round((screenW - WEBAPP_WIDTH) / 2), y: Math.round((screenH - WEBAPP_HEIGHT) / 2) };
    }
  } catch {}
  return null;
}

function tryAppBrowser(index: number): void {
  if (index >= APP_BROWSERS.length) {
    // No app-mode browser found — fall back to xdg-open.
    xdgOpen(WEBAPP_URL);
    return;
  }

  const browser = APP_BROWSERS[index];
  const args = [`--app=${WEBAPP_URL}`, `--window-size=${WEBAPP_WIDTH},${WEBAPP_HEIGHT}`, "--ozone-platform=x11"];
  const center = getScreenCenter();
  if (center) {
    args.push(`--window-position=${center.x},${center.y}`);
  }
  const child = spawn(browser, args, { stdio: "ignore", detached: true });
  child.on("error", () => tryAppBrowser(index + 1));
  child.unref();
}

// Kept for the unused-imports check — they're re-exported so consumers don't
// have to import from the root config module just to know where state lives.
export { getConfigPath, getLogPath };
