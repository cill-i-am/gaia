import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts", "src/server.ts"],
  format: ["esm"],
  sourcemap: true,
  dts: true,
});
