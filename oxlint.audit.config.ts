import { defineConfig, type OxlintConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";

const auditConfig = {
  extends: [core, react, tanstack, vitest],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ".agents/skills/**",
    ".gaia/**",
  ],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
} satisfies OxlintConfig;

export default defineConfig(auditConfig);
