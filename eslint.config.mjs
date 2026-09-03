/* The rules the Obsidian community-plugin review runs. Kept here so the
   findings arrive from `npm run lint` rather than from a reviewer.
 *
   Type-aware on purpose: several of the rules that matter here — unbound
   methods among them — read types rather than syntax, and without
   projectService they simply never fire. `npm run lint` must be run from the
   repository root: eslint-plugin-obsidianmd reads manifest.json from the
   working directory. */
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  }
);
