import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    alwaysBundle: [
      /^@gaia\/core$/,
      /^@gaia\/runtime\/paths$/,
      /^@gaia\/runtime\/run-read-api$/,
    ],
    onlyBundle: false,
  },
  dts: false,
  entry: ["src/main.ts"],
  format: ["esm"],
  sourcemap: true,
});
