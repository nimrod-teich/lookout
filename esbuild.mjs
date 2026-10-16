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

// The findings tab is a second webview, bundled the same way.
const findings = { ...board, entryPoints: ["src/webview/findings.ts"], outfile: "dist/findings.js" };

if (watch) {
  for (const options of [extension, board, findings]) await (await esbuild.context(options)).watch();
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(board), esbuild.build(findings)]);
}
