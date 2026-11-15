import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundle, openBundle, readBundleHeader, SEGMENT_BYTES, zstdAvailable, type BundleTuning } from "../../../src/core/transfer/bundle";
import { BundleError, type BundleFile, type BundleManifest, type ManifestBody, type NewFile, type WriteOptions } from "../../../src/core/transfer/types";
import { sessionId } from "../helpers";
import { rewriteHeader } from "./fixtures";

// Key derivation, compression and SQLite at real sizes: slower runners need more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-bundle-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const PASS = "correct horse battery staple";
const OPTIONS: WriteOptions = { codec: "zstd", level: 3, host: "test-host", createdAt: 1_760_000_000_000 };
/** Small segments and a cheap passphrase: boundaries every 4 KiB, keys in milliseconds. */
const SMALL: BundleTuning = { segmentBytes: 4096, scryptN: 2 ** 10 };
const CODEC = zstdAvailable() ? "zstd" : "gzip";
const NEEDLE = "needle-7f3a9c";
const EMPTY_DATA = Buffer.alloc(0);

const MANIFEST: ManifestBody = {
  format: 1,
  createdAt: OPTIONS.createdAt,
  lookoutVersion: "0.1.5",
  source: { host: "test-host", platform: "linux", home: "/home/someone", wsl: false },
  sections: ["state", "notes", "tabs", "transcripts", "subagents"],
  state: { "lookout.favourites": [sessionId(1)], "lookout.sort": "recent" },
  notes: [{ v: 1, id: sessionId(1), agent: "claude-code", title: "Billing", notes: [{ id: "n1", text: `a note ${NEEDLE}`, at: 1 }] }],
  tabs: [{ label: "app", folders: ["/home/someone/app"], tabs: [{ sessionId: sessionId(1), title: "Billing" }] }],
  claudeDirs: [{ label: "default", resolved: "/home/someone/.claude", isDefault: true }],
};

interface Item {
  entry: NewFile;
  data: Buffer;
}

function transcript(n: number, data: Buffer): Item {
  return { entry: { kind: "transcript", dir: "default", rel: `-home-someone-app/${sessionId(n)}.jsonl`, sessionId: sessionId(n), cwd: "/home/someone/app", mtime: 1_700_000_000_000 + n }, data };
}

function subagent(n: number, data: Buffer): Item {
  return { entry: { kind: "subagent", dir: "default", rel: `-home-someone-app/${sessionId(n)}/subagents/agent-${n}.jsonl`, sessionId: sessionId(n), mtime: 1_700_000_000_000 }, data };
}

/** Lines of JSON that compress the way transcripts do. */
function lines(bytes: number, seed = 0): Buffer {
  let out = "";
  for (let i = 0; out.length < bytes; i++) out += JSON.stringify({ type: "assistant", n: seed * 100_000 + i, text: `step ${i} of ${NEEDLE} work on the billing webhook` }) + "\n";
  return Buffer.from(out.slice(0, bytes));
}

/** Bytes that do not compress: the compressed payload is as long as they are. */
function noise(bytes: number): Buffer {
  return crypto.randomBytes(bytes);
}

/** A payload over several 4 KiB segments: noise first, so a byte flipped early lands in a file. */
function fixture(): Item[] {
  return [
    transcript(1, noise(20_000)),
    subagent(1, lines(30_000, 1)),
    transcript(2, Buffer.alloc(0)),
    { entry: { kind: "history", rel: "history.sqlite", mtime: 5 }, data: noise(3000) },
  ];
}

async function write(file: string, items: Item[], options: Partial<WriteOptions> = {}, tuning: BundleTuning = SMALL): Promise<BundleFile[]> {
  const sink = await createBundle(file, { ...OPTIONS, ...options }, tuning);
  const added: BundleFile[] = [];
  for (const item of items) added.push(await sink.addFile(item.entry, Readable.from([item.data])));
  await sink.finish(MANIFEST);
  return added;
}

/** Everything a backup holds, read back: its header, manifest, and each file's bytes by path. */
async function readAll(file: string, passphrase?: string, want?: (entry: BundleFile) => boolean): Promise<{ manifest: BundleManifest; contents: Map<string, Buffer> }> {
  const source = await openBundle(file, passphrase);
  const contents = new Map<string, Buffer>();
  try {
    await source.forEachFile(async (entry, data) => {
      const parts: Buffer[] = [];
      for await (const chunk of data) parts.push(chunk as Buffer);
      contents.set(entry.rel, Buffer.concat(parts));
    }, want);
  } finally {
    await source.close();
  }
  return { manifest: source.manifest, contents };
}

/** How opening and reading the whole backup ends: "ok", or the error's code. */
async function outcome(file: string, passphrase?: string): Promise<string> {
  return (await answer(file, passphrase)).split(": ")[0]!;
}

/** How opening and reading the whole backup ends: "ok", or the error's code and message. */
async function answer(file: string, passphrase?: string): Promise<string> {
  try {
    await readAll(file, passphrase);
    return "ok";
  } catch (err) {
    return err instanceof BundleError ? `${err.code}: ${err.message}` : `not a BundleError: ${String(err)}`;
  }
}

/** What a sealed file whose last segment does not open reads as, cut short or changed. */
const DAMAGED_OR_CUT = "truncated: The backup file is damaged or incomplete.";
/** A value that a notification would turn into a link that runs a command. */
const LINK = "[Open](command:workbench.action.terminal.new)";

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Where the body starts: after the magic, the header's length and the header. */
function leadOf(bytes: Buffer): number {
  return 12 + bytes.readUInt32BE(8);
}

/** Where the stream's byte `at` sits in the file, and how long the stream is. */
function geometry(bytes: Buffer, segment: number, sealed: boolean): { at: (logical: number) => number; length: number } {
  const lead = leadOf(bytes);
  const tag = sealed ? 16 : 0;
  const stride = segment + tag;
  const body = bytes.length - lead;
  const count = Math.ceil(body / stride);
  return { at: (logical) => lead + Math.floor(logical / segment) * stride + (logical % segment), length: (count - 1) * segment + body - (count - 1) * stride - tag };
}

function variant(bytes: Buffer, name: string, change: (copy: Buffer) => Buffer | void): string {
  const copy = Buffer.from(bytes);
  const file = path.join(dir, `${name}.lookout`);
  fs.writeFileSync(file, change(copy) ?? copy);
  return file;
}

describe("backup file", () => {
  it.each([
    ["without a passphrase", undefined],
    ["with a passphrase", PASS],
  ])("writes files and a manifest and reads them back, %s", async (_, passphrase) => {
    const file = path.join(dir, "b.lookout");
    const items = fixture();
    // One file from a path rather than a stream.
    const onDisk = path.join(dir, "vault-copy.jsonl");
    fs.writeFileSync(onDisk, lines(5000, 9));
    const sink = await createBundle(file, { ...OPTIONS, passphrase }, SMALL);
    const added: BundleFile[] = [];
    for (const item of items) added.push(await sink.addFile(item.entry, Readable.from([item.data])));
    added.push(await sink.addFile({ kind: "vault", rel: "abc.jsonl", mtime: 7 }, onDisk));
    expect(fs.existsSync(file)).toBe(false);
    const { bytes } = await sink.finish(MANIFEST);
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
    expect(fs.statSync(file).size).toBe(bytes);

    let offset = 0;
    for (const [i, item] of [...items, { entry: { kind: "vault", rel: "abc.jsonl", mtime: 7 } as NewFile, data: fs.readFileSync(onDisk) }].entries()) {
      expect(added[i]).toEqual({ ...item.entry, size: item.data.length, sha256: sha256(item.data), offset });
      offset += item.data.length;
    }

    const header = await readBundleHeader(file);
    if (passphrase) {
      expect(header).toEqual({ format: 1, cipher: "aes-256-gcm-stream", kdf: { name: "scrypt", N: 2 ** 10, r: 8, p: 1, salt: expect.stringMatching(/^[0-9a-f]{32}$/) }, codec: CODEC, createdAt: OPTIONS.createdAt, host: "test-host" });
    } else {
      expect(header).toEqual({ format: 1, cipher: "none", codec: CODEC, createdAt: OPTIONS.createdAt, host: "test-host" });
    }

    const { manifest, contents } = await readAll(file, passphrase);
    expect(manifest).toEqual({ ...MANIFEST, files: added });
    expect([...contents.keys()]).toEqual(added.map((entry) => entry.rel));
    for (const item of items) expect(contents.get(item.entry.rel)!.equals(item.data), item.entry.rel).toBe(true);
    expect(contents.get("abc.jsonl")!.equals(fs.readFileSync(onDisk))).toBe(true);
    expect(contents.get(items[2]!.entry.rel)!.length).toBe(0);
  });

  it.each([
    ["zstd at 3", "zstd", 3],
    ["zstd at 9", "zstd", 9],
    ["gzip at 6", "gzip", 6],
  ] as const)("reads back what it writes with %s, with and without a passphrase", async (_, codec, level) => {
    for (const passphrase of [undefined, PASS]) {
      const file = path.join(dir, `${codec}-${level}-${passphrase ? "sealed" : "open"}.lookout`);
      const items = [transcript(1, lines(50_000)), subagent(1, lines(20_000, 2))];
      await write(file, items, { codec, level, passphrase });
      expect((await readBundleHeader(file)).codec).toBe(codec === "zstd" ? CODEC : "gzip");
      const { contents } = await readAll(file, passphrase);
      for (const item of items) expect(contents.get(item.entry.rel)!.equals(item.data)).toBe(true);
    }
  });

  it("reads back across every segment size, the footer and manifest falling across boundaries", async () => {
    for (const segmentBytes of [16, 33, 64, 4096]) {
      for (const passphrase of [undefined, PASS]) {
        const file = path.join(dir, `seg-${segmentBytes}-${passphrase ? "sealed" : "open"}.lookout`);
        const items = [transcript(1, lines(3000)), transcript(2, noise(1500)), transcript(3, Buffer.alloc(0))];
        await write(file, items, { passphrase }, { segmentBytes, scryptN: 2 ** 10 });
        const { contents } = await readAll(file, passphrase);
        for (const item of items) expect(contents.get(item.entry.rel)!.equals(item.data), `segments of ${segmentBytes}`).toBe(true);
      }
    }
  });

  it("uses 1 MiB segments and the full scrypt cost by default, and streams a file of several MiB across them", async () => {
    const file = path.join(dir, "real.lookout");
    const big = noise(3 * SEGMENT_BYTES + 12_345);
    const items = [transcript(1, big), subagent(1, lines(200_000))];
    await write(file, items, { passphrase: PASS }, {});
    expect((await readBundleHeader(file)).kdf).toMatchObject({ name: "scrypt", N: 2 ** 17, r: 8, p: 1 });
    const bytes = fs.readFileSync(file);
    // Three full segments of noise and a fourth with the rest, each with its tag.
    expect(Math.ceil((bytes.length - leadOf(bytes)) / (SEGMENT_BYTES + 16))).toBe(4);
    expect(bytes.includes(big.subarray(1000, 1064))).toBe(false);

    const source = await openBundle(file, PASS);
    const chunks: number[] = [];
    const read = new Map<string, Buffer>();
    await source.forEachFile(async (entry, data) => {
      const parts: Buffer[] = [];
      // A slow reader. Each read takes everything waiting, so a chunk's size is how far the feeding got ahead of it.
      for await (const chunk of data) {
        parts.push(chunk as Buffer);
        chunks.push((chunk as Buffer).length);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      read.set(entry.rel, Buffer.concat(parts));
    });
    await source.close();
    expect(read.get(items[0]!.entry.rel)!.equals(big)).toBe(true);
    expect(read.get(items[1]!.entry.rel)!.equals(items[1]!.data)).toBe(true);
    expect(chunks.length).toBeGreaterThan(10);
    expect(Math.max(...chunks)).toBeLessThan(SEGMENT_BYTES / 2);
  }, 60_000);

  it("finds a flipped byte and a cut at the real segment size", async () => {
    const file = path.join(dir, "real.lookout");
    await write(file, [transcript(1, noise(3 * SEGMENT_BYTES))], { passphrase: PASS }, { scryptN: 2 ** 10 });
    const bytes = fs.readFileSync(file);
    const lead = leadOf(bytes);
    const stride = SEGMENT_BYTES + 16;
    expect(await outcome(file, PASS)).toBe("ok");
    expect(await outcome(variant(bytes, "flip", (copy) => void (copy[lead + stride + 5]! ^= 1)), PASS)).toBe("corrupt");
    expect(await outcome(variant(bytes, "cut-boundary", (copy) => copy.subarray(0, lead + 2 * stride)), PASS)).toBe("truncated");
    expect(await outcome(variant(bytes, "cut-inside", (copy) => copy.subarray(0, lead + 2 * stride + 100)), PASS)).toBe("truncated");
  });

  it("lays the file out as its format says, for a reader written from the format alone", async () => {
    const file = path.join(dir, "b.lookout");
    const items = fixture();
    await write(file, items, { passphrase: PASS });
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 8).toString()).toBe("LOOKOUTB");
    const lead = leadOf(bytes);
    const header = JSON.parse(bytes.subarray(12, lead).toString()) as { segment: number; noncePrefix: string; kdf: { N: number; r: number; p: number; salt: string } };
    const { N, r, p, salt } = header.kdf;
    const key = crypto.scryptSync(PASS.normalize("NFC"), Buffer.from(salt, "hex"), 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
    const stride = header.segment + 16;
    const count = Math.ceil((bytes.length - lead) / stride);
    const open = (i: number, last: boolean) => {
      const sealed = bytes.subarray(lead + i * stride, Math.min(lead + (i + 1) * stride, bytes.length));
      const nonce = Buffer.alloc(12);
      Buffer.from(header.noncePrefix, "hex").copy(nonce, 0);
      nonce.writeUInt32BE(i, 7);
      nonce[11] = last ? 1 : 0;
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      decipher.setAAD(bytes.subarray(0, lead));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    };
    // Each segment opens only as what it is: in its place, and marked last or not.
    expect(() => open(count - 1, false)).toThrow();
    expect(() => open(0, true)).toThrow();
    const stream = Buffer.concat(Array.from({ length: count }, (_, i) => open(i, i === count - 1)));
    expect(stream.subarray(-8).toString()).toBe("LOOKOUTE");
    const footer = stream.subarray(-32);
    const payloadLength = Number(footer.readBigUInt64BE(0));
    const manifestOffset = Number(footer.readBigUInt64BE(8));
    const manifestLength = Number(footer.readBigUInt64BE(16));
    expect(manifestOffset + manifestLength + 32).toBe(stream.length);
    const inflate = (data: Buffer) => (CODEC === "zstd" ? zlib.zstdDecompressSync(data) : zlib.gunzipSync(data));
    const manifest = JSON.parse(inflate(stream.subarray(manifestOffset, manifestOffset + manifestLength)).toString()) as BundleManifest;
    const payload = inflate(stream.subarray(0, manifestOffset));
    expect(payload.length).toBe(payloadLength);
    expect(manifest.files.map((entry) => payload.subarray(entry.offset, entry.offset + entry.size).equals(items.find((item) => item.entry.rel === entry.rel)!.data))).toEqual(items.map(() => true));
  });

  it("writes the manifest and the files' bytes only sealed when there is a passphrase", async () => {
    const sealed = path.join(dir, "sealed.lookout");
    await write(sealed, [transcript(1, Buffer.from(`${NEEDLE}\n`.repeat(3)))], { passphrase: PASS });
    const bytes = fs.readFileSync(sealed);
    expect(bytes.includes(NEEDLE)).toBe(false);
    expect(bytes.includes(sessionId(1))).toBe(false);
    expect(bytes.includes("/home/someone")).toBe(false);
  });

  it("gives every file a fresh salt and nonce prefix, even for the same passphrase and data", async () => {
    const one = path.join(dir, "one.lookout");
    const two = path.join(dir, "two.lookout");
    const items = [transcript(1, lines(10_000))];
    await write(one, items, { passphrase: PASS });
    await write(two, items, { passphrase: PASS });
    const headerOf = (file: string) => {
      const bytes = fs.readFileSync(file);
      return JSON.parse(bytes.subarray(12, leadOf(bytes)).toString()) as { kdf: { salt: string }; noncePrefix: string };
    };
    expect(headerOf(one).kdf.salt).not.toBe(headerOf(two).kdf.salt);
    expect(headerOf(one).noncePrefix).toMatch(/^[0-9a-f]{14}$/);
    expect(headerOf(one).noncePrefix).not.toBe(headerOf(two).noncePrefix);
    const a = fs.readFileSync(one);
    const b = fs.readFileSync(two);
    expect(a.subarray(leadOf(a), leadOf(a) + 64).equals(b.subarray(leadOf(b), leadOf(b) + 64))).toBe(false);
  });
});

describe("reading a backup that is not right", () => {
  it("tells a wrong or missing passphrase from damage, and takes the passphrase in either Unicode form", async () => {
    const file = path.join(dir, "b.lookout");
    await write(file, fixture(), { passphrase: PASS });
    expect(await outcome(file, "wrong")).toBe("wrong-passphrase");
    expect(await outcome(file)).toBe("wrong-passphrase");
    expect(await outcome(file, PASS)).toBe("ok");

    const accented = path.join(dir, "accented.lookout");
    await write(accented, [transcript(1, lines(100))], { passphrase: "caf\u00e9" });
    expect(await outcome(accented, "cafe\u0301")).toBe("ok");
  });

  it.each([
    ["without a passphrase", false],
    ["with a passphrase", true],
  ])("reports a file cut short as truncated, wherever it is cut, %s", async (_, sealed) => {
    const file = path.join(dir, "b.lookout");
    await write(file, fixture(), sealed ? { passphrase: PASS } : {});
    const bytes = fs.readFileSync(file);
    const lead = leadOf(bytes);
    const stride = 4096 + (sealed ? 16 : 0);
    const cuts = [3, 8, 11, 20, lead - 1, lead, lead + 1, lead + 17, lead + stride, lead + 2 * stride, lead + 2 * stride + 100, bytes.length - 40, bytes.length - 32, bytes.length - 17, bytes.length - 16, bytes.length - 1];
    expect(bytes.length - 40).toBeGreaterThan(lead + 2 * stride + 100);
    for (const at of cuts) expect(await outcome(variant(bytes, `cut-${at}`, (copy) => copy.subarray(0, at)), PASS), `cut at ${at}`).toBe("truncated");
    // The header of a file cut in its body still reads.
    expect((await readBundleHeader(variant(bytes, "cut-body", (copy) => copy.subarray(0, lead + 100)))).host).toBe("test-host");
  });

  it.each([
    ["without a passphrase", false],
    ["with a passphrase", true],
  ])("reports a flipped byte as damage, never as a wrong passphrase, and as damaged or cut in a sealed file's last segment, %s", async (_, sealed) => {
    const file = path.join(dir, "b.lookout");
    await write(file, fixture(), sealed ? { passphrase: PASS } : {});
    const bytes = fs.readFileSync(file);
    const lead = leadOf(bytes);
    const { at, length } = geometry(bytes, 4096, sealed);
    const flip = (name: string, position: number) => variant(bytes, name, (copy) => void (copy[position]! ^= 0x01));
    // A sealed file's last segment either opens or does not; how it fails says nothing more.
    const lastSegment = Math.floor((length - 1) / 4096);
    const flipped = (logical: number) => (sealed && Math.floor(logical / 4096) === lastSegment ? "truncated" : "corrupt");
    expect(Math.floor((2 * 4096 + 100) / 4096)).toBeLessThan(lastSegment);

    // The header: a value that still parses, and the JSON's own punctuation.
    const host = flip("header-host", bytes.indexOf("test-host"));
    await expect(readBundleHeader(host)).rejects.toMatchObject({ code: "corrupt" });
    expect(await outcome(host, PASS)).toBe("corrupt");
    expect(await outcome(host, "wrong")).toBe("corrupt");
    expect(await outcome(flip("header-brace", 12), PASS)).toBe("corrupt");
    expect(await outcome(flip("header-sum", lead - 10), PASS)).toBe("corrupt");
    if (sealed) {
      // The salt makes the key: changed, it would read as a wrong passphrase but for the header's checksum.
      const salt = (JSON.parse(bytes.subarray(12, lead).toString()) as { kdf: { salt: string } }).kdf.salt;
      expect(await outcome(flip("header-salt", bytes.indexOf(salt) + 3), PASS)).toBe("corrupt");
    }

    // The payload: the header and manifest read; the file does not.
    const payload = flip("payload", at(2 * 4096 + 100));
    const source = await openBundle(payload, PASS);
    let ended = false;
    let streamError: unknown;
    const reading = source.forEachFile(async (_entry, data) => {
      data.on("end", () => (ended = true));
      try {
        for await (const chunk of data) void chunk;
      } catch (err) {
        streamError = err;
        throw err;
      }
    });
    await expect(reading).rejects.toMatchObject({ code: "corrupt" });
    await source.close();
    // The reader of the damaged file saw the error, never an end.
    expect(ended).toBe(false);
    expect(streamError).toBeInstanceOf(BundleError);

    // The payload's first bytes: the compressed stream's own header.
    expect(await outcome(flip("payload-start", at(1)), PASS)).toBe("corrupt");

    // The manifest's last bytes, the footer's every byte, and the last segment's tag.
    expect(await outcome(flip("manifest", at(length - 35)), PASS)).toBe(flipped(length - 35));
    for (let i = length - 32; i < length; i++) expect(await outcome(flip(`footer-${i}`, at(i)), PASS), `footer byte ${i - length + 32}`).toBe(flipped(i));
    if (sealed) for (let i = bytes.length - 16; i < bytes.length; i++) expect(await answer(flip(`tag-${i}`, i), PASS)).toBe(DAMAGED_OR_CUT);
  });

  it("checks the last segment even when it holds nothing but footer", async () => {
    const file = path.join(dir, "b.lookout");
    await write(file, fixture(), { passphrase: PASS }, { segmentBytes: 16, scryptN: 2 ** 10 });
    const bytes = fs.readFileSync(file);
    expect(await answer(variant(bytes, "tag", (copy) => void (copy[bytes.length - 1]! ^= 0x01)), PASS)).toBe(DAMAGED_OR_CUT);
  });

  it("gives one answer for every change to a sealed file's last segment, so its unchecked bytes tell nothing", async () => {
    const file = path.join(dir, "b.lookout");
    // One segment, so the whole stream is the last one.
    await write(file, [transcript(1, noise(5000))], { passphrase: PASS }, { segmentBytes: 65_536, scryptN: 2 ** 10 });
    const bytes = fs.readFileSync(file);
    expect(bytes.length - leadOf(bytes)).toBeLessThan(65_536);
    // Cut 16 bytes off: the footer's end takes the tag's place, and the bytes that open unchecked where the magic was are the manifest's offset.
    const cut = Buffer.from(bytes.subarray(0, bytes.length - 16));
    const tail = cut.length - 16 - 8;
    // Its six high bytes are zero: XORed with the magic's first six, they would read as the magic.
    for (let i = 0; i < 6; i++) cut[tail + i]! ^= "LOOKOUTE".charCodeAt(i);
    const answers = new Set<string>();
    for (let guess = 0; guess < 256; guess++) {
      answers.add(await answer(variant(cut, `guess-${guess}`, (copy) => void (copy[tail + 6]! ^= guess)), PASS));
    }
    expect([...answers]).toEqual([DAMAGED_OR_CUT]);
    // A file cut short anywhere in its last segment reads the same.
    for (const at of [bytes.length - 1, bytes.length - 16, bytes.length - 17, bytes.length - 40]) expect(await answer(variant(bytes, `cut-${at}`, (copy) => copy.subarray(0, at)), PASS)).toBe(DAMAGED_OR_CUT);
  });

  it("errors a file's stream when its bytes do not match its checksum, before the stream's end", async () => {
    // gzip stores noise as it is and checks its CRC only at the payload's end: the file's sha256 is what finds the change.
    const file = path.join(dir, "b.lookout");
    // A path that a notification would show as a link: the message does not repeat it.
    const items = [{ ...transcript(1, noise(20_000)), entry: { ...transcript(1, EMPTY_DATA).entry, rel: LINK } }, transcript(2, lines(20_000))];
    await write(file, items, { codec: "gzip", level: 6 });
    const bytes = fs.readFileSync(file);
    const damaged = variant(bytes, "flip", (copy) => void (copy[leadOf(bytes) + 5000]! ^= 0x01));
    const source = await openBundle(damaged);
    const ends: string[] = [];
    const errors: unknown[] = [];
    const reading = source.forEachFile(async (entry, data) => {
      data.on("end", () => ends.push(entry.rel));
      try {
        for await (const chunk of data) void chunk;
      } catch (err) {
        errors.push(err);
        throw err;
      }
    });
    await expect(reading).rejects.toMatchObject({ code: "corrupt", message: "This backup is damaged: a file does not match its checksum." });
    await source.close();
    expect(ends).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(BundleError);
  });

  it("authenticates the header: a sealed file whose header was rewritten, checksum and all, does not open", async () => {
    const file = path.join(dir, "b.lookout");
    await write(file, fixture(), { passphrase: PASS });
    rewriteHeader(file, (fields) => (fields.host = "elsewhere"));
    expect((await readBundleHeader(file)).host).toBe("elsewhere");
    // No segment opens: the first the footer is read from says so, as damage, or as damaged or cut when that is the last.
    expect(["corrupt", "truncated"]).toContain(await outcome(file, PASS));
  });

  it("refuses what is not a backup, and what a later version wrote", async () => {
    const text = path.join(dir, "notes.txt");
    fs.writeFileSync(text, "hello, this is not a backup at all\n");
    await expect(readBundleHeader(text)).rejects.toMatchObject({ code: "not-a-backup" });
    expect(await outcome(text)).toBe("not-a-backup");
    const empty = path.join(dir, "empty.lookout");
    fs.writeFileSync(empty, "");
    expect(await outcome(empty)).toBe("not-a-backup");
    const magicOnly = path.join(dir, "magic.lookout");
    fs.writeFileSync(magicOnly, "LOOKOUTB");
    expect(await outcome(magicOnly)).toBe("truncated");

    const later = path.join(dir, "later.lookout");
    await write(later, fixture());
    rewriteHeader(later, (fields) => (fields.format = 2));
    await expect(readBundleHeader(later)).rejects.toMatchObject({ code: "unsupported" });
    const cipher = path.join(dir, "cipher.lookout");
    await write(cipher, fixture());
    rewriteHeader(cipher, (fields) => (fields.cipher = "chacha20-poly1305-stream"));
    expect(await outcome(cipher)).toBe("unsupported");
  });

  it("never puts a value from the header into its message, where a notification would make a link of it", async () => {
    const unknown = "unsupported: This backup uses a format this version of Lookout cannot read.";
    const edits: [string, string | undefined, (fields: Record<string, unknown>) => void][] = [
      ["cipher", undefined, (fields) => (fields.cipher = LINK)],
      ["codec", undefined, (fields) => (fields.codec = LINK)],
      ["kdf", PASS, (fields) => ((fields.kdf as Record<string, unknown>).name = LINK)],
    ];
    for (const [name, passphrase, edit] of edits) {
      const file = path.join(dir, `${name}.lookout`);
      await write(file, fixture(), passphrase !== undefined ? { passphrase } : {});
      rewriteHeader(file, edit);
      await expect(readBundleHeader(file), name).rejects.toThrow(unknown.slice("unsupported: ".length));
      expect(await answer(file, passphrase), name).toBe(unknown);
    }
    const later = path.join(dir, "later.lookout");
    await write(later, fixture());
    rewriteHeader(later, (fields) => (fields.format = LINK));
    expect(await answer(later)).toBe("unsupported: This backup was made by a later version of Lookout.");
  });
});

describe("going through the files", () => {
  it("reads a zero-byte file, many small files, and a backup with no files", async () => {
    const file = path.join(dir, "many.lookout");
    const items = Array.from({ length: 600 }, (_, i) => ({
      entry: { kind: "tool-result", dir: "default", rel: `-home-someone-app/${sessionId(1)}/tool-results/t${i}.txt`, sessionId: sessionId(1), mtime: i } as NewFile,
      data: i % 7 === 0 ? Buffer.alloc(0) : lines(1 + ((i * 37) % 400), i),
    }));
    const added = await write(file, items, { passphrase: PASS });
    for (let i = 1; i < added.length; i++) expect(added[i]!.offset).toBe(added[i - 1]!.offset + added[i - 1]!.size);
    const { contents } = await readAll(file, PASS);
    expect(contents.size).toBe(600);
    for (const item of items) expect(contents.get(item.entry.rel)!.equals(item.data)).toBe(true);
    expect(sha256(contents.get(items[0]!.entry.rel)!)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    const none = path.join(dir, "none.lookout");
    await write(none, []);
    const read = await readAll(none);
    expect(read.manifest.files).toEqual([]);
    expect(read.contents.size).toBe(0);
  });

  it("visits only the files `want` takes, and none when it takes none", async () => {
    const file = path.join(dir, "b.lookout");
    const items = Array.from({ length: 30 }, (_, i) => transcript(i + 1, lines(500 + i * 50, i)));
    await write(file, items);
    const { contents } = await readAll(file, undefined, (entry) => entry.mtime % 3 === 0);
    expect([...contents.keys()]).toEqual(items.filter((item) => item.entry.mtime % 3 === 0).map((item) => item.entry.rel));
    for (const item of items.filter((item) => item.entry.mtime % 3 === 0)) expect(contents.get(item.entry.rel)!.equals(item.data)).toBe(true);
    expect((await readAll(file, undefined, () => false)).contents.size).toBe(0);
  });

  it("stops reading after the last file wanted", async () => {
    const file = path.join(dir, "b.lookout");
    const items = [transcript(1, lines(1000)), transcript(2, noise(200_000))];
    await write(file, items, { passphrase: PASS });
    const bytes = fs.readFileSync(file);
    // Damage 40 segments in, far past what is read ahead: only a reading of the second file finds it.
    const damaged = variant(bytes, "flip", (copy) => void (copy[leadOf(bytes) + 40 * (4096 + 16) + 5]! ^= 0x01));
    const first = await readAll(damaged, PASS, (entry) => entry.rel === items[0]!.entry.rel);
    expect(first.contents.get(items[0]!.entry.rel)!.equals(items[0]!.data)).toBe(true);
    expect(await outcome(damaged, PASS)).toBe("corrupt");
  });

  it("rejects with the visitor's own error, and goes on past a file its visitor did not read", async () => {
    const file = path.join(dir, "b.lookout");
    const items = [transcript(1, lines(40_000)), transcript(2, lines(10_000, 2))];
    await write(file, items, { passphrase: PASS });
    const source = await openBundle(file, PASS);
    await expect(
      source.forEachFile(async () => {
        throw new Error("the disk is full");
      }),
    ).rejects.toThrow("the disk is full");
    const read = new Map<string, Buffer>();
    await source.forEachFile(async (entry, data) => {
      if (entry.rel === items[0]!.entry.rel) return;
      const parts: Buffer[] = [];
      for await (const chunk of data) parts.push(chunk as Buffer);
      read.set(entry.rel, Buffer.concat(parts));
    });
    await source.close();
    expect([...read.keys()]).toEqual([items[1]!.entry.rel]);
    expect(read.get(items[1]!.entry.rel)!.equals(items[1]!.data)).toBe(true);
  });
});

describe("writing a backup", () => {
  it("goes on past a file that fails, the bytes it gave read past", async () => {
    const file = path.join(dir, "b.lookout");
    const sink = await createBundle(file, OPTIONS, SMALL);
    const first = transcript(1, lines(5000));
    await sink.addFile(first.entry, Readable.from([first.data]));
    const failing = Readable.from(
      (async function* () {
        yield Buffer.from("half of a file ");
        throw new Error("the file went away");
      })(),
    );
    await expect(sink.addFile(transcript(2, EMPTY_DATA).entry, failing)).rejects.toThrow("the file went away");
    await expect(sink.addFile(transcript(3, EMPTY_DATA).entry, path.join(dir, "missing.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    const last = transcript(4, lines(3000, 4));
    const added = await sink.addFile(last.entry, Readable.from([last.data]));
    expect(added.offset).toBe(first.data.length + "half of a file ".length);
    await sink.finish(MANIFEST);
    const { manifest, contents } = await readAll(file);
    expect(manifest.files.map((entry) => entry.rel)).toEqual([first.entry.rel, last.entry.rel]);
    expect(contents.get(first.entry.rel)!.equals(first.data)).toBe(true);
    expect(contents.get(last.entry.rel)!.equals(last.data)).toBe(true);
  });

  it("keeps the file under its .partial name until finish, and abort leaves nothing, even mid-file", async () => {
    const file = path.join(dir, "b.lookout");
    const sink = await createBundle(file, { ...OPTIONS, passphrase: PASS }, SMALL);
    await sink.addFile(transcript(1, EMPTY_DATA).entry, Readable.from([lines(9000)]));
    expect(fs.existsSync(`${file}.partial`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // A source that never ends: abort ends the add.
    const pending = sink.addFile(transcript(2, EMPTY_DATA).entry, new Readable({ read() {} }));
    await sink.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(fs.readdirSync(dir)).toEqual([]);
    await expect(sink.addFile(transcript(3, EMPTY_DATA).entry, Readable.from([Buffer.from("x")]))).rejects.toThrow();
    await expect(sink.finish(MANIFEST)).rejects.toThrow();
  });

  it("holds the source back while the file is written: what it reads stays near what is on disk", async () => {
    const file = path.join(dir, "b.lookout");
    const sink = await createBundle(file, OPTIONS, { scryptN: 2 ** 10 });
    const total = 12 * 1024 * 1024;
    let produced = 0;
    let ahead = 0;
    const source = new Readable({
      read() {
        if (produced >= total) return void this.push(null);
        ahead = Math.max(ahead, produced - fs.statSync(`${file}.partial`).size);
        produced += 64 * 1024;
        this.push(noise(64 * 1024));
      },
    });
    await sink.addFile(transcript(1, EMPTY_DATA).entry, source);
    await sink.finish(MANIFEST);
    expect(ahead).toBeLessThan(6 * 1024 * 1024);
  });

  it("refuses an entry whose path could leave its root, and keeps only the entry's own fields", async () => {
    const sink = await createBundle(path.join(dir, "b.lookout"), OPTIONS, SMALL);
    for (const rel of ["../escape.jsonl", "/etc/passwd", "a\\b.jsonl", "", "a//b.jsonl", "./a.jsonl", "a/../../b", "C:/x.jsonl", "a\0b"]) {
      await expect(sink.addFile({ kind: "transcript", rel, mtime: 1 }, Readable.from([Buffer.from("x")])), JSON.stringify(rel)).rejects.toThrow();
    }
    await expect(sink.addFile({ kind: "memory" as NewFile["kind"], rel: "a.md", mtime: 1 }, Readable.from([Buffer.from("x")]))).rejects.toThrow();
    const extra = { kind: "transcript", rel: "-a/x.jsonl", mtime: 1, abs: "/home/someone/.claude/projects/-a/x.jsonl", lastActive: 9 } as NewFile;
    const added = await sink.addFile(extra, Readable.from([Buffer.from("x")]));
    expect(Object.keys(added).sort()).toEqual(["kind", "mtime", "offset", "rel", "sha256", "size"]);
    await sink.abort();
  });
});
