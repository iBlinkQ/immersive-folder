import {
  addIcon,
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  SettingDefinitionItem,
  setIcon,
  TFolder,
} from "obsidian";

/* The explorer's own insides — declared and runtime-checked in one place. */
import {
  entriesOf,
  FileExplorerView,
  FileTreeItem,
  isExplorerView,
  patchSorting,
  SortPatch,
  sortView,
  visibleRowOrder,
} from "./explorer-api";
import { Orders, OrderStore } from "./order";
import { animateReorder, DragSort } from "./dnd";

type Language = "auto" | "en" | "zh";

/* Which of the plugin's two buttons sit in the explorer's toolbar. Both are
   stateful switches, so neither is ever folded away into a menu: the accent
   wash on the button *is* the readout for "is this mode on right now", and a
   menu would trade that away for a click. What this setting is for is the
   person who only ever wanted one of the two features — not for making the
   toolbar fit, which is not a fight this plugin can win anyway (see
   syncButtons). */
type ToolbarButtons = "both" | "immersive" | "sort" | "none";

interface ImmersiveFolderSettings {
  language: Language;
  toolbarButtons: ToolbarButtons;
  enabled: boolean;
  keepActiveInView: boolean;
  collapseOthers: boolean;
  /* How far down the cover reaches: with this on it spares everything inside
     the focused folder however deep, instead of only the row sitting directly
     in it. See spares(). */
  revealSubfolders: boolean;
  /* How far up: with this on the folders above the focused one keep their
     names, the path from it back to the root and nothing beside that path.
     Off by default. See spares(). */
  revealAncestors: boolean;
  /* Which folders were open before the tree was folded down, so leaving
     immersive mode can hand the explorer back the way it was found. */
  expandedBefore: string[];
  /* Keyed by folder path, holding that folder's *subfolders* in the order the
     user arranged them. Only folders that have been dragged in appear here,
     and files never appear at all — see order.ts. */
  orders: Orders;
}

/* app.commands is real but absent from the public typings. */
interface AppWithCommands {
  commands: { executeCommandById(id: string): boolean };
}

/* Same story for app.setting. Every hop is optional so that a build which
   renamed any of it quietly does nothing instead of throwing: this is a
   convenience on top of a page the user can always reach by hand. */
interface AppWithSetting {
  setting?: {
    open?(): void;
    openTabById?(id: string): { setQuery?(query: string): void } | undefined;
  };
}

/* Hiding a button is only a fair trade if the way back is one click away, and
   "go bind a hotkey yourself" is not one click — it is a page to find and a
   name to remember. So the row that suggests it also does it. */
function openHotkeySettings(app: App, query: string): void {
  const setting = (app as unknown as AppWithSetting).setting;
  setting?.open?.();
  setting?.openTabById?.("hotkeys")?.setQuery?.(query);
}

const DEFAULT_SETTINGS: ImmersiveFolderSettings = {
  language: "auto",
  toolbarButtons: "both",
  enabled: false,
  keepActiveInView: true,
  collapseOthers: true,
  revealSubfolders: true,
  revealAncestors: false,
  expandedBefore: [],
  orders: {},
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
  toolbar: string;
  toolbarDesc: string;
  toolbarBoth: string;
  toolbarImmersive: string;
  toolbarSort: string;
  toolbarNone: string;
  hotkeyName: string;
  hotkeyDesc: string;
  keepInView: string;
  keepInViewDesc: string;
  collapse: string;
  collapseDesc: string;
  revealInside: string;
  revealInsideDesc: string;
  revealAbove: string;
  revealAboveDesc: string;
  disclaimer: string;
  dragName: string;
  dragIntro: string;
  sortModeOn: string;
  sortModeOff: string;
  sortCommand: string;
  dragHint: string;
  /* The line above the tree while arranging; `{key}` is drawn as the key. */
  sortExitHint: string;
  /* Nothing open, so nothing to immerse in. */
  needFile: string;
  /* The two modes take turns, and each refusal says which one is in the way. */
  blockedBySort: string;
  blockedByCover: string;
  sortUnavailable: string;
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
  toolbar: "Toolbar buttons",
  toolbarDesc:
    "Which of this plugin's two buttons sit at the top of the file explorer. " +
    "Both are switches that show whether their mode is on, so both stay in " +
    "plain sight by default — hide one if you only ever use the other " +
    "feature. Whatever you hide is still on the command palette.",
  toolbarBoth: "Show both",
  toolbarImmersive: "Immersive folder only",
  toolbarSort: "Folder arrange only",
  toolbarNone: "Hide both",
  hotkeyName: "Set a hotkey for what you hid",
  hotkeyDesc:
    "A hidden button leaves the command as the only way in. Opens Obsidian's " +
    "hotkeys page with this plugin's commands already filtered.",
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
  revealInside: "Keep everything inside this folder readable",
  revealInsideDesc:
    "The cover spares the folder you are in and whatever sits directly in " +
    "it. Switch this on and it spares the rest of the way down as well: " +
    "open a subfolder and its contents read normally instead of turning " +
    "into bars. The folders beside the one you are in are covered either " +
    "way; the ones above it have a setting of their own, just below.",
  revealAbove: "Keep the folders above this one readable",
  revealAboveDesc:
    "Every folder from the one you are in back up to the vault root keeps " +
    "its name, so you can still tell where you are in the tree. Off by " +
    "default, because a top-level folder name is often the most telling " +
    "thing on the screen. Only the path itself is spared: the folders beside " +
    "it stay covered either way.",
  disclaimer:
    "Immersive folder is a visual cover, not encryption. It is built for " +
    "screen sharing, recordings and the person sitting next to you — the " +
    "names are still in the page for anyone with developer tools.",
  dragName: "Arranging the folders by hand",
  dragIntro:
    "The up-and-down arrow button at the top of the file explorer switches " +
    "on folder arrange mode; the same button or Escape leaves it again. " +
    "Every folder grows a handle and starts to drift, and " +
    "dragging one sets where it sits among its sibling folders — hold one " +
    "and only the folders that can take it keep moving, while the rest dim. " +
    "Files are left out of it entirely: they grow no handle and stay exactly " +
    "where the sort menu put them, so switching between name and date still " +
    "does what it always did. Ordinary dragging is untouched too — switch " +
    "the mode off and moving a note into another folder works as before. " +
    "This only ever reorders, and never moves anything. Immersive mode and " +
    "arrange mode take turns: leave one to open the other.",
  sortModeOff: "Arrange the folders",
  sortModeOn: "Done arranging",
  sortCommand: "Toggle folder arrange mode",
  dragHint: "Drag to reorder",
  sortExitHint: "Press {key} when you are done",
  needFile: "Open a note first",
  blockedBySort: "Leave folder arrange mode first",
  blockedByCover: "Leave immersive folder first",
  sortUnavailable:
    "This build of Obsidian does not expose the file explorer's sorting, so " +
    "the folders cannot be arranged.",
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
  toolbar: "工具栏按钮",
  toolbarDesc:
    "本插件的两个按钮里，哪些留在文件列表顶部。它们都是能看出模式开没开的开关，" +
    "所以默认都摆在明面上 —— 如果你只用其中一个功能，可以把另一个藏起来。" +
    "藏起来的那个，命令面板里照样能用。",
  toolbarBoth: "两个都显示",
  toolbarImmersive: "只显示沉浸模式",
  toolbarSort: "只显示调整文件夹顺序",
  toolbarNone: "两个都不显示",
  hotkeyName: "给藏起来的功能设置快捷键",
  hotkeyDesc:
    "按钮藏起来之后，命令就成了唯一的入口。点这里直接打开 Obsidian 的快捷键页面，" +
    "并且已经筛好了本插件的命令。",
  keepInView: "让当前文件始终可见",
  keepInViewDesc:
    "每次切换笔记时把文件列表滚动过去，需要展开哪些文件夹就展开哪些。" +
    "没有这个的话，切到一篇所在文件夹被滚出视野的笔记，你会只看到满屏骨架条。",
  collapse: "收起其他所有文件夹",
  collapseDesc:
    "每次切换时，把除当前文件夹之外的都折叠起来。既少了要滚过的内容，" +
    "也堵上了骨架条泄露「其他文件夹里有多少文件」这个口子。" +
    "退出沉浸模式时，原本展开的会照原样还给你。",
  revealInside: "显示当前文件夹里的所有层级",
  revealInsideDesc:
    "开启沉浸模式后，当前文件夹里不管展开到第几层，文件名和文件夹名都照常显示。" +
    "关掉这一项，就只显示直接放在它里面的文件和文件夹，再往里展开一层又是骨架条。" +
    "当前文件夹以外不受影响，旁边的文件夹一律遮住，上层文件夹看下一项。",
  revealAbove: "显示上层文件夹",
  revealAboveDesc:
    "开启沉浸模式后，从当前文件夹往上一直到库的根目录，沿途每一层文件夹的名字都照常显示，" +
    "看得出自己在树的哪个位置。默认关闭，上层文件夹和其他文件夹一样变成骨架条 —— " +
    "顶层文件夹的名字往往最能透露你在做什么。只放开这条路径本身，路径旁边的文件夹照样遮住。",
  disclaimer:
    "沉浸模式是视觉遮挡，不是加密。它是为投屏、录屏和你旁边那个人准备的 —— " +
    "那些名字仍然在页面里，任何人打开开发者工具都能读到。",
  dragName: "手动排列文件夹",
  dragIntro:
    "文件列表顶部那个上下箭头按钮打开「调整文件夹顺序」模式，再点一次或者按 Esc 都能退出。" +
    "每个文件夹都会长出手柄并" +
    "轻轻浮动，拖动它就能决定它排在同级文件夹中间的哪个位置 —— 按住其中一个时，" +
    "只有能接住它的同级文件夹继续浮动，其余会变暗。文件完全不参与：它们不会长出手柄，" +
    "始终待在排序菜单给它们的位置上，所以按文件名或按时间排序照样是原来的效果。" +
    "平时的拖拽也完全没变，关掉这个模式，把笔记拖进别的文件夹和以前一模一样。" +
    "本插件只调顺序，绝不移动任何东西。沉浸模式和调整顺序模式轮流使用，" +
    "要开一个得先关掉另一个。",
  sortModeOff: "调整文件夹顺序",
  sortModeOn: "完成调整",
  sortCommand: "切换调整文件夹顺序模式",
  dragHint: "拖动调整排序",
  sortExitHint: "按 {key} 完成调整",
  needFile: "请先打开一篇笔记",
  blockedBySort: "请先退出「调整文件夹顺序」模式",

  blockedByCover: "请先退出沉浸模式",
  sortUnavailable: "当前 Obsidian 没有暴露文件列表的排序，无法调整文件夹顺序。",
};

/* Obsidian stamps its UI language onto <html lang>, which is public enough to
   read without reaching into anything private. This one deliberately stays on
   the plain `document`: it is a global setting, and the main window is where
   it is guaranteed to be stamped. Everything that *draws* goes through
   explorerDocuments() instead, which is a different question — not "which
   window has focus" but "which windows are showing a file tree". */

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
const SORT_BUTTON_CLASS = "immersive-folder-sort-button";
/* On whichever of the two buttons is waiting for the other mode to finish. */
const DISABLED_CLASS = "immersive-folder-blocked";
/* Marks a row the cover should spare. Set from here, matched in styles.css:
   the rules there cannot know which folder is focused, so they cover
   everything and let this class carve out the exceptions. */
const REVEAL_CLASS = "immersive-folder-reveal";
/* How faint a covered row is drawn, as one of this many shades, so the bars
   closest to what you are reading stay firm and the ends of the list recede.
   The stylesheet draws the shades; the number here only has to agree with
   it. Ten rather than a handful because the shades are spread across the
   whole list: with six, four rows out of five landed on the faintest one and
   the fade was a thin edge around the readable block rather than something
   the list as a whole did. */
const FADE_STEPS = 10;
const FADE_CLASS = "immersive-folder-fade-";
/* On the body only while the cover is drawing itself in or lifting off, so
   the sweep in styles.css plays on the switch and on nothing else — not on a
   row scrolled into view a minute later, nor on the bars that change hands
   when you move to a note in another folder. */
const ENTERING_CLASS = "immersive-folder-entering";
const LEAVING_CLASS = "immersive-folder-leaving";
/* The prefix both of the sweep's keyframes share, which is how its
   animations are told apart from everything else running in the window. */
const SWEEP_ANIMATION = "immersive-folder-sweep";
/* The longest a sweep is waited on, whatever the animations say. */
const SWEEP_CAP_MS = 4000;

interface Sweep {
  way: "in" | "out";
  /* The folder the cover was drawn around as the switch was thrown. On the
     way out it stays drawn there — readable block and all — until the light
     has crossed every bar; see redraw(). */
  from: string | null;
  /* Null until the sweep's first redraw has run and the wait has begun. */
  timer: number | null;
}

const ICON = "immersive-folder";
const SORT_ICON = "immersive-folder-sort";

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

  /* The arrange button. A grip was tried first and read wrong on a toolbar:
     six dots say "drag me", but the button is not draggable — it is a switch.
     An axis with an arrow at each end says what the mode does instead, which
     is let things move up and down. */
  const stroke = 'stroke-width="8" stroke-linejoin="round"';
  addIcon(
    SORT_ICON,
    row("M50 40 V14", stroke) +
      row("M37 27 L50 14 L63 27", stroke) +
      row("M24 50 H76", stroke) +
      row("M50 60 V86", stroke) +
      row("M37 73 L50 86 L63 73", stroke)
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
  readonly orderStore = new OrderStore(this);
  private readonly dragSort = new DragSort({
    /* Read fresh rather than passed once, so switching language takes effect
       on the next pass without re-creating anything. */
    hint: () => this.t.dragHint,
    documents: () => this.explorerDocuments(),
    canDrag: (row) => this.canDrag(row),
    /* Escape, from inside the mode. Not toggleSortMode(): that one asks
       whether the mode may be opened, and this direction never needs asking
       — leaving is always allowed. */
    leave: () => {
      this.dragSort.setActive(false);
      this.syncButtons();
    },
    /* Not on mobile: a phone has no Escape key, and a line naming one is
       noise. The button is the way out there, as it always was. */
    exitHint: () => (Platform.isMobile ? null : this.t.sortExitHint),
    commit: (folderPath, moving, target, position) =>
      void this.commitMove(folderPath, moving, target, position),
  });
  /* Null until the explorer has been found and its prototype patched, and
     null again for good on an Obsidian that does not have the methods. */
  private sortPatch: SortPatch | null = null;
  /* The documents currently carrying the body class. Kept rather than
     recomputed on the way out, because a document can stop holding an
     explorer — a popped-out sidebar docked back into the main window — and the
     class then has to come off the one it left behind, which no query for
     "documents with an explorer in them" would still find. */
  private readonly painted = new Set<Document>();
  /* The cover drawing itself in or lifting off, while it does. */
  private sweep: Sweep | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    registerIcon();

    this.register(() => this.unpaint());
    this.register(() => this.observer.disconnect());
    this.register(() => this.clearMarks());
    this.register(() => this.removeButtons());
    this.register(() => this.releaseSorting());
    this.register(() => this.dragSort.setActive(false));
    this.register(() => this.dropSweep());

    this.registerToggleCommand();
    this.registerSortCommand();

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

    /* Pruning waits for the layout: it asks the vault whether each recorded
       path still exists, and before the vault has finished indexing every
       folder would look deleted. */
    this.app.workspace.onLayoutReady(() => {
      const pruned = this.orderStore.prune(
        (path) => this.app.vault.getAbstractFileByPath(path) !== null
      );
      if (pruned) void this.saveOrders();
      this.registerOrderEvents();
      redraw();
    });
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

  registerSortCommand(): void {
    this.addCommand({
      id: "toggle-sort-mode",
      name: this.t.sortCommand,
      callback: () => this.toggleSortMode(),
    });
  }

  async toggle(): Promise<void> {
    /* The two modes take turns. The cover replaces the very names you would
       be arranging by, so one has to be off for the other to mean anything.
       Refused rather than resolved silently: this switch's job is the cover,
       and closing arrange mode on the way past would owe the user a restore
       afterwards — state that arrange mode deliberately does not keep. */
    if (this.dragSort.isActive()) {
      new Notice(this.t.blockedBySort);
      return;
    }

    const turningOn = !this.settings.enabled;

    /* Nothing open means no folder to immerse in. Switching on regardless is
       what used to happen, and it stored a mode it could not show: the button
       lit over an explorer it had not touched, and then the cover sprang up by
       itself at whatever note was opened next. Say why instead.

       Only on the way on. Leaving is never refused, whatever is or is not
       open — closing your last note must not lock you inside the mode. */
    if (turningOn && !this.app.workspace.getActiveFile()) {
      new Notice(this.t.needFile);
      return;
    }

    if (this.settings.collapseOthers) {
      if (turningOn) this.captureExpanded();
      else this.restoreExpanded();
    }

    this.settings.enabled = turningOn;
    /* Force the next sync through: the file has not changed, but the tree
       around it is about to. */
    this.lastSyncedPath = null;
    this.startSweep(turningOn ? "in" : "out");
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

    /* Object.assign copies one level deep, so a settings file with no orders
       key would leave this.settings.orders pointing at the object inside
       DEFAULT_SETTINGS — and since orders are edited in place, every drag
       would write into the defaults themselves. Copy it either way. */
    this.settings.orders = { ...(saved?.orders ?? {}) };

    /* revealOnEnable only fired as the cover came down; keepActiveInView is
       the same idea applied to every switch. Carry the old value over. */
    if (saved && typeof saved.revealOnEnable === "boolean") {
      this.settings.keepActiveInView = saved.revealOnEnable;
    }

    /* Keys that used to be settings and are not any more. Object.assign copies
       whatever the file happens to hold, so without this they would ride along
       in memory and be written straight back out on the next save, leaving a
       settings file advertising switches the plugin no longer has.
     *
       revealTrail is the same idea as revealAncestors, and its name was left
       unused on purpose. It defaulted to on, and a settings file that has not
       been written since it went away can still hold that `true` — reusing
       the name would quietly open the trail for exactly the people who never
       asked for it. */
    const stale = this.settings as unknown as Record<string, unknown>;
    for (const key of ["revealOnEnable", "revealTrail"]) delete stale[key];
  }

  private redraw(): void {
    const folder = this.settings.enabled
      ? this.app.workspace.getActiveFile()?.parent
      : undefined;

    /* Nothing open means no folder to focus on. Covering the lot would leave
       a column of anonymous bars with no way to navigate out of it, so the
       cover lifts itself until something is open again. No focus, no body
       class: the explorer is exactly as the theme drew it.
     *
       The one exception is a cover lifting off. The mode is already off and
       the button already says so, but the bars are still on screen being
       swept away, and the readable block has to stay readable under them —
       so until the sweep is done the cover is drawn where it was. */
    this.focusPath = folder
      ? folder.isRoot()
        ? ""
        : folder.path
      : this.sweep?.way === "out"
        ? this.sweep.from
        : null;

    this.paint();
    this.ensureSortPatched();
    this.observeExplorer();
    this.applyMarks();
    /* Which rows are readable just changed, and an unreadable row must not be
       left holding a grip it cannot use. */
    this.dragSort.refresh();
    this.syncButtons();
    this.syncExplorer();
    if (this.sweep && this.sweep.timer === null) this.timeSweep(this.sweep);
  }

  /* Every document that currently holds a file explorer.
   *
     `activeDocument` used to be the anchor for all of this, and it is the
     wrong one. It follows the *focused window*, not the tree. Pop a note out
     into a window of its own and click into it — or open Settings, which 1.13
     also puts in its own window — and the cover was painted onto a document
     with no file list anywhere in it, while the explorer you were looking at
     sat there uncovered. Measured on a real vault: the class landed on the
     settings window's <body>, and that document answered zero for
     `.nav-files-container`.
   *
     What the cover belongs to is the explorer, so the explorer is what it
     asks. Usually one document; more than one when a sidebar has been popped
     out while another window still shows a tree, and each of those wants the
     same cover.
   *
     Recomputed on every pass rather than cached: a window can open, close, or
     swallow a pane at any time, and every caller here already runs per
     redraw. */
  private explorerDocuments(): Document[] {
    const docs: Document[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const doc = leaf.view.containerEl.ownerDocument;
      if (!docs.includes(doc)) docs.push(doc);
    }
    return docs;
  }

  /* The body class, on every document showing a tree and on no other. */
  private paint(): void {
    const wanted = this.focusPath !== null;
    const live = this.explorerDocuments();

    for (const doc of Array.from(this.painted)) {
      if (wanted && live.includes(doc)) continue;
      doc.body.removeClass(BODY_CLASS, ENTERING_CLASS, LEAVING_CLASS);
      this.painted.delete(doc);
    }
    if (!wanted) return;

    /* The sweep's class goes on in the same pass as the cover's, before
       anything has had a chance to draw: arriving a frame later, it would
       find every bar already in place and have nothing left to sweep in. */
    for (const doc of live) {
      doc.body.addClass(BODY_CLASS);
      doc.body.toggleClass(ENTERING_CLASS, this.sweep?.way === "in");
      doc.body.toggleClass(LEAVING_CLASS, this.sweep?.way === "out");
      this.painted.add(doc);
    }
  }

  private unpaint(): void {
    for (const doc of this.painted) {
      doc.body.removeClass(BODY_CLASS, ENTERING_CLASS, LEAVING_CLASS);
    }
    this.painted.clear();
  }

  /* ── The sweep ─────────────────────────────────────────────────────── */

  /* Thrown with the switch, ahead of the redraw that carries it out. What
     the sweep looks like is all in styles.css; this side owns when its class
     goes on and comes off, and keeping the cover drawn on the way out.
   *
     Only the switch sweeps. The cover also comes and goes on its own — it
     lifts when the last note closes and returns with the next one — and
     those stay instant: nobody asked for anything there, so there is nothing
     to answer with a flourish. */
  private startSweep(way: "in" | "out"): void {
    this.dropSweep();
    /* Switched off with no note open: the cover was not drawn, so there is
       nothing on screen to sweep away. */
    if (way === "out" && this.focusPath === null) return;
    this.sweep = { way, from: this.focusPath, timer: null };
  }

  /* Waits the sweep out, then hands over to an ordinary redraw.
   *
     How long is read off the animations themselves rather than written down
     here, so the stylesheet stays the one place the timing lives: a snippet
     that slows it down, or reduced motion switching it off, is followed
     without this side being told. Read again each time the wait runs out,
     because the rows can change under a running sweep — folding the tree
     away on the way in moves every bar's distance, and its delay with it.
   *
     A timer rather than animationend, for the reason animateReorder gives: a
     window in the background may never finish an animation, and the cover
     has to settle regardless. The cap keeps that promise for a sweep whose
     clock has stopped altogether. */
  private timeSweep(sweep: Sweep): void {
    const started = Date.now();
    const check = () => {
      const left = this.sweepRemaining();
      if (left > 0 && Date.now() - started < SWEEP_CAP_MS) {
        sweep.timer = window.setTimeout(check, left + 30);
      } else {
        this.finishSweep();
      }
    };
    /* Not measured on the spot: the marks this redraw set off are still
       settling, and the first look waits for them. */
    sweep.timer = window.setTimeout(check, 0);
  }

  /* The longest any running sweep still has to go, in milliseconds. */
  private sweepRemaining(): number {
    let left = 0;
    for (const doc of this.explorerDocuments()) {
      for (const animation of doc.getAnimations()) {
        /* By name rather than `instanceof CSSAnimation`, which is bound to
           the window it was evaluated in and says no to every animation in a
           popped-out one. */
        const name = (animation as Partial<CSSAnimation>).animationName;
        if (!name?.startsWith(SWEEP_ANIMATION)) continue;
        const end = animation.effect?.getComputedTiming().endTime;
        const now = animation.currentTime;
        if (typeof end === "number" && typeof now === "number") {
          left = Math.max(left, end - now);
        }
      }
    }
    return left;
  }

  private finishSweep(): void {
    if (!this.sweep) return;
    this.dropSweep();
    this.redraw();
  }

  private dropSweep(): void {
    if (this.sweep?.timer != null) window.clearTimeout(this.sweep.timer);
    this.sweep = null;
  }

  private observeExplorer(): void {
    for (const container of this.explorerQuery(".nav-files-container")) {
      /* childList only. Marking a row sets a class, and watching attributes
         as well would make every pass schedule another one. Re-observing a
         container it already watches is harmless. */
      this.observer.observe(container, { childList: true, subtree: true });
    }
  }

  /* One selector, swept across every document with a tree in it. */
  private explorerQuery(selector: string): HTMLElement[] {
    const found: HTMLElement[] = [];
    for (const doc of this.explorerDocuments()) {
      found.push(...Array.from(doc.querySelectorAll<HTMLElement>(selector)));
    }
    return found;
  }

  private applyMarks(): void {
    const focus = this.focusPath;
    const steps = focus === null ? null : this.fadeSteps(focus);

    for (const row of this.explorerQuery(
      ".nav-files-container .tree-item-self[data-path]"
    )) {
      const path = row.getAttribute("data-path");
      const spared =
        focus !== null && path !== null && this.spares(path, focus);
      row.toggleClass(REVEAL_CLASS, spared);
      this.markFade(
        row,
        spared || path === null ? 0 : (steps?.get(path) ?? 0)
      );
    }
  }

  /* How far each covered row sits from the block of readable ones, counted in
     rows down the screen and capped at the number of shades the stylesheet
     draws.
   *
     Down the screen rather than across the tree. Tree distance was the other
     candidate and it falls apart in the ordinary case: with the note in a
     top-level folder, every covered row is the same number of steps away and
     there is no fade left to draw. Measured on a real vault it gave three
     bands for a folder two deep, with 62% of the bars in the farthest one,
     and one single band for a folder one deep.
   *
     The row numbers come from the explorer's own render tree rather than from
     the document, because the document only holds the rows currently on
     screen — count those and a bar would change shade as you scroll.
   *
     Recomputed on each pass rather than cached. It walks only the rows that
     are actually open, which is the same order of work as the sweep over the
     document that calls it, and a cache would have to be invalidated by every
     fold, sort and rename in the vault. */
  private fadeSteps(focus: string): Map<string, number> {
    const steps = new Map<string, number>();

    for (const view of this.explorerViews()) {
      const order = visibleRowOrder(view);
      if (!order) continue;

      /* Measured from the focused folder and what is inside it, which form
         one unbroken run — a folder and its descendants sit together in a
         depth-first walk — so the two ends of that run are all a distance
         needs. The folders above it are left out even when they are
         readable: they sit apart from that run, with covered rows in
         between, and the fade is about how far a bar is from what you are
         working in, not from every name that happens to be showing. */
      let first = -1;
      let last = -1;
      order.forEach((path, index) => {
        if (!this.within(path, focus)) return;
        if (first < 0) first = index;
        last = index;
      });

      /* Not a row on screen: the focused folder is inside something the user
         folded shut. Nothing to measure from, so nothing fades. */
      if (first < 0) continue;

      /* Distance is scaled to the list rather than counted off in rows: the
         row furthest from what you are reading gets the faintest shade
         whether the list is twelve rows or two hundred. Counting raw rows
         instead made the shades run out a few rows past the readable block,
         leaving everything beyond it flat. Both ends share one scale, so two
         rows the same distance out are drawn alike whichever side they are
         on. */
      const reach = Math.max(first, order.length - 1 - last, 1);

      order.forEach((path, index) => {
        const away =
          index < first ? first - index : index > last ? index - last : 0;
        /* Anything covered at all is at least one shade down, however short
           the trip: a bar drawn exactly like the readable block's neighbours
           would say the cover stops somewhere it does not. */
        const shade =
          away === 0 ? 0 : Math.max(1, Math.round((away / reach) * FADE_STEPS));
        steps.set(path, Math.min(shade, FADE_STEPS));
      });
    }

    return steps;
  }

  /* A class per shade rather than an opacity written onto the element. Every
     value this plugin paints lives in the stylesheet, which is what lets a
     snippet retune both ends of the fade without the plugin being involved —
     the same arrangement the bars themselves already have. */
  private markFade(row: HTMLElement, step: number): void {
    for (let shade = 1; shade <= FADE_STEPS; shade++) {
      row.toggleClass(`${FADE_CLASS}${shade}`, shade === step);
    }
  }

  private clearMarks(): void {
    for (const row of this.explorerQuery(`.${REVEAL_CLASS}`)) {
      row.removeClass(REVEAL_CLASS);
    }
    for (let shade = 1; shade <= FADE_STEPS; shade++) {
      const cls = `${FADE_CLASS}${shade}`;
      for (const row of this.explorerQuery(`.${cls}`)) row.removeClass(cls);
    }
  }

  /* Which rows keep their real name: the focused folder itself and what is
     inside it, plus — only if asked for — the folders above it. Everything
     else goes under a bar, and the folders *beside* the focused one always
     do.
   *
     The trail above was a setting once before, defaulting to on, and was
     taken away because a top-level folder name is usually the most telling
     thing on the screen: the trail was handing away the very names the cover
     is up to hide, and on a plugin built for screen sharing that is a hole
     rather than a preference. It is back as a setting, but the default is
     what closed the hole, and that is what stays — covered unless you open it
     yourself, for when knowing where you are matters more to you than who
     might be looking. Without it, the indentation still tells you how deep
     you are, which the cover never touches.
   *
     Comparing paths rather than walking the DOM means a row is judged the
     moment it is created, however the explorer chose to nest it. */
  private spares(path: string, focus: string): boolean {
    if (this.within(path, focus)) return true;
    /* An ancestor is a path the focus continues from. At the vault root
       nothing is above, and the root's own row is never drawn. */
    return this.settings.revealAncestors && focus.startsWith(`${path}/`);
  }

  /* The focused folder and how far down inside it the cover lets you read.
   *
     How far is a preference. `revealSubfolders` on — the default — means the
     whole subtree: open a subfolder next to the note you are in and you can
     read what is in it, because you opened it on purpose and it is part of
     the folder you are working in. Off is the older, tighter rule: the direct
     children only, one segment down and no deeper, so anything you open below
     that goes back under bars. Note what the loose rule means at the vault
     root, where the focused folder *is* the whole vault: there is nothing
     outside it left to cover, and only "collapse every other folder" keeps
     the tree down. */
  private within(path: string, focus: string): boolean {
    const deep = this.settings.revealSubfolders;
    /* Focused on the vault root: everything is inside it, so the tight rule
       falls back to "no separator anywhere in the path" — the top level and
       nothing under it. */
    if (focus === "") return deep || !path.includes("/");
    if (path === focus) return true;
    if (path.startsWith(`${focus}/`)) {
      return deep || !path.slice(focus.length + 1).includes("/");
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

  /* ── Custom order ──────────────────────────────────────────────────── */

  /* The patch lands on the view's *prototype*, so finding one explorer is
     enough to cover every leaf, including ones opened later. But there has to
     be one to reach the prototype through: the file explorer is normally up
     before the plugin loads, and when it is not — a workspace that starts
     with the sidebar closed — this runs again on the next redraw, which
     layout-change already brings. */
  private ensureSortPatched(): void {
    if (this.sortPatch) return;

    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf) return;

    this.sortPatch = patchSorting(
      leaf.view,
      (folder: TFolder, sorted: FileTreeItem[]) =>
        this.orderStore.apply(folder, sorted)
    );

    /* Rows already on screen were laid out before the patch existed. */
    if (this.sortPatch) this.sortExplorer();
  }

  private releaseSorting(): void {
    if (!this.sortPatch) return;
    this.sortPatch.unpatch();
    this.sortPatch = null;
    /* Hand the tree back in Obsidian's own order rather than leaving the last
       custom arrangement frozen on screen until something rebuilds it. */
    this.sortExplorer();
  }

  sortExplorer(): void {
    for (const view of this.explorerViews()) sortView(view);
  }

  /* Only folders take part. This plugin arranges the shape of the tree and
     leaves every file where the sort menu put it, so a file row grows no
     handle at all — which makes "files do not move here" something you can
     see rather than something you find out by trying.
   *
     The cover does not come into it: the two modes refuse to be on at the
     same time, so there are never skeleton bars to drag. */
  private canDrag(row: HTMLElement): boolean {
    const path = row.getAttribute("data-path");
    return path !== null && this.app.vault.getFolderByPath(path) !== null;
  }

  private async commitMove(
    folderPath: string,
    moving: string,
    target: string,
    position: "before" | "after"
  ): Promise<void> {
    /* Freeze what is on screen right now, before every drag rather than only
       the first. The move below is expressed as "put this name next to that
       one", so both names have to be in the record for it to mean anything —
       and a subfolder created since the last drag is not, until this runs. */
    this.orderStore.capture(folderPath, this.displayedFolderNames(folderPath));

    this.orderStore.move(folderPath, moving, target, position);
    await this.saveOrders();
    /* Slide the rows rather than swapping them out from under the pointer —
       a list that simply looks different afterwards leaves you unsure the
       drop did what you meant. */
    animateReorder(this.explorerDocuments(), () => this.sortExplorer());

  }

  /* A folder's subfolders in the order they are drawn: Obsidian's own sorting
     with this plugin's record already laid over it.
   *
     Asked of the unpatched sorter rather than read off the screen. Reading
     the DOM was the first attempt and is quietly wrong: the explorer
     virtualises its rows, so a folder long enough to scroll has most of its
     children missing from the document. The snapshot would record only the
     part that happened to be in view, and everything else would come back as
     "never seen" and sink to the bottom the moment the folder was arranged. */
  private displayedFolderNames(folderPath: string): string[] {
    const folder =
      folderPath === "/"
        ? this.app.vault.getRoot()
        : this.app.vault.getFolderByPath(folderPath);

    /* Arrange mode does not open without the patch, so this is a guard
       rather than a path anything reaches. */
    if (!folder || !this.sortPatch) return [];

    return this.orderStore
      .apply(folder, this.sortPatch.nativeItems(folder))
      .filter((item) => item.file instanceof TFolder)
      .map((item) => item.file.name);
  }

  /* Persist without redrawing. saveSettings() repaints the cover, which is
     right when a setting changed and wasteful when all that moved was a name
     inside an order. */
  async saveOrders(): Promise<void> {
    await this.saveData(this.settings);
  }

  /* No "create" handler: a folder that appears after its parent was arranged
     is simply absent from the record, and apply() already knows what to do
     with that — it goes to the bottom of the folder block until someone drags
     it. Nothing to write, so nothing to listen for.

     Both handlers below report whether they actually changed the record, and
     the save only happens when they did. A record holds folder names only,
     while most of what happens in a vault is files, so without that check
     nearly every rename in the vault would rewrite data.json for nothing. */
  private registerOrderEvents(): void {
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.orderStore.onDelete(file)) void this.saveOrders();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.orderStore.onRename(file, oldPath)) void this.saveOrders();
      })
    );
  }

  private *explorerViews(): Generator<FileExplorerView> {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const view: unknown = leaf.view;
      if (isExplorerView(view)) yield view;
    }
  }

  /* Both buttons are laid out plainly, side by side, and nothing here tries to
     make them fit the toolbar. On a narrow sidebar they wrap onto a second
     row, which is Obsidian's own `flex-wrap` doing what it was built to do —
     and any cleverness here would be undone by the next plugin the user
     installs, since the container takes buttons in load order and offers no
     way to claim a place in it. The setting below is the only lever, and it
     belongs to the user. */
  syncButtons(): void {
    const buttons = this.settings.toolbarButtons;
    const wantCover = buttons === "both" || buttons === "immersive";
    const wantSort = buttons === "both" || buttons === "sort";

    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const bar = leaf.view.containerEl.querySelector<HTMLElement>(
        ".nav-buttons-container"
      );
      if (!bar) continue;

      /* Tracks the setting, not whether the cover happens to be drawn right
         now: with no file open the cover lifts on its own, and a button that
         flipped itself back to "off" would read as having been switched off
         behind the user's back. */
      const covering = this.settings.enabled;
      const sorting = this.dragSort.isActive();
      /* The cover's second reason to be unavailable: no note open, so no
         folder to immerse in. Read from the same place the cover reads its
         focus, so "the button says you can" and "there is something to draw"
         can never disagree.

         Weighed only while the cover is off. Once it is up this button is the
         way back out, and dimming it there would strand whoever closed their
         last note with the mode still on. */
      const noFile = !covering && !this.app.workspace.getActiveFile();

      /* Each mode dims the other's button while it is on, and puts the reason
         where the tooltip was. The button stays clickable on purpose: the
         notice is the fallback for the click that happens anyway, and a
         control that dims *and* goes dead reads as broken rather than as
         waiting its turn. The no-note case above is dimmed and answered the
         same way, for the same reason — and because a tooltip alone says
         nothing at all on a touch screen, where there is no hover to have. */
      const cover = this.syncButton(
        bar,
        BUTTON_CLASS,
        ICON,
        wantCover,
        covering,
        () => void this.toggle()
      );
      cover?.toggleClass(DISABLED_CLASS, sorting || noFile);
      cover?.setAttribute(
        "aria-label",
        sorting
          ? this.t.blockedBySort
          : noFile
            ? this.t.needFile
            : covering
              ? this.t.ariaOn
              : this.t.ariaOff
      );

      /* An axis with arrows at both ends: the button is a switch, not
         something you drag, so it shows what the mode does rather than
         echoing the grips the rows will grow. */
      const sort = this.syncButton(
        bar,
        SORT_BUTTON_CLASS,
        SORT_ICON,
        wantSort,
        sorting,
        () => this.toggleSortMode()
      );
      sort?.toggleClass(DISABLED_CLASS, covering);
      sort?.setAttribute(
        "aria-label",
        covering
          ? this.t.blockedByCover
          : sorting
            ? this.t.sortModeOn
            : this.t.sortModeOff
      );
    }
  }

  private syncButton(
    bar: HTMLElement,
    cls: string,
    icon: string,
    wanted: boolean,
    active: boolean,
    onClick: () => void
  ): HTMLElement | null {
    let button = bar.querySelector<HTMLElement>(`.${cls}`);
    /* Turning a button off in settings has to take effect now rather than at
       the next restart, so an unwanted button is torn down here — skipping
       the creation branch alone would leave the existing one sitting there. */
    if (!wanted) {
      button?.remove();
      return null;
    }
    if (!button) {
      button = bar.createDiv({
        cls: `clickable-icon nav-action-button ${cls}`,
      });
      /* The glyph never changes, so it is drawn once at creation; only the
         state below is refreshed. */
      setIcon(button, icon);
      button.addEventListener("click", onClick);
    }
    button.toggleClass("is-active", active);
    return button;
  }

  /* Sort mode is deliberately not remembered across restarts: it is something
     you switch on to tidy up and switch off again, not a preference. Which is
     also why nothing here needs a matching restore — see toggle(). */
  toggleSortMode(): void {
    /* Only opening is refused. Whatever state the tree is in, switching the
       mode off has to stay available. */
    if (!this.dragSort.isActive()) {
      if (this.settings.enabled) {
        new Notice(this.t.blockedByCover);
        return;
      }
      /* Without the patch a drag would record an order nothing ever applies,
         which is worse than not offering the mode at all. */
      if (!this.sortPatch) {
        new Notice(this.t.sortUnavailable);
        return;
      }
      /* A cover still lifting off is still a cover, and the two take turns.
         Clicked through within that second, it is lifted at once rather than
         left to grow grips under its bars. */
      this.finishSweep();
    }

    this.dragSort.setActive(!this.dragSort.isActive());
    this.syncButtons();
  }

  private removeButtons(): void {
    for (const el of this.explorerQuery(
      `.${BUTTON_CLASS}, .${SORT_BUTTON_CLASS}`
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

  /* The tab describes itself rather than drawing itself, which is what puts
     its rows into Obsidian's settings search. There is no imperative
     fallback: update() below is 1.13.0 API, so the manifest asks for 1.13.0
     and every install that can run this plugin can render this. */
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
        name: t.toolbar,
        desc: t.toolbarDesc,
        control: {
          type: "dropdown",
          key: "toolbarButtons",
          options: {
            both: t.toolbarBoth,
            immersive: t.toolbarImmersive,
            sort: t.toolbarSort,
            none: t.toolbarNone,
          },
        },
      },
      {
        /* Only worth a row once something is actually hidden. `visible` is
           re-read on every render, and the setter below calls update(), so
           this row appears and leaves with the choice above it. */
        name: t.hotkeyName,
        desc: t.hotkeyDesc,
        visible: () => this.plugin.settings.toolbarButtons !== "both",
        action: () =>
          openHotkeySettings(this.app, this.plugin.manifest.name),
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
      {
        name: t.revealInside,
        desc: t.revealInsideDesc,
        control: { type: "toggle", key: "revealSubfolders" },
      },
      {
        name: t.revealAbove,
        desc: t.revealAboveDesc,
        control: { type: "toggle", key: "revealAncestors" },
      },
      { name: t.dragName, desc: t.dragIntro },
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
        plugin.registerSortCommand();
        this.update();
        return;
      case "collapseOthers":
        /* Folding and unfolding the tree is a side effect, not just a stored
           flag, so this one goes through the plugin rather than being
           written here. */
        await plugin.applyCollapseOthers(Boolean(value));
        return;
      case "keepActiveInView":

        plugin.settings.keepActiveInView = Boolean(value);
        break;
      case "revealSubfolders":
        /* Nothing to fold or scroll — which rows are spared is recomputed on
           the redraw saveSettings() already runs. */
        plugin.settings.revealSubfolders = Boolean(value);
        break;
      case "revealAncestors":
        /* Same as above: a redraw is all it takes. */
        plugin.settings.revealAncestors = Boolean(value);
        break;
      case "toolbarButtons":
        plugin.settings.toolbarButtons = value as ToolbarButtons;
        await plugin.saveSettings();
        plugin.syncButtons();
        /* The hotkey row hangs off this value, so the page has to re-read it. */
        this.update();
        return;
      default:
        return;
    }
    await plugin.saveSettings();
  }
}
