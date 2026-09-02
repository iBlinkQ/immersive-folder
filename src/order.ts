/* The custom order: which subfolders of a folder come in which order, and
 * everything that keeps that record true as the vault changes underneath it.
 *
 * Three decisions shape this file.
 *
 * Only folders take part. A record says nothing about files, and apply() puts
 * every file row back at the exact index Obsidian's own sorting gave it — so
 * whichever sort the user picked keeps the great majority of the tree, and
 * switching it always produces a visible change. It also means a folder full
 * of notes and nothing else can never acquire a record at all, which is what
 * keeps a daily-notes folder out of this entirely.
 *
 * Only folders that have actually been dragged get an entry. Everything else
 * is absent, and absent means "let Obsidian sort it" — so a vault where the
 * feature was never used stores nothing, and the sort patch is a pass-through
 * for every folder but the ones the user arranged by hand.
 *
 * Entries hold child *names*, not paths. Within one folder a name is unique,
 * it is shorter to store, and moving a folder carries its children's order
 * along without touching a single entry. The cost is that renames have to be
 * followed, which is what the vault handlers below are for.
 */

import { TAbstractFile, TFolder } from "obsidian";
import { FileTreeItem } from "./explorer-api";

export type Orders = Record<string, string[]>;

/* Where a folder's own record lives. Obsidian calls the vault root "/", and
   that is used verbatim as a key rather than translated to "" — one less
   conversion between what the explorer hands over and what is stored.

   Exported because the drag code and the plugin both have to agree with this
   file on what counts as a sibling; three private copies of the same two
   lines is three chances for them to drift apart. */
export function parentKey(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "/" : path.slice(0, cut) || "/";
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/* Just the settings, deliberately. This class changes the record in memory
   and never writes it — when to persist is the plugin's call, and keeping
   that out of here means a drag can move a row and save once, rather than
   each helper reaching for disk on its own. */
interface OrderHost {
  settings: { orders: Orders };
}

export class OrderStore {
  constructor(private readonly host: OrderHost) {}

  private get orders(): Orders {
    return this.host.settings.orders;
  }

  /* The sort patch's whole job. A folder with no record is handed straight
     back, which is what keeps this a shuffle over Obsidian's own sorting
     rather than a replacement for it: whatever the user picked in the sort
     menu still decides everything this plugin has no opinion about.
   *
     Only the subfolder rows move, and they move *between the positions they
     already occupy* — every other index in the array comes back holding the
     item Obsidian put there. Rebuilding the result as "folders, then files"
     would have been shorter and would have quietly baked in an assumption
     about how the explorer groups its rows; this way the grouping, whatever
     it turns out to be, survives untouched. */
  apply(folder: TFolder, sorted: FileTreeItem[]): FileTreeItem[] {
    const order = this.orders[folder.path];
    if (!order || order.length === 0) return sorted;

    const slots: number[] = [];
    const folders: FileTreeItem[] = [];
    sorted.forEach((item, index) => {
      if (item.file instanceof TFolder) {
        slots.push(index);
        folders.push(item);
      }
    });
    /* One subfolder has only one place it can be. */
    if (folders.length < 2) return sorted;

    /* A Map rather than repeated indexOf: this runs on every redraw of every
       folder, and indexOf would make it quadratic in the folder's size. */
    const rank = new Map<string, number>();
    order.forEach((name, index) => rank.set(name, index));

    folders.sort((a, b) => {
      const ra = rank.get(a.file.name);
      const rb = rank.get(b.file.name);

      /* Subfolders the record has never seen — created since, or moved in
         from elsewhere — sink below the arranged ones. Returning 0 between
         two of them hands the decision back to Array.sort's stability, so
         they keep whatever relative order Obsidian just gave them instead of
         landing in an arbitrary one. */
      if (ra === undefined || rb === undefined) {
        if (ra === undefined && rb === undefined) return 0;
        return ra === undefined ? 1 : -1;
      }
      return ra - rb;
    });

    const out = sorted.slice();
    slots.forEach((slot, index) => (out[slot] = folders[index]));
    return out;
  }

  /* Called before every drag, not just the first one: the record is re-frozen
     from what is on screen at that moment, so the move that follows
     rearranges the list the user is actually looking at.
   *
     Re-freezing rather than capturing once is what keeps move() total. A
     subfolder created since the last drag is absent from the record and sits
     at the bottom of the folder block; if it stayed absent, dragging it — or
     dropping onto it — would be a move between two names the record does not
     contain, and would have to either guess or silently do nothing. */
  capture(folderPath: string, names: string[]): void {
    /* An empty list would still count as a record, and every later apply()
       would then walk a folder it has nothing to say about. */
    if (names.length === 0) return;
    this.orders[folderPath] = names.slice();
  }

  /* Move `moving` to sit before or after `target`. Both are subfolder names
     of the same folder — this plugin never reorders across folders, and never
     touches a file. */
  move(
    folderPath: string,
    moving: string,
    target: string,
    position: "before" | "after"
  ): void {
    const order = this.orders[folderPath];
    if (!order || moving === target) return;

    const from = order.indexOf(moving);
    if (from === -1) return;
    order.splice(from, 1);

    /* Read the target's index *after* the removal, not before: pulling the
       moving item out shifts everything below it up by one, and an index
       taken beforehand would drop the row one place too low on every
       downward move. */
    const to = order.indexOf(target);
    if (to === -1) {
      order.splice(from, 0, moving);
      return;
    }
    order.splice(position === "before" ? to : to + 1, 0, moving);
  }

  /* ── Keeping the record true ─────────────────────────────────────────── */

  /* Both handlers report whether they actually changed anything, so the
     plugin can skip writing data.json for the common case: a record holds
     folder names only, and most of what happens in a vault is files. */

  onDelete(file: TAbstractFile): boolean {
    const removed = this.removeFrom(parentKey(file.path), nameOf(file.path));
    return this.dropSubtree(file.path) || removed;
  }

  /* Rename covers three different events, because Obsidian reports a move and
     a rename as the same thing: a name change in place, a move to another
     folder, and — when the renamed item is itself a folder — a re-keying of
     every record at or below it. */
  onRename(file: TAbstractFile, oldPath: string): boolean {
    const oldParent = parentKey(oldPath);
    const newParent = parentKey(file.path);
    const oldName = nameOf(oldPath);
    let changed = false;

    if (oldParent === newParent) {
      const order = this.orders[oldParent];
      const at = order ? order.indexOf(oldName) : -1;
      /* Renamed in place: keep the position, just change the label. */
      if (order && at !== -1) {
        order[at] = file.name;
        changed = true;
      }
    } else {
      /* Moved somewhere else. It leaves the old parent's record and does not
         join the new one's: a folder arriving from elsewhere is in exactly
         the position of one that was just created, and apply() sinks both to
         the bottom of the folder block until the user says otherwise. */
      changed = this.removeFrom(oldParent, oldName);
    }

    if (file instanceof TFolder) {
      changed = this.rekeySubtree(oldPath, file.path) || changed;
    }
    return changed;
  }

  /* Records whose folder no longer exists — deleted outside Obsidian, or left
     behind by a version that stored something this one does not. Run once at
     load: cheap, and it stops data.json growing scar tissue.

     Reports whether anything went, so a normal start does not rewrite
     data.json just to save an unchanged file. */
  prune(exists: (path: string) => boolean): boolean {
    let changed = false;
    for (const path of Object.keys(this.orders)) {
      if (path !== "/" && !exists(path)) {
        delete this.orders[path];
        changed = true;
      }
    }
    return changed;
  }

  private removeFrom(folderPath: string, name: string): boolean {
    const order = this.orders[folderPath];
    if (!order) return false;
    const at = order.indexOf(name);
    if (at === -1) return false;
    order.splice(at, 1);
    return true;
  }

  private dropSubtree(path: string): boolean {
    const prefix = `${path}/`;
    let changed = false;
    for (const key of Object.keys(this.orders)) {
      if (key === path || key.startsWith(prefix)) {
        delete this.orders[key];
        changed = true;
      }
    }
    return changed;
  }

  private rekeySubtree(oldPath: string, newPath: string): boolean {
    const prefix = `${oldPath}/`;
    let changed = false;
    for (const key of Object.keys(this.orders)) {
      if (key !== oldPath && !key.startsWith(prefix)) continue;
      const moved = newPath + key.slice(oldPath.length);
      this.orders[moved] = this.orders[key];
      delete this.orders[key];
      changed = true;
    }
    return changed;
  }
}
