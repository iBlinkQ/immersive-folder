/* Everything the plugin knows about the file explorer's insides.
 *
 * None of it is in obsidian.d.ts — all 8482 lines of the public typings carry
 * no type for the explorer's sorting, its row map, or its refresh. So each
 * shape is declared here and, more importantly, checked at runtime before it
 * is used. A future Obsidian is free to rename any of this; when it does, the
 * checks below fail, the features that need them stay switched off, and the
 * rest of the plugin carries on.
 *
 * The rule for this file: nothing leaves it without having been through a
 * type guard. Callers get a narrowed type or nothing, never an assertion.
 */

import { TAbstractFile, TFolder } from "obsidian";

/* One row in the explorer's map of open items. */
export interface ExplorerItem {
  collapsible: boolean;
  collapsed: boolean;
  setCollapsed(value: boolean): void;
}

/* What getSortedFolderItems hands back — one entry per row, each carrying the
   file it stands for. The real object holds more than this; this is the part
   that is read. */
export interface FileTreeItem {
  file: TAbstractFile;
}

/* Only what isExplorerView actually verifies. sort() and getSortedFolderItems
   are deliberately absent: declaring them here would be a promise the guard
   below does not keep, and the whole point of the split is that an Obsidian
   which kept fileItems but moved the sorting still gets folding and the
   cover. Reaching those two goes through sortView / patchSorting, which
   check for themselves. */
export interface FileExplorerView {
  fileItems: Record<string, ExplorerItem>;
}

/* Narrowed from unknown rather than asserted from a view type: an assertion
   would hand every later property access whatever the compiler happens to
   know about a leaf's view, which in a lint run without Obsidian's types is
   `any` — and one `any` here spreads through everything downstream. Going
   through unknown means the compiler has nothing to propagate, and the check
   below is what grants the type. */
export function isExplorerView(view: unknown): view is FileExplorerView {
  if (typeof view !== "object" || view === null) return false;
  const items = (view as { fileItems?: unknown }).fileItems;
  return typeof items === "object" && items !== null;
}

/* Object.entries is typed as returning any[] once the object's own type is
   not in scope, and that any leaks into every loop over it. Object.keys
   returns string[] whatever the compiler knows, and indexing back in is typed
   by the Record — so nothing here is ever any. */
export function entriesOf(
  items: Record<string, ExplorerItem>
): [string, ExplorerItem][] {
  return Object.keys(items).map((key): [string, ExplorerItem] => [
    key,
    items[key],
  ]);
}

/* The shape the sort patch needs, which is more than isExplorerView asks for.
   Checked separately so that a build of Obsidian that kept fileItems but
   moved the sorting still gets folding and the cover — only the ordering
   switches itself off. */
interface SortableProto {
  sort(): void;
  /* Declared with an explicit `this` because patchSorting deliberately takes
     this method off the prototype and calls it with a different receiver.
     Spelling that out in the type is what makes the detachment a stated part
     of the contract rather than something that happens to work. */
  getSortedFolderItems(this: SortableProto, folder: TFolder): FileTreeItem[];
}

/* Ask the explorer to lay its rows out again. Guarded rather than assumed:
   the redraw is what makes a reordering show up, but failing to find it must
   not throw — worst case the new order appears the next time the tree
   rebuilds on its own. */
export function sortView(view: FileExplorerView): void {
  const candidate = view as { sort?: unknown };
  if (typeof candidate.sort === "function") {
    (candidate.sort as () => void).call(view);
  }
}

function isSortable(proto: unknown): proto is SortableProto {
  if (typeof proto !== "object" || proto === null) return false;
  const candidate = proto as Record<string, unknown>;
  return (
    typeof candidate.sort === "function" &&
    typeof candidate.getSortedFolderItems === "function"
  );
}

export interface SortPatch {
  unpatch(): void;
  /* The folder's children in Obsidian's own order, straight from the
     unpatched method. Needed because a folder's order has to be re-frozen
     before every drag, and the DOM cannot supply that: the explorer
     virtualises its rows, so a long folder has most of its children absent
     from the document entirely. A snapshot taken from the screen would
     silently record only what happened to be scrolled into view.

     Items rather than names, because the caller has to tell folders from
     files before it can record anything. */
  nativeItems(folder: TFolder): FileTreeItem[];
}

/* Replaces getSortedFolderItems on the *prototype*, so every explorer leaf —
   including ones opened later — goes through `reorder`. The original result
   is handed over untouched for reorder to shuffle, or to return as-is.
 *
 * Patching the prototype rather than an instance is what makes a second
 * sidebar work without extra bookkeeping. It is also why the returned undo
 * matters: leave a closure from an unloaded plugin sitting on Obsidian's
 * prototype and it keeps running after the plugin is gone.
 *
 * Returns null when this Obsidian does not have the methods, which is the
 * caller's signal to leave custom ordering switched off entirely. */
export function patchSorting(
  view: unknown,
  reorder: (folder: TFolder, sorted: FileTreeItem[]) => FileTreeItem[]
): SortPatch | null {
  if (!isExplorerView(view)) return null;

  const proto: unknown = Object.getPrototypeOf(view);
  if (!isSortable(proto)) return null;

  /* Reflect.get rather than reading the method off the prototype directly.
     Both fetch the same function, but a plain `proto.getSortedFolderItems`
     reads as a method being detached from its object — the mistake where the
     receiver is then lost. Here the receiver is never lost: every call below
     supplies one explicitly. Fetching it as a value says that, and keeps the
     linter from having to guess. */
  const original = Reflect.get(proto, "getSortedFolderItems");
  proto.getSortedFolderItems = function (
    this: SortableProto,
    folder: TFolder
  ): FileTreeItem[] {
    return reorder(folder, original.call(this, folder));
  };

  const host = view as unknown as SortableProto;
  return {
    unpatch: () => {
      proto.getSortedFolderItems = original;
    },
    nativeItems: (folder: TFolder) => original.call(host, folder),
  };
}
