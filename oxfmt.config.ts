import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".agents/skills/**",
    ".gaia/**",
  ],
  sortTailwindcss: {
    stylesheet: "./apps/dashboard/src/styles.css",
    functions: ["cn", "clsx", "cva"],
  },
});
