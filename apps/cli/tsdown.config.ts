import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { main: "src/bootstrap.ts" },
  format: ["esm"],
  sourcemap: true,
  dts: true,
});
