import dbus, { type MessageBus } from "dbus-next";

const { Interface } = dbus.interface;
const Variant = dbus.Variant;

/**
 * Minimal com.canonical.dbusmenu service.
 *
 * Supports the subset used by every major panel: GetLayout (recursive tree),
 * GetGroupProperties / GetProperty (for lazy property fetches), Event
 * (click / hover dispatch), AboutToShow, plus LayoutUpdated and
 * ItemsPropertiesUpdated signals for live mutation.
 */

export type MenuItemType = "standard" | "separator";
export type ToggleType = "none" | "checkmark" | "radio";

export interface MenuItem {
  id: number;
  type?: MenuItemType;
  label?: string;
  enabled?: boolean;
  visible?: boolean;
  toggleType?: ToggleType;
  /** 0 = off, 1 = on, -1 = indeterminate. */
  toggleState?: 0 | 1 | -1;
  iconName?: string;
  children?: MenuItem[];
  onClicked?: () => void;
}

const LAYOUT_SIGNATURE = "(ia{sv}av)";

function propsFor(item: MenuItem, filter: string[]): Record<string, dbus.Variant> {
  const all: Record<string, dbus.Variant> = {};
  const type = item.type ?? "standard";
  if (type === "separator") {
    all.type = new Variant("s", "separator");
  }
  if (item.label !== undefined) all.label = new Variant("s", item.label);
  if (item.enabled === false) all.enabled = new Variant("b", false);
  if (item.visible === false) all.visible = new Variant("b", false);
  if (item.toggleType && item.toggleType !== "none") {
    all["toggle-type"] = new Variant("s", item.toggleType);
    all["toggle-state"] = new Variant("i", item.toggleState ?? 0);
  }
  if (item.iconName) all["icon-name"] = new Variant("s", item.iconName);
  if (item.children && item.children.length > 0) {
    all["children-display"] = new Variant("s", "submenu");
  }
  if (filter.length === 0) return all;
  const out: Record<string, dbus.Variant> = {};
  for (const key of filter) {
    if (key in all) out[key] = all[key]!;
  }
  return out;
}

function buildLayout(
  item: MenuItem,
  depth: number,
  propNames: string[],
): [number, Record<string, dbus.Variant>, dbus.Variant[]] {
  const props = propsFor(item, propNames);
  const children: dbus.Variant[] = [];
  if (depth !== 0 && item.children) {
    const nextDepth = depth === -1 ? -1 : depth - 1;
    for (const child of item.children) {
      const childTuple = buildLayout(child, nextDepth, propNames);
      children.push(new Variant(LAYOUT_SIGNATURE, childTuple));
    }
  }
  return [item.id, props, children];
}

function flatten(root: MenuItem): Map<number, MenuItem> {
  const out = new Map<number, MenuItem>();
  const stack: MenuItem[] = [root];
  while (stack.length) {
    const item = stack.pop()!;
    out.set(item.id, item);
    if (item.children) stack.push(...item.children);
  }
  return out;
}

/**
 * Object implementing `com.canonical.dbusmenu`. Construct with a root MenuItem
 * (id 0 is conventional for the root). Mutate the tree in place and call
 * `refresh()` to broadcast LayoutUpdated. `refreshProperties(ids)` only
 * emits the lighter ItemsPropertiesUpdated signal when you want to nudge a
 * few labels or toggle states without invalidating the whole layout.
 */
export class DBusMenu extends Interface {
  private root: MenuItem;
  private index: Map<number, MenuItem>;
  private revision = 1;

  constructor(root: MenuItem) {
    super("com.canonical.dbusmenu");
    this.root = root;
    this.index = flatten(root);
  }

  // Read-only properties ---------------------------------------------------

  get Version(): number {
    return 3;
  }

  get Status(): string {
    return "normal";
  }

  get TextDirection(): string {
    return "ltr";
  }

  get IconThemePath(): string[] {
    return [];
  }

  // Methods -----------------------------------------------------------------

  GetLayout(parentId: number, recursionDepth: number, propertyNames: string[]) {
    const parent = this.index.get(parentId) ?? this.root;
    const layout = buildLayout(parent, recursionDepth, propertyNames);
    return [this.revision, layout];
  }

  GetGroupProperties(ids: number[], propertyNames: string[]) {
    const out: Array<[number, Record<string, dbus.Variant>]> = [];
    for (const id of ids) {
      const item = this.index.get(id);
      if (!item) continue;
      out.push([id, propsFor(item, propertyNames)]);
    }
    return out;
  }

  GetProperty(id: number, name: string) {
    const item = this.index.get(id);
    if (!item) return new Variant("s", "");
    const props = propsFor(item, [name]);
    return props[name] ?? new Variant("s", "");
  }

  Event(id: number, eventId: string, _data: unknown, _timestamp: number): void {
    if (eventId !== "clicked") return;
    const item = this.index.get(id);
    if (!item || item.enabled === false) return;
    try {
      item.onClicked?.();
    } catch (err: any) {
      console.error(`[tray] menu action for item ${id} threw:`, err?.message ?? err);
    }
  }

  EventGroup(events: Array<[number, string, unknown, number]>): number[] {
    const notFound: number[] = [];
    for (const [id, eventId, data, ts] of events) {
      if (!this.index.has(id)) {
        notFound.push(id);
        continue;
      }
      this.Event(id, eventId, data, ts);
    }
    return notFound;
  }

  AboutToShow(_id: number): boolean {
    return false;
  }

  AboutToShowGroup(ids: number[]): [number[], number[]] {
    const updatesNeeded: number[] = [];
    const idErrors: number[] = [];
    for (const id of ids) {
      if (!this.index.has(id)) idErrors.push(id);
    }
    return [updatesNeeded, idErrors];
  }

  // Signals — calling these emits on the bus thanks to configureMembers. ---

  ItemsPropertiesUpdated(
    updated: Array<[number, Record<string, dbus.Variant>]>,
    removed: Array<[number, string[]]>,
  ): [Array<[number, Record<string, dbus.Variant>]>, Array<[number, string[]]>] {
    return [updated, removed];
  }

  LayoutUpdated(revision: number, parent: number): [number, number] {
    return [revision, parent];
  }

  ItemActivationRequested(id: number, timestamp: number): [number, number] {
    return [id, timestamp];
  }

  // Public helpers -----------------------------------------------------------

  /**
   * Replace the tree wholesale. Bumps the revision and emits LayoutUpdated
   * for the root, which tells panels to re-fetch the entire menu.
   */
  setRoot(root: MenuItem): void {
    this.root = root;
    this.index = flatten(root);
    this.revision += 1;
    this.LayoutUpdated(this.revision, 0);
  }

  /**
   * Emit LayoutUpdated without rebuilding the index, useful when you've
   * mutated children in place.
   */
  refreshLayout(parentId = 0): void {
    this.index = flatten(this.root);
    this.revision += 1;
    this.LayoutUpdated(this.revision, parentId);
  }

  /**
   * Emit ItemsPropertiesUpdated for a set of item ids so panels can refresh
   * their labels/toggles without re-reading the whole tree.
   */
  refreshProperties(ids: number[], filter: string[] = []): void {
    const updated: Array<[number, Record<string, dbus.Variant>]> = [];
    for (const id of ids) {
      const item = this.index.get(id);
      if (!item) continue;
      updated.push([id, propsFor(item, filter)]);
    }
    if (updated.length > 0) {
      this.ItemsPropertiesUpdated(updated, []);
    }
  }
}

DBusMenu.configureMembers({
  properties: {
    Version: { signature: "u", access: "read" },
    Status: { signature: "s", access: "read" },
    TextDirection: { signature: "s", access: "read" },
    IconThemePath: { signature: "as", access: "read" },
  },
  methods: {
    GetLayout: {
      inSignature: "iias",
      outSignature: "u(ia{sv}av)",
    },
    GetGroupProperties: {
      inSignature: "aias",
      outSignature: "a(ia{sv})",
    },
    GetProperty: {
      inSignature: "is",
      outSignature: "v",
    },
    Event: {
      inSignature: "isvu",
      outSignature: "",
    },
    EventGroup: {
      inSignature: "a(isvu)",
      outSignature: "ai",
    },
    AboutToShow: {
      inSignature: "i",
      outSignature: "b",
    },
    AboutToShowGroup: {
      inSignature: "ai",
      outSignature: "aiai",
    },
  },
  signals: {
    ItemsPropertiesUpdated: {
      signature: "a(ia{sv})a(ias)",
    },
    LayoutUpdated: {
      signature: "ui",
    },
    ItemActivationRequested: {
      signature: "iu",
    },
  },
});

export function exportMenu(bus: MessageBus, path: string, menu: DBusMenu): void {
  bus.export(path, menu);
}
