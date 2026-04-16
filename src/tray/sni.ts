import dbus, { Message, type MessageBus } from "dbus-next";
import { type Argb32Pixmap, buildRasterizedPixmaps } from "./icon-data.js";

const { Interface } = dbus.interface;

const WATCHER_SERVICE = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";
const WATCHER_IFACE = "org.kde.StatusNotifierWatcher";
const ITEM_IFACE = "org.kde.StatusNotifierItem";
const ITEM_PATH = "/StatusNotifierItem";

/**
 * org.kde.StatusNotifierItem service.
 *
 * Callers mutate `title`, `tooltip`, `status`, and `menuPath`, then call
 * `refresh()` to emit the matching NewTitle / NewToolTip / NewStatus signals
 * so panels update. `register(bus)` requests the well-known name and
 * registers with the session's StatusNotifierWatcher.
 */
export class StatusNotifierItem extends Interface {
  public title: string;
  public tooltipTitle: string;
  public tooltipText: string;
  public status: "Active" | "Passive" | "NeedsAttention";
  public menuPath: string;
  public iconNameValue: string;
  public iconThemePathValue: string;
  private pixmaps: Argb32Pixmap[];
  private registeredUniqueName: string | null = null;
  private watcherListenerCleanup: (() => void) | null = null;

  constructor(opts: { title: string; tooltipTitle?: string; tooltipText?: string; menuPath?: string }) {
    super(ITEM_IFACE);
    this.title = opts.title;
    this.tooltipTitle = opts.tooltipTitle ?? opts.title;
    this.tooltipText = opts.tooltipText ?? "";
    this.status = "Active";
    this.menuPath = opts.menuPath ?? "/MenuBar";
    // Don't advertise IconName — the SVG uses `currentColor` which renders
    // dark on dark panels. Rely entirely on IconPixmap (white-on-transparent
    // rasterized bitmaps at multiple sizes) for the tray. The .desktop file
    // still uses `Icon=platter` for the app launcher where the theme colours
    // the SVG correctly.
    this.iconNameValue = "";
    this.iconThemePathValue = "";
    this.pixmaps = buildRasterizedPixmaps();
  }

  // --- Read-only properties ------------------------------------------------

  get Category(): string {
    return "ApplicationStatus";
  }

  get Id(): string {
    return "platter";
  }

  get Title(): string {
    return this.title;
  }

  get Status(): string {
    return this.status;
  }

  get WindowId(): number {
    return 0;
  }

  get IconName(): string {
    return this.iconNameValue;
  }

  get IconThemePath(): string {
    return this.iconThemePathValue;
  }

  get IconPixmap(): Array<[number, number, Buffer]> {
    return this.pixmaps.map((p) => [p.width, p.height, p.data]);
  }

  get OverlayIconName(): string {
    return "";
  }

  get OverlayIconPixmap(): Array<[number, number, Buffer]> {
    return [];
  }

  get AttentionIconName(): string {
    return "";
  }

  get AttentionIconPixmap(): Array<[number, number, Buffer]> {
    return [];
  }

  get AttentionMovieName(): string {
    return "";
  }

  get ToolTip(): [string, Array<[number, number, Buffer]>, string, string] {
    return [
      this.iconNameValue,
      this.pixmaps.map((p) => [p.width, p.height, p.data]),
      this.tooltipTitle,
      this.tooltipText,
    ];
  }

  get ItemIsMenu(): boolean {
    return true;
  }

  get Menu(): string {
    return this.menuPath;
  }

  // --- Methods (left-click, middle-click, scroll) --------------------------

  Activate(_x: number, _y: number): void {
    // Left click: let the menu handle it via right-click / ContextMenu.
  }

  SecondaryActivate(_x: number, _y: number): void {}

  ContextMenu(_x: number, _y: number): void {}

  Scroll(_delta: number, _orientation: string): void {}

  // --- Signals -------------------------------------------------------------

  NewTitle(): void {}

  NewIcon(): void {}

  NewAttentionIcon(): void {}

  NewOverlayIcon(): void {}

  NewToolTip(): void {}

  NewStatus(status: string): string {
    return status;
  }

  // --- Mutation helpers ----------------------------------------------------

  setTitle(title: string, tooltipTitle?: string, tooltipText?: string): void {
    this.title = title;
    if (tooltipTitle !== undefined) this.tooltipTitle = tooltipTitle;
    if (tooltipText !== undefined) this.tooltipText = tooltipText;
    this.NewTitle();
    this.NewToolTip();
  }

  setStatus(status: "Active" | "Passive" | "NeedsAttention"): void {
    this.status = status;
    this.NewStatus(status);
  }

  /**
   * Request the well-known unique name, export on `/StatusNotifierItem`, and
   * register with the StatusNotifierWatcher. Returns the unique name used.
   *
   * Uses `bus.call()` directly instead of `getProxyObject()` because the
   * latter does a blocking `Introspect` round-trip first, which on some
   * watcher implementations (notably the GNOME AppIndicator extension) can
   * fail with `org.freedesktop.DBus.Error.NotSupported` or return no
   * introspection XML — leading the client to think the name isn't owned
   * when in fact it is.
   */
  async register(bus: MessageBus): Promise<string> {
    const uniqueName = `org.kde.StatusNotifierItem-${process.pid}-1`;
    await bus.requestName(uniqueName, 0);
    bus.export(ITEM_PATH, this);
    this.registeredUniqueName = uniqueName;

    const ok = await tryRegisterWithWatcher(bus, uniqueName);
    if (!ok) {
      console.error(
        "[tray] No StatusNotifierWatcher on the session bus. On GNOME, install the " +
          "'AppIndicator and KStatusNotifierItem Support' extension: " +
          "https://extensions.gnome.org/extension/615/appindicator-support/ — " +
          "Platter will auto-attach once it's enabled.",
      );
      this.watchForWatcher(bus);
    }

    return uniqueName;
  }

  /**
   * Subscribe to NameOwnerChanged on the DBus daemon. When
   * `org.kde.StatusNotifierWatcher` acquires an owner (e.g. the user enables
   * a tray extension), retry registration automatically.
   */
  private watchForWatcher(bus: MessageBus): void {
    const uniqueName = this.registeredUniqueName;
    if (!uniqueName) return;

    const match =
      "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus'," +
      "member='NameOwnerChanged',arg0='org.kde.StatusNotifierWatcher'";

    const addMatch = new Message({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "AddMatch",
      signature: "s",
      body: [match],
    });

    bus.call(addMatch).catch(() => {
      // best-effort — if AddMatch itself fails, we just won't auto-recover
    });

    const onMessage = (msg: Message) => {
      if (
        msg.interface !== "org.freedesktop.DBus" ||
        msg.member !== "NameOwnerChanged" ||
        !Array.isArray(msg.body) ||
        msg.body[0] !== "org.kde.StatusNotifierWatcher"
      ) {
        return;
      }
      const newOwner = msg.body[2];
      if (typeof newOwner !== "string" || newOwner.length === 0) return;

      tryRegisterWithWatcher(bus, uniqueName).then((ok) => {
        if (ok) {
          console.error("[tray] StatusNotifierWatcher appeared — Platter icon registered.");
          this.cleanupWatcherListener(bus);
        }
      });
    };

    bus.on("message", onMessage);
    this.watcherListenerCleanup = () => {
      bus.off("message", onMessage);
      const removeMatch = new Message({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "RemoveMatch",
        signature: "s",
        body: [match],
      });
      bus.call(removeMatch).catch(() => {});
    };
  }

  private cleanupWatcherListener(_bus: MessageBus): void {
    if (this.watcherListenerCleanup) {
      this.watcherListenerCleanup();
      this.watcherListenerCleanup = null;
    }
  }

  async unregister(bus: MessageBus, uniqueName: string): Promise<void> {
    try {
      this.cleanupWatcherListener(bus);
      bus.unexport(ITEM_PATH, this);
      await bus.releaseName(uniqueName);
    } catch {
      // best-effort on shutdown
    }
  }
}

/**
 * Send RegisterStatusNotifierItem directly without introspection.
 * Returns true on success, false on any DBus error (usually
 * `ServiceUnknown` / `NameHasNoOwner` when no watcher is running).
 */
async function tryRegisterWithWatcher(bus: MessageBus, uniqueName: string): Promise<boolean> {
  try {
    const msg = new Message({
      destination: WATCHER_SERVICE,
      path: WATCHER_PATH,
      interface: WATCHER_IFACE,
      member: "RegisterStatusNotifierItem",
      signature: "s",
      body: [uniqueName],
    });
    await bus.call(msg);
    return true;
  } catch (err: any) {
    const type = err?.type ?? "unknown";
    const text = err?.text ?? err?.message ?? String(err);
    console.error(`[tray] StatusNotifierWatcher.RegisterStatusNotifierItem: ${type}: ${text}`);
    return false;
  }
}

StatusNotifierItem.configureMembers({
  properties: {
    Category: { signature: "s", access: "read" },
    Id: { signature: "s", access: "read" },
    Title: { signature: "s", access: "read" },
    Status: { signature: "s", access: "read" },
    WindowId: { signature: "i", access: "read" },
    IconName: { signature: "s", access: "read" },
    IconThemePath: { signature: "s", access: "read" },
    IconPixmap: { signature: "a(iiay)", access: "read" },
    OverlayIconName: { signature: "s", access: "read" },
    OverlayIconPixmap: { signature: "a(iiay)", access: "read" },
    AttentionIconName: { signature: "s", access: "read" },
    AttentionIconPixmap: { signature: "a(iiay)", access: "read" },
    AttentionMovieName: { signature: "s", access: "read" },
    ToolTip: { signature: "(sa(iiay)ss)", access: "read" },
    ItemIsMenu: { signature: "b", access: "read" },
    Menu: { signature: "o", access: "read" },
  },
  methods: {
    Activate: { inSignature: "ii", outSignature: "" },
    SecondaryActivate: { inSignature: "ii", outSignature: "" },
    ContextMenu: { inSignature: "ii", outSignature: "" },
    Scroll: { inSignature: "is", outSignature: "" },
  },
  signals: {
    NewTitle: { signature: "" },
    NewIcon: { signature: "" },
    NewAttentionIcon: { signature: "" },
    NewOverlayIcon: { signature: "" },
    NewToolTip: { signature: "" },
    NewStatus: { signature: "s" },
  },
});
