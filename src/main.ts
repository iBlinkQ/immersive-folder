import {
  addIcon,
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  setIcon,
} from "obsidian";

type Language = "auto" | "en" | "zh";

interface ImmersiveFolderSettings {
  language: Language;
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

/* Narrowed from unknown rather than asserted from a view type: an assertion
   would hand every later property access whatever the compiler happens to
   know about a leaf's view, which in a lint run without Obsidian's types is
   `any` — and one `any` here spreads through every folder that gets
   collapsed. Going through unknown means the compiler has nothing to
   propagate, and the check below is what grants the type. */
/* Object.entries is typed as returning any[] once the object's own type is
   not in scope, and that any leaks into every loop below. Object.keys returns
   string[] whatever the compiler knows, and indexing back in is typed by the
   Record — so nothing here is ever any. */
function entriesOf(
  items: Record<string, ExplorerItem>
): [string, ExplorerItem][] {
  return Object.keys(items).map((key): [string, ExplorerItem] => [
    key,
    items[key],
  ]);
}

function isExplorerView(view: unknown): view is FileExplorerView {
  if (typeof view !== "object" || view === null) return false;
  const items = (view as { fileItems?: unknown }).fileItems;
  return typeof items === "object" && items !== null;
}

const DEFAULT_SETTINGS: ImmersiveFolderSettings = {
  language: "auto",
  enabled: false,
  revealTrail: true,
  keepActiveInView: true,
  collapseOthers: true,
  expandedBefore: [],
};


/* Every user-facing string in one place, so a new language is a matter of
   adding one object rather than hunting through the file. */
interface Strings {
  command: string;
  introName: string;
  disclaimerName: string;
  ariaOn: string;
  ariaOff: string;
  intro: string;
  language: string;
  languageDesc: string;
  languageAuto: string;
  trail: string;
  trailDesc: string;
  keepInView: string;
  keepInViewDesc: string;
  collapse: string;
  collapseDesc: string;
  disclaimer: string;
}

const EN: Strings = {
  command: "Toggle immersive folder",
  ariaOn: "Leave immersive folder",
  ariaOff: "Immerse in this folder",
  introName: "Switching it on",
  disclaimerName: "What it does not do",
  intro:
    "The cover is switched from the button at the top of the file explorer " +
    "— three rows with the middle one picked out. It takes on your accent " +
    "colour while the cover is up. The “Toggle immersive folder” command " +
    "does the same, if you would rather bind a hotkey.",
  language: "Language",
  languageDesc:
    "Follows whatever language Obsidian is set to, unless you pick one here.",
  languageAuto: "Match Obsidian",
  trail: "Show the trail back to the root",
  trailDesc:
    "Keeps the names of the folders above the one you are in, so you can " +
    "still tell where you are. Turn it off to skeleton the trail as well.",
  keepInView: "Keep the active file in view",
  keepInViewDesc:
    "Scrolls the explorer to each note as you switch to it, expanding " +
    "whatever it takes to show it. Without this, switching to a note whose " +
    "folder is scrolled out of view leaves you looking at bars alone.",
  collapse: "Collapse every other folder",
  collapseDesc:
    "On each switch, folds away every folder except the one you are in. " +
    "Less to scroll past, and it stops the bars from giving away how many " +
    "files the other folders hold. Whatever was open is restored when you " +
    "leave immersive mode.",
  disclaimer:
    "Immersive folder is a visual cover, not encryption. It is built for " +
    "screen sharing, recordings and the person sitting next to you — the " +
    "names are still in the page for anyone with developer tools.",
};

const ZH: Strings = {
  command: "切换沉浸模式",
  ariaOn: "退出沉浸模式",
  ariaOff: "沉浸到当前文件夹",
  introName: "怎么开关",
  disclaimerName: "它做不到什么",
  intro:
    "遮挡的开关在文件列表顶部那个按钮上 —— 三行横线、中间一行被挑出来的那个。" +
    "遮挡开启时它会染上你的主题强调色。命令面板里的「切换沉浸模式」是同一个开关，" +
    "想绑快捷键就用它。",
  language: "语言",
  languageDesc: "默认跟随 Obsidian 的界面语言，也可以在这里单独指定。",
  languageAuto: "跟随 Obsidian",
  trail: "保留回到根目录的路径",
  trailDesc:
    "保留你所在文件夹上层那些文件夹的名字，这样你还知道自己在树的哪个位置。" +
    "关掉之后，这条路径也会一并变成骨架条。",
  keepInView: "让当前文件始终可见",
  keepInViewDesc:
    "每次切换笔记时把文件列表滚动过去，需要展开哪些文件夹就展开哪些。" +
    "没有这个的话，切到一篇所在文件夹被滚出视野的笔记，你会只看到满屏骨架条。",
  collapse: "收起其他所有文件夹",
  collapseDesc:
    "每次切换时，把除当前文件夹之外的都折叠起来。既少了要滚过的内容，" +
    "也堵上了骨架条泄露「其他文件夹里有多少文件」这个口子。" +
    "退出沉浸模式时，原本展开的会照原样还给你。",
  disclaimer:
    "沉浸模式是视觉遮挡，不是加密。它是为投屏、录屏和你旁边那个人准备的 —— " +
    "那些名字仍然在页面里，任何人打开开发者工具都能读到。",
};

/* Obsidian stamps its UI language onto <html lang>, which is public enough
   to read without reaching into anything private. */
function stringsFor(language: Language): Strings {
  const lang =
    language === "auto"
      ? document.documentElement.lang || "en"
      : language;
  return lang.startsWith("zh") ? ZH : EN;
}

/* Everything the plugin draws hangs off this one body class, so lifting the
   cover is a single class away and can never leave half-covered rows behind. */
const BODY_CLASS = "immersive-folder-on";
const BUTTON_CLASS = "immersive-folder-button";
/* Marks a row the cover should spare. Set from here, matched in styles.css:
   the rules there cannot know which folder is focused, so they cover
   everything and let this class carve out the exceptions. */
const REVEAL_CLASS = "immersive-folder-reveal";

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
  private lastSyncedPath: string | null = null;
  /* Null while the cover is down. An empty string means the vault root. */
  private focusPath: string | null = null;
  /* The explorer builds and discards rows as you scroll, so a row can turn up
     at any moment and has to arrive already marked. */
  private readonly observer = new MutationObserver(() => this.applyMarks());

  async onload(): Promise<void> {
    await this.loadSettings();
    registerIcon();

    this.register(() => document.body.removeClass(BODY_CLASS));
    this.register(() => this.observer.disconnect());
    this.register(() => this.clearMarks());
    this.register(() => this.removeButtons());

    this.registerToggleCommand();

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

  /* The active vocabulary. Read fresh each time rather than cached, so
     changing the setting takes effect on the next redraw. */
  get t(): Strings {
    return stringsFor(this.settings.language);
  }

  /* Registering the same id again replaces the command, which is how the
     name follows a language change without a reload. */
  registerToggleCommand(): void {
    this.addCommand({
      id: "toggle",
      name: this.t.command,
      callback: () => void this.toggle(),
    });
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
    const folder = this.settings.enabled
      ? this.app.workspace.getActiveFile()?.parent
      : undefined;

    /* Nothing open means no folder to focus on. Covering the lot would leave
       a column of anonymous bars with no way to navigate out of it, so the
       cover lifts itself until something is open again. No focus, no body
       class: the explorer is exactly as the theme drew it. */
    this.focusPath = folder ? (folder.isRoot() ? "" : folder.path) : null;

    document.body.toggleClass(BODY_CLASS, this.focusPath !== null);
    this.observeExplorer();
    this.applyMarks();
    this.syncButtons();
    this.syncExplorer();
  }

  private observeExplorer(): void {
    for (const container of Array.from(
      document.querySelectorAll(".nav-files-container")
    )) {
      /* childList only. Marking a row sets a class, and watching attributes
         as well would make every pass schedule another one. Re-observing a
         container it already watches is harmless. */
      this.observer.observe(container, { childList: true, subtree: true });
    }
  }

  private applyMarks(): void {
    const focus = this.focusPath;
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>(
        ".nav-files-container .tree-item-self[data-path]"
      )
    )) {
      const path = row.getAttribute("data-path");
      row.toggleClass(
        REVEAL_CLASS,
        focus !== null && path !== null && this.spares(path, focus)
      );
    }
  }

  private clearMarks(): void {
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>(`.${REVEAL_CLASS}`)
    )) {
      row.removeClass(REVEAL_CLASS);
    }
  }

  /* Which rows keep their real name: the focused folder itself, the trail
     back to the root when asked for, and the folder's direct children — one
     segment further down and no deeper. Comparing paths rather than walking
     the DOM means a row is judged the moment it is created, however the
     explorer chose to nest it. */
  private spares(path: string, focus: string): boolean {
    /* Focused on the vault root: its own rows are the ones with no separator
       anywhere in their path. */
    if (focus === "") return !path.includes("/");
    if (path === focus) return true;
    if (focus.startsWith(`${path}/`)) return this.settings.revealTrail;
    if (path.startsWith(`${focus}/`)) {
      return !path.slice(focus.length + 1).includes("/");
    }
    return false;
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
      for (const [path, item] of entriesOf(view.fileItems)) {
        if (!item.collapsible || item.collapsed) continue;
        if (keep && (keep === path || keep.startsWith(`${path}/`))) continue;
        item.setCollapsed(true);
      }
    }
  }

  private captureExpanded(): void {
    const open: string[] = [];
    for (const view of this.explorerViews()) {
      for (const [path, item] of entriesOf(view.fileItems)) {
        if (item.collapsible && !item.collapsed) open.push(path);
      }
    }
    this.settings.expandedBefore = open;
  }

  private restoreExpanded(): void {
    const wanted = new Set(this.settings.expandedBefore);
    for (const view of this.explorerViews()) {
      for (const [path, item] of entriesOf(view.fileItems)) {
        if (item.collapsible && item.collapsed && wanted.has(path)) {
          item.setCollapsed(false);
        }
      }
    }
    this.settings.expandedBefore = [];
  }

  private *explorerViews(): Generator<FileExplorerView> {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const view: unknown = leaf.view;
      if (isExplorerView(view)) yield view;
    }
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
        on ? this.t.ariaOn : this.t.ariaOff
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
class ImmersiveFolderSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ImmersiveFolderPlugin) {
    super(app, plugin);
  }

  /* The declarative form, used from 1.13.0 on. Returning a non-empty array
     means display() below is never called — it stays only because
     minAppVersion is 1.12.0, where this method does not exist yet and the
     imperative path is the only one there is. Both are built from the same
     string table, so they cannot drift apart in wording. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const t = this.plugin.t;
    return [
      /* Prose rows rather than loose paragraphs: a definition needs a name,
         and giving these one puts them in the settings search, where someone
         hunting for "hotkey" or "privacy" has a chance of meeting them. */
      { name: t.introName, desc: t.intro },
      {
        name: t.language,
        desc: t.languageDesc,
        control: {
          type: "dropdown",
          key: "language",
          options: { auto: t.languageAuto, en: "English", zh: "简体中文" },
        },
      },
      {
        name: t.trail,
        desc: t.trailDesc,
        control: { type: "toggle", key: "revealTrail" },
      },
      {
        name: t.keepInView,
        desc: t.keepInViewDesc,
        control: { type: "toggle", key: "keepActiveInView" },
      },
      {
        name: t.collapse,
        desc: t.collapseDesc,
        control: { type: "toggle", key: "collapseOthers" },
      },
      { name: t.disclaimerName, desc: t.disclaimer },
    ];
  }

  /* Spread into a Record rather than indexed directly: the settings object is
     keyed by a union of literals, and a bare string index would not compile
     against it. */
  getControlValue(key: string): unknown {
    const settings: Record<string, unknown> = { ...this.plugin.settings };
    return settings[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const plugin = this.plugin;
    switch (key) {
      case "language":
        plugin.settings.language = value as Language;
        await plugin.saveSettings();
        /* Every label on this page, and the command's name, came from the
           language that just changed. */
        plugin.registerToggleCommand();
        this.update();
        return;
      case "collapseOthers":
        /* Folding and unfolding the tree is a side effect, not just a stored
           flag, so this one goes through the plugin rather than being
           written here. */
        await plugin.applyCollapseOthers(Boolean(value));
        return;
      case "revealTrail":
        plugin.settings.revealTrail = Boolean(value);
        break;
      case "keepActiveInView":
        plugin.settings.keepActiveInView = Boolean(value);
        break;
      default:
        return;
    }
    await plugin.saveSettings();
  }

  /* Fallback for 1.12.x. Kept in step with getSettingDefinitions() above. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const t = this.plugin.t;

    /* Deliberately no on/off switch here. The cover is something you flick
       while you work, and it already has a button sitting where the work is,
       plus a command to bind. A third copy buried two menus deep would only
       be somewhere for the user's idea of the state to drift out of step with
       the button in front of them. What settings are for is the behaviour
       below, which you set once and forget. */
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t.intro,
    });

    /* First, and not last: someone who cannot read the rest of this page is
       exactly the person who needs to find this row. */
    new Setting(containerEl)
      .setName(t.language)
      .setDesc(t.languageDesc)
      .addDropdown((drop) =>
        drop
          .addOption("auto", t.languageAuto)
          .addOption("en", "English")
          .addOption("zh", "简体中文")
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as Language;
            await this.plugin.saveSettings();
            /* The command name is fixed at registration, so it has to be
               registered again to follow the new language. */
            this.plugin.registerToggleCommand();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t.trail)
      .setDesc(t.trailDesc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.revealTrail)
          .onChange(async (value) => {
            this.plugin.settings.revealTrail = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t.keepInView)
      .setDesc(t.keepInViewDesc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.keepActiveInView)
          .onChange(async (value) => {
            this.plugin.settings.keepActiveInView = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t.collapse)
      .setDesc(t.collapseDesc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.collapseOthers)
          .onChange((value) => void this.plugin.applyCollapseOthers(value))
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t.disclaimer,
    });
  }
}
