import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const extension = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

// The board runs inside a webview: a browser bundle with no imports left.
const board = {
  entryPoints: ["src/webview/board.ts"],
  outfile: "dist/board.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  for (const options of [extension, board]) await (await esbuild.context(options)).watch();
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(board)]);
}
