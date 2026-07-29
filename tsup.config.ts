import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  sourcemap: false,
  clean: true,
  dts: false,
  // Bundle-size tracking: emit the esbuild metafile (dist/metafile-esm.json)
  // for DendroBundle. Gated so ordinary builds stay byte-identical.
  metafile: Boolean(process.env.BUILD_BUNDLE_STATS),
  banner: {
    js: "#!/usr/bin/env node",
  },
});
