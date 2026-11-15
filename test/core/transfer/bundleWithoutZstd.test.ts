import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundle, openBundle, readBundleHeader, zstdAvailable } from "../../../src/core/transfer/bundle";
import type { ManifestBody } from "../../../src/core/transfer/types";
import { rewriteHeader } from "./fixtures";

// A Node.js older than 22.15, as in an older VS Code: zlib without zstd.
vi.mock("node:zlib", async (importOriginal) => {
  const zlib = await importOriginal<typeof import("node:zlib")>();
  return { ...zlib, createZstdCompress: undefined, createZstdDecompress: undefined, zstdCompress: undefined, zstdDecompress: undefined };
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-bundle-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const MANIFEST: ManifestBody = {
  format: 1,
  createdAt: 1,
  lookoutVersion: "0.1.5",
  source: { host: "old-host", platform: "linux", home: "/home/someone", wsl: false },
  sections: ["transcripts"],
  state: {},
  notes: [],
  tabs: [],
  claudeDirs: [],
};

async function writeOne(file: string, data: Buffer, passphrase?: string): Promise<void> {
  const sink = await createBundle(file, { codec: "zstd", level: 3, host: "old-host", createdAt: 1, passphrase }, { segmentBytes: 1024, scryptN: 2 ** 10 });
  await sink.addFile({ kind: "transcript", rel: "-a/s.jsonl", mtime: 1 }, Readable.from([data]));
  await sink.finish(MANIFEST);
}

describe("backup file without zstd", () => {
  it("writes gzip when asked for zstd, says so in the header, and reads it back", async () => {
    expect(zstdAvailable()).toBe(false);
    const data = Buffer.from("line of a transcript\n".repeat(500));
    for (const passphrase of [undefined, "a passphrase"]) {
      const file = path.join(dir, `${passphrase ? "sealed" : "open"}.lookout`);
      await writeOne(file, data, passphrase);
      expect((await readBundleHeader(file)).codec).toBe("gzip");
      const source = await openBundle(file, passphrase);
      const parts: Buffer[] = [];
      await source.forEachFile(async (_entry, stream) => {
        for await (const chunk of stream) parts.push(chunk as Buffer);
      });
      await source.close();
      expect(Buffer.concat(parts).equals(data)).toBe(true);
    }
  });

  it("refuses a zstd backup as unsupported, saying why, before asking for its passphrase", async () => {
    const file = path.join(dir, "zstd.lookout");
    await writeOne(file, Buffer.from("x"), "a passphrase");
    rewriteHeader(file, (fields) => (fields.codec = "zstd"));
    await expect(readBundleHeader(file)).rejects.toMatchObject({ code: "unsupported", message: expect.stringMatching(/zstd.*Node\.js 22\.15/) });
    await expect(openBundle(file)).rejects.toMatchObject({ code: "unsupported" });
  });
});
