# Immersive Folder

English · [简体中文](README.zh-CN.md)

An Obsidian plugin. While you are working in a folder, that folder stays
readable and everything else in the file explorer drops behind skeleton bars.

![the file explorer with the Clippings folder readable and every other row reduced to skeleton bars](docs/screenshot.png)

The folder is picked automatically from the file you have open — there is
nothing to select and nothing to remember to turn off when you move on. Open a
note somewhere else and the bars follow you there.

Custom icons (from [Iconize](https://github.com/FlorianWoelki/obsidian-iconize))
become placeholder tiles rather than disappearing, so the rows keep their shape
and the covered list still reads as a list.

## Why

- **Focus.** A vault of two thousand notes stops competing for attention with
  the dozen you are actually working on.
- **Privacy over your shoulder.** Open a work folder in the office and the
  person beside you sees that folder, not the names of everything else you
  keep in the vault.
- **Screen recordings.** Show the folder the video is about and leave the rest
  of the sidebar unreadable, without rearranging your vault first.

## Using it

- **The eye button** at the top of the file explorer toggles it.
- **`Immersive Folder: Toggle immersive folder`** does the same from the
  command palette, so you can bind a hotkey — worth doing if you switch it on
  and off around recordings.

The state is remembered across restarts.

### Settings

**Show the trail back to the root** — keeps the names of the folders above the
one you are in, so you can still tell where you are in the tree. On by
default. Turn it off and the trail is skeletoned too.

**Keep the active file in view** — scrolls the explorer to each note as you
switch to it, expanding whatever it takes to show it. Without it, switching to
a note whose folder is scrolled out of view leaves you looking at a screen of
bars and nothing else. On by default.

**Collapse every other folder** — on each switch, folds away every folder
except the one you are in. Less to scroll past, and it stops the bars from
giving away how many files the other folders hold. Whatever was open is put
back when you leave immersive mode. On by default.

### Changing how the bars look

The bars take their colour from two CSS variables, so a snippet is enough to
pitch them to your theme:

```css
body {
  --immersive-folder-bar: var(--text-faint);
  --immersive-folder-bar-opacity: 0.5;
}
```

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

The rules are generated from the active file's parent path and injected as a
stylesheet, matching rows on their `data-path` attribute. That matters for two
reasons: the explorer virtualises its rows, so a row can be created at any
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

## Installing

Not in the community plugin list yet. To install by hand, copy `main.js`,
`manifest.json` and `styles.css` into
`YourVault/.obsidian/plugins/immersive-folder/` and enable it under
Settings → Community plugins.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check and build main.js
npm run sync    # build, then copy into the vaults listed in sync.mjs
```

## License

MIT
