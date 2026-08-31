import {
  addIcon,
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
} from "obsidian";

interface ImmersiveFolderSettings {
  enabled: boolean;
  revealTrail: boolean;
  keepActiveInView: boolean;
  collapseOthers: boolean;
  /* Which folders were open before the tree was folded down, so leaving
     immersive mode can hand the explorer back the way it was found. */
  expandedBefore: string[];
}

/* app.commands is real but absent from the public typings. */
interface AppWithCommands {
  commands: { executeCommandById(id: string): boolean };
}

/* So is the explorer's own map of rows. Everything that touches it goes
   through explorerViews(), which checks before handing one over: a future
   Obsidian could rename this, and the cover has to keep working if it does. */
interface ExplorerItem {
  collapsible: boolean;
  collapsed: boolean;
  setCollapsed(value: boolean): void;
}

interface FileExplorerView {
  fileItems: Record<string, ExplorerItem>;
}

const DEFAULT_SETTINGS: ImmersiveFolderSettings = {
  enabled: false,
  revealTrail: true,
  keepActiveInView: true,
  collapseOthers: true,
  expandedBefore: [],
};

/* Everything the plugin draws hangs off this one body class, so lifting the
   cover is a single class away and can never leave half-covered rows behind. */
const BODY_CLASS = "immersive-folder-on";
const BUTTON_CLASS = "immersive-folder-button";
const STYLE_ID = "immersive-folder-rules";
const SCOPE = `.${BODY_CLASS} .nav-files-container`;

const ICON = "immersive-folder";

/* The button draws the plugin's own idea rather than a stock glyph: rows of
   text with the middle one carrying the weight while its neighbours fall back.
   That is the covered list in miniature.

   The shape does not change between states — only the accent wash behind it
   does. A drawn-on pair of carets was tried and dropped: at the ~18px a
   toolbar affords, they crowd the middle row down to a stub and the whole
   thing reads as one arrow-ish symbol rather than as text. A constant glyph
   also means switching the cover on never looks like the button turned into a
   different button.

   addIcon draws into a 0 0 100 100 box while Obsidian's .svg-icon rule sets
   stroke widths for a 24-unit one, so every stroke states its own width here
   or it renders hairline-thin. */
function registerIcon(): void {
  const row = (d: string, extra: string) =>
    `<path d="${d}" fill="none" stroke="currentColor" stroke-linecap="round" ${extra}/>`;

  addIcon(
    ICON,
    row("M22 28 H78", 'stroke-width="7" opacity="0.35"') +
      row("M20 50 H80", 'stroke-width="11"') +
      row("M22 72 H78", 'stroke-width="7" opacity="0.35"')
  );
}

export default class ImmersiveFolderPlugin extends Plugin {
  settings: ImmersiveFolderSettings = { ...DEFAULT_SETTINGS };
  private styleEl: HTMLStyleElement | null = null;
  private lastSyncedPath: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    registerIcon();

    this.styleEl = document.head.createEl("style", { attr: { id: STYLE_ID } });
    this.register(() => this.styleEl?.remove());
    this.register(() => document.body.removeClass(BODY_CLASS));
    this.register(() => this.removeButtons());

    this.addCommand({
      id: "toggle",
      name: "Toggle immersive folder",
      callback: () => void this.toggle(),
    });

    this.addSettingTab(new ImmersiveFolderSettingTab(this.app, this));

    /* The cover is derived from the active file, so anything that can change
       which file that is has to redraw it. Folder collapse and the explorer
       recycling rows as you scroll are deliberately absent from this list:
       the rules match on data-path, so a row styles itself the moment it is
       created, however it got there. */
    const redraw = () => this.redraw();
    this.registerEvent(this.app.workspace.on("file-open", redraw));
    this.registerEvent(this.app.workspace.on("active-leaf-change", redraw));
    this.registerEvent(this.app.workspace.on("layout-change", redraw));
    this.registerEvent(this.app.vault.on("rename", redraw));

    this.app.workspace.onLayoutReady(redraw);
  }

  async toggle(): Promise<void> {
    const turningOn = !this.settings.enabled;

    if (this.settings.collapseOthers) {
      if (turningOn) this.captureExpanded();
      else this.restoreExpanded();
    }

    this.settings.enabled = turningOn;
    /* Force the next sync through: the file has not changed, but the tree
       around it is about to. */
    this.lastSyncedPath = null;
    await this.saveSettings();
  }

  /* Called when the setting is flipped while immersive mode is already on,
     where there is no toggle to hang the capture and restore off. */
  async applyCollapseOthers(value: boolean): Promise<void> {
    if (this.settings.enabled) {
      if (value) this.captureExpanded();
      else this.restoreExpanded();
    }
    this.settings.collapseOthers = value;
    this.lastSyncedPath = null;
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.redraw();
  }

  private async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as
      | (Partial<ImmersiveFolderSettings> & { revealOnEnable?: boolean })
      | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    /* revealOnEnable only fired as the cover came down; keepActiveInView is
       the same idea applied to every switch. Carry the old value over. */
    if (saved && typeof saved.revealOnEnable === "boolean") {
      this.settings.keepActiveInView = saved.revealOnEnable;
    }
  }

  private redraw(): void {
    const rules = this.buildRules();
    /* An empty sheet is the safe state: no bars, no gaps, the explorer
       exactly as the theme drew it. */
    document.body.toggleClass(BODY_CLASS, rules !== "");
    if (this.styleEl) this.styleEl.textContent = rules;
    this.syncButtons();
    this.syncExplorer();
  }

  /* The shape of the tree follows the active file: fold away what you are not
     in, then scroll to what you are.

     Gated on the file actually changing. redraw() also runs on every layout
     change, and re-collapsing the tree on each of those would fight the user
     every time they moved a pane or opened a sidebar. */
  private syncExplorer(): void {
    if (!this.settings.enabled) {
      this.lastSyncedPath = null;
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file || file.path === this.lastSyncedPath) return;
    this.lastSyncedPath = file.path;

    if (this.settings.collapseOthers) this.collapseAway(file.parent?.path);
    if (this.settings.keepActiveInView || this.settings.collapseOthers) {
      (this.app as unknown as AppWithCommands).commands.executeCommandById(
        "file-explorer:reveal-active-file"
      );
    }
  }

  /* Collapse every folder that is not on the way to `keep`. The trail itself
     is left alone — collapsing it only for reveal to expand it again a frame
     later shows up as a flicker. */
  private collapseAway(keep: string | undefined): void {
    for (const view of this.explorerViews()) {
      for (const [path, item] of Object.entries(view.fileItems)) {
        if (!item.collapsible || item.collapsed) continue;
        if (keep && (keep === path || keep.startsWith(`${path}/`))) continue;
        item.setCollapsed(true);
      }
    }
  }

  private captureExpanded(): void {
    const open: string[] = [];
    for (const view of this.explorerViews()) {
      for (const [path, item] of Object.entries(view.fileItems)) {
        if (item.collapsible && !item.collapsed) open.push(path);
      }
    }
    this.settings.expandedBefore = open;
  }

  private restoreExpanded(): void {
    const wanted = new Set(this.settings.expandedBefore);
    for (const view of this.explorerViews()) {
      for (const [path, item] of Object.entries(view.fileItems)) {
        if (item.collapsible && item.collapsed && wanted.has(path)) {
          item.setCollapsed(false);
        }
      }
    }
    this.settings.expandedBefore = [];
  }

  private *explorerViews(): Generator<FileExplorerView> {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const view = leaf.view as unknown as FileExplorerView | undefined;
      if (view && typeof view.fileItems === "object" && view.fileItems) {
        yield view;
      }
    }
  }

  private buildRules(): string {
    if (!this.settings.enabled) return "";

    const folder = this.app.workspace.getActiveFile()?.parent;
    /* Nothing open means no folder to focus on. Covering the lot would leave a
       column of anonymous bars with no way to navigate out of it, so the cover
       lifts itself until something is open again. The same branch covers the
       case where the active row has been recycled out of the DOM. */
    if (!folder) return "";

    /* Rows whose real name survives the cover. */
    const reveal: string[] = [];

    if (folder.isRoot()) {
      /* Obsidian wraps the top level in an unclassed div for its virtual
         scroller, so the root's own items sit two levels down. */
      reveal.push(`${SCOPE} > div > .tree-item > .tree-item-self`);
    } else {
      const trail = this.settings.revealTrail
        ? ancestry(folder.path)
        : [folder.path];
      for (const path of trail) {
        reveal.push(`${SCOPE} .nav-folder-title[data-path=${quote(path)}]`);
      }
      /* A folder's title row and its list of children are siblings, and that
         is what lets this skip :has() altogether — along with the specificity
         fight against the cover, and any dependence on the active file's own
         row still being rendered. */
      reveal.push(
        `${SCOPE} .nav-folder-title[data-path=${quote(folder.path)}]` +
          ` ~ .nav-folder-children > .tree-item > .tree-item-self`
      );
    }

    return `${skeletonRules()}\n\n${revealRules(reveal)}`;
  }

  private syncButtons(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const bar = leaf.view.containerEl.querySelector<HTMLElement>(
        ".nav-buttons-container"
      );
      if (!bar) continue;

      let button = bar.querySelector<HTMLElement>(`.${BUTTON_CLASS}`);
      if (!button) {
        button = bar.createDiv({
          cls: `clickable-icon nav-action-button ${BUTTON_CLASS}`,
        });
        /* The glyph never changes, so it is drawn once at creation; only the
           state below is refreshed. */
        setIcon(button, ICON);
        button.addEventListener("click", () => void this.toggle());
      }

      const on = this.settings.enabled;
      /* Tracks the setting, not whether the cover happens to be drawn right
         now: with no file open the cover lifts on its own, and a button that
         flipped itself back to "off" would read as having been switched off
         behind the user's back. */
      button.toggleClass("is-active", on);
      button.setAttribute(
        "aria-label",
        on ? "Leave immersive folder" : "Immerse in this folder"
      );
    }
  }

  private removeButtons(): void {
    for (const el of Array.from(
      document.querySelectorAll(`.${BUTTON_CLASS}`)
    )) {
      el.remove();
    }
  }
}

/* The cover itself — one bar per row, drawn over a transparent label. */
function skeletonRules(): string {
  return `${SCOPE} .tree-item-self .tree-item-inner {
  position: relative;
  color: transparent;
}

${SCOPE} .tree-item-self .tree-item-inner::after {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 0.6em;
  width: 68%;
  max-width: 9em;
  border-radius: 2px;
  background-color: var(--immersive-folder-bar);
  opacity: var(--immersive-folder-bar-opacity);
}

/* Three widths, so a column of bars reads as a list rather than a barcode.
   The name still sets the row's width, but it is transparent by then, so its
   length is not on show. */
${SCOPE} .tree-item:nth-child(3n + 1) .tree-item-inner::after { width: 54%; }
${SCOPE} .tree-item:nth-child(3n + 2) .tree-item-inner::after { width: 81%; }

/* An icon names a folder as loudly as its label does. Blanking it outright
   leaves a hole where the eye expects something, so the glyph is hidden and a
   placeholder tile is drawn in its place — the row keeps its shape and reads
   as covered rather than broken.

   visibility rather than opacity or display: it inherits, so it takes text
   nodes down with it (Iconize renders emoji icons as bare text, which no
   child selector can reach), it leaves the box occupying its space, and a
   pseudo-element can still opt back into being visible.

   The collapse arrow stays — it carries no content, and the tree is unusable
   without it. */
${SCOPE} .tree-item-self .iconize-icon {
  position: relative;
  visibility: hidden;
}

${SCOPE} .tree-item-self .iconize-icon::after {
  content: "";
  visibility: visible;
  position: absolute;
  inset: 1px;
  border-radius: 3px;
  background-color: var(--immersive-folder-bar);
  opacity: var(--immersive-folder-bar-opacity);
}

/* The file-type tag is a word, so it goes the way the labels do. */
${SCOPE} .tree-item-self .nav-file-tag {
  opacity: 0;
}`;
}

/* …and the rows it spares. Each selector below carries more class-units than
   the cover above it, so it wins on specificity rather than on source order. */
function revealRules(selectors: string[]): string {
  const inner = selectors.map((s) => `${s} .tree-item-inner`);
  const icons = selectors.map((s) => `${s} .iconize-icon`);
  const tags = selectors.map((s) => `${s} .nav-file-tag`);

  return `${inner.join(",\n")} {
  color: inherit;
}

${inner.map((s) => `${s}::after`).join(",\n")} {
  content: none;
}

${icons.join(",\n")} {
  visibility: visible;
}

${icons.map((s) => `${s}::after`).join(",\n")} {
  content: none;
}

${tags.join(",\n")} {
  opacity: 1;
}`;
}

/* "a/b/c" → ["a", "a/b", "a/b/c"] — the folder and every folder above it. */
function ancestry(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/* data-path holds whatever the user named the folder, quotes and backslashes
   included. JSON's string escaping is a subset of CSS's and covers both; a
   name cannot contain a newline, which is the one case where they differ. */
function quote(value: string): string {
  return JSON.stringify(value);
}

class ImmersiveFolderSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ImmersiveFolderPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    /* Deliberately no on/off switch here. The cover is something you flick
       while you work, and it already has a button sitting where the work is,
       plus a command to bind. A third copy buried two menus deep would only
       be somewhere for the user's idea of the state to drift out of step with
       the button in front of them. What settings are for is the behaviour
       below, which you set once and forget. */
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The cover is switched from the button at the top of the file " +
        "explorer — three rows with the middle one picked out. It takes on " +
        "your accent colour while the cover is up. The “Toggle immersive " +
        "folder” command does the same, if you would rather bind a hotkey.",
    });

    new Setting(containerEl)
      .setName("Show the trail back to the root")
      .setDesc(
        "Keeps the names of the folders above the one you are in, so you can still tell where you are. Turn it off to skeleton the trail as well."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.revealTrail)
          .onChange(async (value) => {
            this.plugin.settings.revealTrail = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Keep the active file in view")
      .setDesc(
        "Scrolls the explorer to each note as you switch to it, expanding whatever it takes to show it. Without this, switching to a note whose folder is scrolled out of view leaves you looking at bars alone."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.keepActiveInView)
          .onChange(async (value) => {
            this.plugin.settings.keepActiveInView = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Collapse every other folder")
      .setDesc(
        "On each switch, folds away every folder except the one you are in. Less to scroll past, and it stops the bars from giving away how many files the other folders hold. Whatever was open is restored when you leave immersive mode."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.collapseOthers)
          .onChange((value) => void this.plugin.applyCollapseOthers(value))
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Immersive folder is a visual cover, not encryption. It is built " +
        "for screen sharing, recordings and the person sitting next to you " +
        "— the names are still in the page for anyone with developer tools.",
    });
  }
}
