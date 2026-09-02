/* Reordering rows by dragging them, inside a mode of its own.
 *
 * The mode is the whole design. Ordinary dragging in the file explorer means
 * "move this file into that folder" — Obsidian's own feature, and one this
 * plugin has no business touching. Reordering means something else entirely,
 * and on screen the two are indistinguishable: "below that folder" and "into
 * that folder" are the same pixel.
 *
 * Rather than guess which one a drag meant, the two are separated in time.
 * While sort mode is off this file listens to nothing at all and the explorer
 * behaves exactly as it always did. While it is on, every drag is a
 * reordering, the tree's shape is frozen, and nothing here ever touches the
 * file system — the worst a bug can do is put a row in the wrong place in a
 * list.
 *
 * Which rows take part is not decided here: the host answers canDrag(), and
 * it answers "folders only". Everything below is written in terms of that
 * answer rather than around it, so a row that is out is out of the grips, out
 * of the drop targets, and out of the drag from the first event onwards.
 */

import { nameOf, parentKey } from "./order";

/* activeDocument, never document: Obsidian can pop a sidebar out into its own
   window, and the file tree then lives in that window's document. A plain
   `document` query would come back empty there and the whole mode would
   quietly do nothing. */
const ROW = ".tree-item-self[data-path]";
/* The box a row actually occupies in the layout. For a folder it wraps the
   folder together with its children, which is why the settle animation moves
   these and not the title rows inside them. */
const ITEM = ".tree-item";
/* The wrapper's other half: everything nested under it. Where a folder is
   expanded this is what stops its box from standing in for its whole
   subtree — see locate(). */
const ITEM_CHILDREN = ".tree-item-children";
const CONTAINER = ".nav-files-container";

/* On the container: the mode itself, and whether a drag is under way. The
   second is what lets the stylesheet tell "everything can move" from "only
   these can receive what you are holding". */
export const MODE_CLASS = "immersive-folder-sorting";
export const DRAGGING_MODE_CLASS = "immersive-folder-sorting-drag";
/* On rows: the one being carried, and the ones that can take it. */
export const DRAGGING_CLASS = "immersive-folder-dragging";
export const TARGET_CLASS = "immersive-folder-drop-target";
/* On the grip: added to the folder's existing collapse arrow, or to an
   element created for it when it has none. */
export const HANDLE_CLASS = "immersive-folder-handle";
const INJECTED_ATTR = "data-immersive-folder-handle";
const DROP_ATTR = "data-immersive-folder-drop";
/* Rows carry no aria-label of their own, so setting one is safe and removing
   it on the way out leaves nothing behind. */
const LABEL_ATTR = "aria-label";
const LABELLED_ATTR = "data-immersive-folder-hint";

/* How far outside a row's band the pointer may sit and still count as
   pointing at it. Themes leave a margin between rows — measured at 2px
   between the wrappers in one, and 4px of padding inside the wrapper in
   another — and a pointer in that margin is over nothing at all, which is
   what used to blink the drop line out. Deliberately small: it has to cross a
   margin, never to reach a row you are not pointing at. */
const BAND_SLACK = 6;

/* How long a row takes to slide to its new place after being dropped: long
   enough to follow with your eye, short enough not to be in the way.
 *
   One duration for the whole batch rather than one per row — rows finishing
   on their own clocks read as several separate movements, and what happened
   was one.
 *
   It grows with the square root of the distance, never linearly. A fixed
   duration was the first version, and it is what makes a long move feel
   violent: measured in a real vault, the dragged row crossed 1031px in the
   same 260ms that its neighbours used to cross 27px — forty times the speed,
   for no reason anyone can see. Linear would fix that and introduce a
   two-second wait instead; the square root leaves a single-line move about
   where it was and makes a screen-length move merely brisk. */
const SETTLE_MIN_MS = 200;
const SETTLE_MAX_MS = 520;
/* Eases in a little before decelerating. A plain ease-out leaves at full
   speed, which over a long distance is exactly what reads as a snap. */
const SETTLE_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

function settleMs(distance: number): number {
  return Math.min(
    SETTLE_MAX_MS,
    Math.round(SETTLE_MIN_MS + Math.sqrt(distance) * 12)
  );
}

export interface DragSortHost {
  /* The tooltip a row carries while the mode is on. A function rather than a
     string so a language change is picked up on the next pass. */
  hint(): string;
  /* Whether this row takes part at all — which, as the host has it, means
     "is this a folder". A row that does not take part gets no grip: a handle
     that cannot be used is worse than none, and its absence is what tells the
     user which layer this mode is about. */
  canDrag(row: HTMLElement): boolean;
  /* Move `moving` to sit before or after `target`, both child names of
     `folderPath`. Called once, after the pointer is released. */
  commit(
    folderPath: string,
    moving: string,
    target: string,
    position: "before" | "after"
  ): void;
}

interface Landing {
  row: HTMLElement;
  position: "before" | "after";
}

export class DragSort {
  private active = false;
  private source: HTMLElement | null = null;
  private siblings: HTMLElement[] = [];
  private landing: Landing | null = null;
  /* The explorer builds and discards rows as you scroll, so a row can appear
     at any moment and has to arrive already carrying its grip. */
  private readonly observer = new MutationObserver(() => this.decorate());
  /* The document the listeners went on, kept so they come off the same one.
     activeDocument can change while the mode is open — the user pops a pane
     out, or focuses another window — and removing from whatever is active at
     that later moment would leave the originals attached forever.

     This is also why registerDomEvent is not used here despite being the
     convention: it detaches on plugin unload, but these have to come and go
     with the mode, and to follow whichever document the explorer is in. */
  private boundDoc: Document | null = null;
  /* Every row that has been given a grip, kept because querying the document
     on the way out is not enough: the explorer recycles rows as you scroll,
     and a row scrolled out of view is gone from the document while its
     element lives on in the explorer's own cache. Cleaning up by selector
     would miss exactly those, and they would scroll back in still carrying a
     handle after the mode was switched off. */
  private readonly decorated = new Set<HTMLElement>();

  constructor(private readonly host: DragSortHost) {}

  isActive(): boolean {
    return this.active;
  }

  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (on) this.start();
    else this.stop();
  }

  /* Called after the explorer redraws, in case a pass rebuilt rows the
     observer has already stopped watching. */
  refresh(): void {
    if (this.active) this.decorate();
  }

  private start(): void {
    for (const container of this.containers()) {
      container.addClass(MODE_CLASS);
      this.observer.observe(container, { childList: true, subtree: true });
    }

    /* Capture phase throughout: Obsidian listens for these further out, and
       capture runs outermost-first, so anything bound to the container itself
       can be cut off before it is ever reached. */
    const doc = activeDocument;
    this.boundDoc = doc;
    const opts = { capture: true };
    doc.addEventListener("dragstart", this.onDragStart, opts);
    doc.addEventListener("dragover", this.onDragOver, opts);
    doc.addEventListener("dragenter", this.onDragOver, opts);
    doc.addEventListener("drop", this.onDrop, opts);
    doc.addEventListener("dragend", this.onDragEnd, opts);
    /* Clicking and the context menu are both off while sorting. The grip sits
       where the collapse arrow was, so a click would fold the tree under the
       pointer or open a note — both move the ground while you are arranging
       it. The menu matters more on a phone than on a desktop: there a drag
       starts with a long press, and the long press raises the file menu at
       the same time, so letting go lands you in a menu instead of finishing
       the drag. */
    doc.addEventListener("click", this.onSuppress, opts);
    doc.addEventListener("contextmenu", this.onSuppress, opts);

    this.decorate();
  }

  private stop(): void {
    this.observer.disconnect();

    const doc = this.boundDoc;
    if (doc) {
      const opts = { capture: true };
      doc.removeEventListener("dragstart", this.onDragStart, opts);
      doc.removeEventListener("dragover", this.onDragOver, opts);
      doc.removeEventListener("dragenter", this.onDragOver, opts);
      doc.removeEventListener("drop", this.onDrop, opts);
      doc.removeEventListener("dragend", this.onDragEnd, opts);
      doc.removeEventListener("click", this.onSuppress, opts);
      doc.removeEventListener("contextmenu", this.onSuppress, opts);
      this.boundDoc = null;
    }

    this.clear();
    this.undecorate();
    for (const container of this.containers()) {
      container.removeClass(MODE_CLASS);
      container.removeClass(DRAGGING_MODE_CLASS);
    }
  }

  /* ── The grips ──────────────────────────────────────────────────────── */

  /* A folder row usually has somewhere to put one already: the collapse
     arrow's own element. One without an arrow is given an element carrying
     Obsidian's own icon classes instead — which lands it exactly where the
     arrow would be, at any indentation and under any theme, without this file
     knowing how that position is worked out. */
  private decorate(): void {
    for (const container of this.containers()) {
      for (const row of Array.from(
        container.querySelectorAll<HTMLElement>(ROW)
      )) {
        const allowed = this.host.canDrag(row);
        const existing = row.querySelector<HTMLElement>(`.${HANDLE_CLASS}`);

        if (!allowed) {
          if (existing) this.removeHandle(existing);
          this.clearHint(row);
          this.decorated.delete(row);
          continue;
        }

        /* Set every pass, so a language change is picked up. */
        row.setAttribute(LABEL_ATTR, this.host.hint());
        row.setAttribute(LABELLED_ATTR, "");
        this.decorated.add(row);

        if (existing) continue;

        const arrow = row.querySelector<HTMLElement>(".collapse-icon");
        if (arrow) {
          arrow.addClass(HANDLE_CLASS);
          continue;
        }

        const slot = activeDocument.createElement("div");
        slot.className = `tree-item-icon collapse-icon ${HANDLE_CLASS}`;
        slot.setAttribute(INJECTED_ATTR, "");
        row.prepend(slot);
      }
    }
  }

  private undecorate(): void {
    /* The remembered rows first — they are the only way to reach one that is
       currently scrolled out of the document. */
    for (const row of this.decorated) {
      const handle = row.querySelector<HTMLElement>(`.${HANDLE_CLASS}`);
      if (handle) this.removeHandle(handle);
      this.clearHint(row);
    }
    this.decorated.clear();

    /* Then a sweep of the document, in case anything was decorated by a pass
       whose row has since been replaced by a different element. */
    for (const el of Array.from(
      activeDocument.querySelectorAll<HTMLElement>(`.${HANDLE_CLASS}`)
    )) {
      this.removeHandle(el);
    }
    for (const row of Array.from(
      activeDocument.querySelectorAll<HTMLElement>(`[${LABELLED_ATTR}]`)
    )) {
      this.clearHint(row);
    }
  }

  private clearHint(row: HTMLElement): void {
    if (!row.hasAttribute(LABELLED_ATTR)) return;
    row.removeAttribute(LABEL_ATTR);
    row.removeAttribute(LABELLED_ATTR);
  }

  /* Arrows are borrowed and must be handed back; slots this file created
     belong to the plugin and go away with it. */
  private removeHandle(el: HTMLElement): void {
    if (el.hasAttribute(INJECTED_ATTR)) el.remove();
    else el.removeClass(HANDLE_CLASS);
  }

  /* ── The drag ───────────────────────────────────────────────────────── */

  private readonly onSuppress = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(CONTAINER)) return;

    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onDragStart = (event: DragEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const row = target.closest<HTMLElement>(ROW);
    if (!row || !row.closest(CONTAINER) || !this.host.canDrag(row)) return;

    const path = row.getAttribute("data-path");
    if (!path) return;

    this.source = row;
    this.siblings = this.findSiblings(path, row);
    row.addClass(DRAGGING_CLASS);

    /* Marking the rows that can take this one turns "where may I drop it"
       from something you discover by trying into something you can see: the
       siblings keep moving, everything else dims. */
    for (const sibling of this.siblings) sibling.addClass(TARGET_CLASS);
    for (const container of this.containers()) {
      container.addClass(DRAGGING_MODE_CLASS);
    }
  };

  /* Obsidian chooses a drop target while the pointer is still moving — it
     watches dragover and remembers the last folder it saw. Stopping only the
     drop is too late: by then it has chosen, and the file moves. So while
     this plugin owns a drag, Obsidian hears nothing about it at all. */
  private readonly onDragOver = (event: DragEvent): void => {
    if (!this.source) return;

    this.mark(this.locate(event.clientX, event.clientY));

    event.stopPropagation();
    /* preventDefault is what makes a position droppable at all, so it is
       reserved for real landings. Everywhere else the drop never fires, and
       releasing there does nothing — which is what an undrawn position should
       mean. */
    if (this.landing) event.preventDefault();
  };

  private readonly onDrop = (event: DragEvent): void => {
    const source = this.source;
    if (!source) return;

    event.preventDefault();
    event.stopPropagation();

    const landing = this.landing;
    if (!landing) {
      this.clear();
      return;
    }

    const from = source.getAttribute("data-path");
    const to = landing.row.getAttribute("data-path");
    if (from && to) {
      this.host.commit(
        parentKey(from),
        nameOf(from),
        nameOf(to),
        landing.position
      );
    }
    this.clear();
  };

  private readonly onDragEnd = (): void => this.clear();

  /* Rows sharing a parent, minus the one being dragged, minus anything the
     host says is off limits. Worked out once per drag: the tree's shape is
     frozen while sorting, so the set cannot change under it. */
  private findSiblings(path: string, source: HTMLElement): HTMLElement[] {
    const container = source.closest<HTMLElement>(CONTAINER);
    if (!container) return [];

    const parent = parentKey(path);
    return Array.from(container.querySelectorAll<HTMLElement>(ROW)).filter(
      (row) => {
        if (row === source) return false;
        const other = row.getAttribute("data-path");
        return (
          other !== null && parentKey(other) === parent && this.host.canDrag(row)
        );
      }
    );
  }

  /* Where the row would land, or null to draw nothing.
   *
     This asks "which row is the pointer on" rather than "which gap is
     nearest". Nearest-gap looked reasonable and behaved badly: park the
     pointer among an expanded folder's children — none of which are siblings
     — and it would still find some sibling edge far away and draw a line
     there, pointing at a place the pointer was nowhere near.
   *
     It reads geometry rather than asking elementFromPoint, which was the
     first version and is a worse question to ask. The pointer is often over
     no row at all: themes leave a margin between rows, and while the mode is
     on the rows drift a pixel of their own accord, so the seam between two of
     them opens and closes. elementFromPoint answers "nothing" there and the
     line blinks out. Measuring against each candidate's band answers
     everywhere, and BAND_SLACK is what carries the answer across the margin
     without letting it reach past a neighbour. */
  private locate(x: number, y: number): Landing | null {
    const container = this.source?.closest<HTMLElement>(CONTAINER);
    if (!container) return null;

    /* Dragover fires wherever the pointer goes, the explorer included or not.
       Outside the tree there is nothing to point at. */
    const bounds = container.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right) return null;
    if (y < bounds.top || y > bounds.bottom) return null;

    let best: HTMLElement | null = null;
    let bestMiddle = 0;
    let least = Infinity;

    for (const row of this.siblings) {
      const item = row.closest<HTMLElement>(ITEM);
      if (!item) continue;

      /* Only the strip of the wrapper that stands for the row itself, which
         is everything above its children. An expanded folder's wrapper
         reaches all the way down past its subtree, and measuring against that
         would hand the pointer to a title row it is nowhere near — which is
         the failure nearest-gap had. */
      const box = item.getBoundingClientRect();
      const kids = item.querySelector<HTMLElement>(`:scope > ${ITEM_CHILDREN}`);
      const bottom = kids ? kids.getBoundingClientRect().top : box.bottom;

      const distance = y < box.top ? box.top - y : y > bottom ? y - bottom : 0;
      if (distance > BAND_SLACK || distance >= least) continue;
      best = row;
      /* The band's middle, not the title row's. The drift lives on the row,
         so its own midpoint slides a pixel either way while this is being
         asked — enough to answer "before" and "after" in turn to a pointer
         that has not moved. The wrapper does not drift, so its middle is a
         line that stays put. The stylesheet stops the drift during a drag as
         well; this is the half of it that does not depend on a stylesheet. */
      bestMiddle = (box.top + bottom) / 2;
      least = distance;
    }

    if (!best) return null;
    return { row: best, position: y < bestMiddle ? "before" : "after" };
  }

  private mark(landing: Landing | null): void {
    if (
      this.landing &&
      this.landing.row === landing?.row &&
      this.landing.position === landing.position
    ) {
      return;
    }

    this.unmark();
    this.landing = landing;
    if (!landing) return;

    /* On the .tree-item, not the title row. A .tree-item wraps a folder
       together with its children, so "after" draws below the whole subtree —
       where the row will actually end up. Drawn on the title row instead, the
       line lands between a folder and its first child and reads as "into this
       folder", promising something this plugin never does. */
    const item = landing.row.closest<HTMLElement>(".tree-item");
    (item ?? landing.row).setAttribute(DROP_ATTR, landing.position);
  }

  private unmark(): void {
    for (const el of Array.from(
      activeDocument.querySelectorAll<HTMLElement>(`[${DROP_ATTR}]`)
    )) {
      el.removeAttribute(DROP_ATTR);
    }
  }

  private clear(): void {
    this.unmark();
    this.landing = null;

    for (const el of Array.from(
      activeDocument.querySelectorAll<HTMLElement>(
        `.${DRAGGING_CLASS}, .${TARGET_CLASS}`
      )
    )) {
      el.removeClass(DRAGGING_CLASS);
      el.removeClass(TARGET_CLASS);
    }
    for (const container of this.containers()) {
      container.removeClass(DRAGGING_MODE_CLASS);
    }

    this.source = null;
    this.siblings = [];
  }

  private containers(): HTMLElement[] {
    return Array.from(activeDocument.querySelectorAll<HTMLElement>(CONTAINER));
  }
}

/* Slide rows to their new places instead of teleporting them.
 *
 * A reorder that lands instantly leaves you unsure it did what you meant —
 * the list is simply different, with nothing connecting what you let go of to
 * where it ended up. Watching the row travel answers that.
 *
 * The items are measured, rearranged, and immediately pushed back to where
 * they were, all in one tick so nothing is painted in between; the transition
 * that follows is what the eye actually sees. The explorer reuses its
 * elements when it re-sorts, which is what makes the before-and-after
 * measurements refer to the same objects.
 *
 * "Immediately" is the load-bearing word, and it has to be enforced rather
 * than assumed — see the transition:none below.
 *
 * What moves is the .tree-item wrappers, not the .tree-item-self rows inside
 * them. Animating the rows was the first version and it tears the tree in
 * half: the wrapper is what holds a layout slot, so it arrives the instant
 * the explorer re-sorts, while only the text glides after it. Measured on a
 * real move, first frame: the wrapper of the folder being dragged was already
 * at its destination y=84 with its own title row still back at y=660 — and
 * every slot a row had not reached yet was drawn as a hole. Rows are
 * transparent, so those were real gaps, not one row covering another. It
 * happens under the stock theme too; a theme can only make it more or less
 * obvious.
 *
 * Rows drift via the `translate` property while this uses `transform`, so the
 * two compose instead of overwriting each other and the animation does not
 * have to stop the mode's idle motion to play.
 */
export function animateReorder(apply: () => void): void {
  const items = Array.from(
    activeDocument.querySelectorAll<HTMLElement>(`${CONTAINER} ${ITEM}`)
  );

  /* End any animation still in flight before measuring, or the "before"
     positions are the offsets of the last one rather than where the items
     actually sit. */
  for (const item of items) settle(item);

  const before = new Map<HTMLElement, number>();
  for (const item of items) before.set(item, item.getBoundingClientRect().top);

  apply();

  /* Same tick as apply(): reading the new position forces layout, and the
     offset goes on before the browser has painted, so a row is never seen at
     its destination first. */
  /* Nested items need no bookkeeping, only this order. querySelectorAll
     returns document order, so an ancestor is offset before any descendant is
     measured — and a translate applies to the whole subtree, so the
     descendant's fresh rect already carries it. Its delta therefore comes out
     as whatever is left to make up on its own, which for the ordinary case of
     one drag reordering one level is zero. */
  const moved: HTMLElement[] = [];
  let furthest = 0;
  for (const [item, top] of before) {
    if (!item.isConnected) continue;
    const delta = top - item.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;

    /* `none` rather than leaving it unset. Leaving it unset assumes that no
       stylesheet transitions `transform` on these rows, and a theme is
       perfectly entitled to — nudging a row a pixel on hover is a common way
       to write one. Where a theme does, this offset stops being the instant
       jump FLIP depends on and becomes an animation of its own; the row is
       still barely off its new position when the loop below sends it back,
       so it travels nothing and the whole reorder lands as a teleport.
       Measured on such a theme: an item asked to return to y=86 was still at
       y=116, having moved 0 of the 30 pixels. */
    item.style.transition = "none";
    item.style.transform = `translateY(${delta}px)`;
    furthest = Math.max(furthest, Math.abs(delta));
    moved.push(item);
  }
  if (moved.length === 0) return;

  /* One forced layout to make the browser accept those offsets as the
     starting point, rather than waiting a frame for it.
   *
     requestAnimationFrame was the obvious way to wait and is the wrong one:
     it is paused entirely while the window is in the background, so a reorder
     that happened as you switched away would leave every row frozen at its
     old offset with no callback ever coming to release them. A forced reflow
     runs regardless. */
  void activeDocument.body.offsetHeight;

  const ms = settleMs(furthest);
  for (const item of moved) {
    item.style.transition = `transform ${ms}ms ${SETTLE_EASE}`;
    item.style.transform = "";
  }

  /* A timer rather than transitionend: timers still fire in a background
     window, where the transition itself may never run to completion. Either
     way the rows end up where they belong — the animation is decoration, the
     cleanup is not. */
  window.setTimeout(() => {
    for (const item of moved) settle(item);
  }, ms + 60);
}

function settle(item: HTMLElement): void {
  if (!item.style.transform && !item.style.transition) return;
  item.style.transition = "";
  item.style.transform = "";
}
