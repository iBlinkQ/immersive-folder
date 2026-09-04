# Immersive Folder

English · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

An Obsidian plugin. While you are working in a folder, one click narrows the
file explorer to that folder's notes and covers everything else up until you
switch it back.

It also lets you drag folders into the order you want, so you no longer have to
name them `01_Inbox`, `02_Projects` just to make them line up.

![the file explorer with the Clippings folder readable and every other row reduced to skeleton bars](docs/screenshot.png)

The folder is picked automatically from the file you have open — there is
nothing to select and nothing to remember to turn off when you move on. Open a
note somewhere else and the skeleton bars follow you there. With nothing open
at all there is no folder to immerse in, so the button dims and asks you to
open a note first, rather than storing a mode it has nothing to draw.

Only that folder and what it holds stay readable. The folders *above* it go
under bars as well: a top-level name is usually the most telling thing on the
screen, and leaving the trail readable would hand away the very names the
cover is up to hide. The indentation is untouched, so you can still see which
level you are on.

Custom icons (from [Iconize](https://github.com/FlorianWoelki/obsidian-iconize))
become placeholder tiles rather than disappearing, so the rows keep their shape
and the covered list still reads as a list.

You can also **arrange the folders by hand**: switch on arrange mode and drag
folders to set their order. Files are left alone — they stay wherever the sort
menu put them. Nothing is written to disk beyond the order itself, no file is
ever moved, and ordinary dragging is left exactly as it was.

## Why

- **Focus.** A vault of two thousand notes stops competing for attention with
  the dozen you are actually working on.
- **Presenting in a meeting.** Put one project on the projector to walk a room
  through it, and the room reads that project — not the name of the one beside
  it, or of another client, or of whatever you keep for yourself. A live screen
  has no second take.
- **Screen recordings.** Show the folder the video is about and leave the rest
  of the sidebar unreadable, without rearranging your vault first.

## Using it

- **The button** at the top of the file explorer toggles it. It takes on your
  accent colour while the cover is up, so the state is readable at a glance.
- **`Immersive Folder: Toggle immersive folder`** does the same from the
  command palette, so you can bind a hotkey — worth doing if you switch it on
  and off around recordings.

The state is remembered across restarts.

### Arranging the folders by hand

The **up-and-down arrow button** at the top of the file explorer switches on
folder arrange mode. Every folder grows a handle and starts to drift, which is
the list saying it can be rearranged. Drag a folder up or down to set where it
sits among its sibling folders, then press the button again to leave.

![folder arrange mode switched on: the collapse arrows become handles, the files below stay dim and handleless throughout, and each folder dragged shows a line where it will land](docs/arrange.gif)

**Only folders take part.** Files grow no handle, do not drift, and dim while
the mode is on — they stay exactly where Obsidian's sort menu put them, which
is also why switching between name and date still does what it always did. So
the plugin sets the shape of the tree, and the sort menu keeps every row
inside it.

**Hold a folder and only the folders that can take it keep moving** —
everything at another level dims and goes still. Reordering is always among
siblings, and this way you can see that rather than having to remember it. A
line shows where the folder will land.

Changes are saved as you make them; the button is only a way in and out.

The first drag in a folder fixes the order of that folder's subfolders. Every
other folder goes on sorting the way you told Obsidian to, and a vault where
you never arrange anything stores nothing at all. A folder made later starts
at the bottom, until you drag it somewhere.

While the mode is on the tree holds still: rows do not open, folders do not
fold, and the handle sits where the collapse arrow was. Expand whatever you
need to see before switching it on.

**Ordinary dragging is untouched.** With the mode off, dragging a note into
another folder behaves exactly as it always did — that is Obsidian's own
feature, and this plugin does not listen to it. Keeping the two apart in time
is what lets each one be unambiguous: on screen, "below that folder" and "into
that folder" are the same pixel.

**Immersive mode and arrange mode take turns.** The cover replaces the very
names you would be arranging by, so switching one on while the other is up
says which one is in the way rather than quietly turning it off. The button
that is waiting dims, and its tooltip says what to leave first.

### Settings

**Language** — the interface follows whatever language Obsidian itself is set
to. English and 简体中文 ship with the plugin; pick one here to override the
match. Everything switches over on the spot, the command name included.

**Toolbar buttons** — which of the plugin's two buttons sit at the top of the
file explorer. Both are switches that show whether their mode is on, so both
stay in plain sight by default; hide one if you only ever use the other
feature. Whatever you hide is still on the command palette, and the settings
page will offer to take you straight to the hotkeys page once something is
hidden.

**Keep the active file in view** — scrolls the explorer to each note as you
switch to it, expanding whatever it takes to show it. Without it, switching to
a note whose folder is scrolled out of view leaves you looking at a screen of
bars and nothing else. On by default.

**Collapse every other folder** — on each switch, folds away every folder
except the one you are in. Less to scroll past, and it stops the bars from
giving away how many files the other folders hold. Whatever was open is put
back when you leave immersive mode. On by default.

### Changing how it looks

Everything the plugin paints takes its colour from CSS variables, so a snippet
is enough to pitch it to your theme:

```css
body {
  /* The skeleton bars */
  --immersive-folder-bar: var(--text-faint);
  --immersive-folder-bar-opacity: 0.5;

  /* Arrange mode: the drop line, the row you hold, the handles, and how far
     rows at other levels dim while you hold one */
  --immersive-folder-drop-line: var(--color-accent);
  --immersive-folder-drag-bg: var(--background-modifier-active-hover);
  --immersive-folder-handle: var(--text-muted);
  --immersive-folder-dim: 0.32;
}
```

The drop line follows the accent colour you picked in Appearance, so it matches
whatever theme you are on without being told.

## What it does not do

**This is a visual cover, not encryption.** The names are still in the page —
anyone with developer tools can read them. It is built for cameras, projectors
and the desk next to you, not for an adversary with access to your machine.

With **Collapse every other folder** turned off, the bars still give away
**how many** files each folder holds and **how deep** the tree goes, since
every row stays where it was. Leaving that setting on folds all of it away —
what remains is one bar per folder you are not in. If you would rather the
rows disappear altogether, a hiding plugin such as [Explorer
Focus](https://github.com/davidvkimball/obsidian-explorer-focus) removes them
outright instead.

The cover applies to the file explorer only. Tab titles, the note's own
breadcrumb, search results and the quick switcher are untouched — including
while the explorer's search filter is open, where the results are skeletoned
like everything else. Switch the cover off to search by name.

## How it works

Rows are matched on their `data-path` attribute and marked with a class, which
a static stylesheet then acts on. That matters for two reasons: the explorer virtualises its rows, so a row can be created at any
moment and has to arrive already styled; and the folder you are in stays
readable even when it is collapsed and the active row is not in the document
at all.

If no file is open the stylesheet is emptied rather than left covering
everything, so you can never be stranded in a column of anonymous bars.

Collapsing and scrolling go through the explorer's own row map, which is
internal API — every use of it is guarded, so if a future Obsidian renames it
those two settings stop working and the cover itself carries on. The folding
runs only when the active file actually changes, not on every redraw, or it
would fight you each time you moved a pane.

The custom order is a shuffle laid over Obsidian's own sorting rather than a
replacement for it. `getSortedFolderItems` is patched on the explorer's
prototype, and a folder with no recorded order is handed straight back
untouched — so the sort menu still decides everything except the subfolders
you arranged by hand. Only subfolder rows are moved, and they are moved
between the indexes they already occupy, so every file comes back exactly
where Obsidian put it. Orders are stored per folder as a list of subfolder
names, and only folders you actually dragged in are stored at all.

Arrange mode is what keeps reordering and moving apart. With it off, nothing
here listens to a drag at all. With it on, every drag event over the explorer
is taken in the capture phase before Obsidian's own handlers run — which is
not tidiness but the whole safety story: left to itself Obsidian expands
folders the pointer rests on and moves the file into whichever folder it last
saw, including positions no line was drawn for, so the move would arrive with
nothing on screen having predicted it. Rows already carry `draggable` from
Obsidian, so there is no drag to start.

The patch and the redraw that follows it are internal API, checked before use
and removed on unload; if a future Obsidian moves them, ordering switches
itself off and the rest carries on.

## Installing

Not in the community plugin list yet. Download `main.js`, `manifest.json`
and `styles.css` from the [latest
release](https://github.com/iBlinkQ/immersive-folder/releases/latest), put them
in `YourVault/.obsidian/plugins/immersive-folder/`, and enable the plugin
under Settings → Community plugins.

(`main.js` is a build artefact and is not kept in the repository — it exists
only in the releases, or after you run `npm run build` yourself.)

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check and build main.js
npm run lint    # the rules the community-plugin review runs
npm run sync    # build, then copy into the vaults listed in sync.mjs
```

`npm run lint` has to be run from the repository root: the rules read
`manifest.json` from the working directory.

## License

MIT
