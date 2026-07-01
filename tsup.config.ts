import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts", "src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  dts: false,
  // Inject the shebang into the built CLI bin so `pr-war-room` is executable.
  banner: { js: "#!/usr/bin/env node" },
});
