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
  revealOnEnable: boolean;
}

/* app.commands is real but absent from the public typings. */
interface AppWithCommands {
  commands: { executeCommandById(id: string): boolean };
}

const DEFAULT_SETTINGS: ImmersiveFolderSettings = {
  enabled: false,
  revealTrail: true,
  revealOnEnable: true,
};

/* Everything the plugin draws hangs off this one body class, so lifting the
   cover is a single class away and can never leave half-covered rows behind. */
const BODY_CLASS = "immersive-folder-on";
const BUTTON_CLASS = "immersive-folder-button";
const STYLE_ID = "immersive-folder-rules";
const SCOPE = `.${BODY_CLASS} .nav-files-container`;

const ICON_ON = "immersive-folder-on";
const ICON_OFF = "immersive-folder-off";

/* The button draws the plugin's own idea rather than a stock glyph: rows of
   text with one of them brought forward. Off is three plain rows; on drops the
   outer two back and thickens the middle one, which is the covered list in
   miniature.

   addIcon draws into a 0 0 100 100 box, and Obsidian's .svg-icon rule sets
   stroke-width for a 24-unit box, so every stroke states its own width here or
   it renders hairline-thin. At the ~18px this is displayed at, arrowheads of
   the kind iA Writer can afford collapse into specks — the weight contrast has
   to carry the meaning on its own. */
function registerIcons(): void {
  const row = (d: string, extra = "") =>
    `<path d="${d}" fill="none" stroke="currentColor" stroke-linecap="round" ${extra}/>`;

  addIcon(
    ICON_OFF,
    row("M20 28 H80", 'stroke-width="9"') +
      row("M20 50 H80", 'stroke-width="9"') +
      row("M20 72 H80", 'stroke-width="9"')
  );

  addIcon(
    ICON_ON,
    row("M24 28 H76", 'stroke-width="8" opacity="0.3"') +
      row("M16 50 H84", 'stroke-width="11"') +
      row("M24 72 H76", 'stroke-width="8" opacity="0.3"')
  );
}

export default class ImmersiveFolderPlugin extends Plugin {
  settings: ImmersiveFolderSettings = { ...DEFAULT_SETTINGS };
  private styleEl: HTMLStyleElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    registerIcons();

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
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();

    /* Switching on while the folder you are in is scrolled off-screen leaves
       nothing but bars in view, which reads as a broken plugin rather than a
       working one. Obsidian's own reveal expands the folder and scrolls to
       it, so the one readable thing is the thing you are looking at.
       Only on the way on: doing it on every redraw would yank the explorer
       around every time you switched notes. */
    if (this.settings.enabled && this.settings.revealOnEnable) {
      (this.app as unknown as AppWithCommands).commands.executeCommandById(
        "file-explorer:reveal-active-file"
      );
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.redraw();
  }

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  private redraw(): void {
    const rules = this.buildRules();
    /* An empty sheet is the safe state: no bars, no gaps, the explorer
       exactly as the theme drew it. */
    document.body.toggleClass(BODY_CLASS, rules !== "");
    if (this.styleEl) this.styleEl.textContent = rules;
    this.syncButtons();
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
        button.addEventListener("click", () => void this.toggle());
      }

      const on = this.settings.enabled;
      button.empty();
      setIcon(button, on ? ICON_ON : ICON_OFF);
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

    new Setting(containerEl)
      .setName("Immersive folder")
      .setDesc(
        "Also on the eye button at the top of the file explorer, and on the “Toggle immersive folder” command if you want a hotkey."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        })
      );

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
      .setName("Jump to the folder when switching on")
      .setDesc(
        "Expands and scrolls to the folder you are in, so you are not left looking at a screen of bars when the folder happens to be scrolled out of view."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.revealOnEnable)
          .onChange(async (value) => {
            this.plugin.settings.revealOnEnable = value;
            await this.plugin.saveSettings();
          })
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
