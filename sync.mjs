#!/usr/bin/env node
/**
 * Copies the built plugin into the vaults listed below, so a build is one
 * `obsidian plugin:reload` away from running.
 *
 * Override the targets with OBSIDIAN_PLUGIN_DIR (colon-separated for more
 * than one).
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const { id } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const iCloud = join(process.env.HOME, "Library/Mobile Documents");
const TARGETS = process.env.OBSIDIAN_PLUGIN_DIR
  ? process.env.OBSIDIAN_PLUGIN_DIR.split(":")
  : [
      join(
        iCloud,
        "iCloud~md~obsidian/Documents/BlinkObsidianVault/.obsidian/plugins",
        id
      ),
      join(iCloud, "com~apple~CloudDocs/TestVault/.obsidian/plugins", id),
    ];

const done = [];
for (const dir of TARGETS) {
  /* Only sync into vaults that already exist — never conjure a stray one. */
  if (!existsSync(join(dir, "../.."))) continue;
  mkdirSync(dir, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) {
    copyFileSync(join(root, f), join(dir, f));
  }
  done.push(dir.replace(process.env.HOME, "~"));
}

console.log(
  done.length
    ? "synced →\n  " + done.join("\n  ")
    : "no vault found to sync into"
);
