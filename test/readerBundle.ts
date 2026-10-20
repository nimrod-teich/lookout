import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";

/**
 * The reading thread's bundle, built from source the way `npm run build`
 * builds `dist/reader.js`, into `dir/dist/reader.js`: the tests run the real
 * thread, not a stand-in, and need no build before them.
 */
export function buildReader(dir: string = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-reader-"))): string {
  const outfile = path.join(dir, "dist", "reader.js");
  esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "src", "reader.ts")], outfile, bundle: true, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
  return outfile;
}
