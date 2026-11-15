// A backup file: every file a backup holds and a manifest that says what
// each one is, in one file written and read as a stream. The files' bytes
// go back to back through one compressor, so what repeats from file to file
// is stored once; the manifest follows as a compressed frame of its own,
// then a footer that says where the manifest starts:
//
//   [magic "LOOKOUTB"][u32 BE header length][header JSON, in the clear]
//   [body: the stream below, in segments of a fixed size]
//
//   [payload: every file's bytes, compressed as one stream]
//   [manifest: JSON, compressed as one frame]
//   [footer: u64 BE payload length, u64 BE manifest offset,
//            u64 BE manifest length, magic "LOOKOUTE"]
//
// With a passphrase each segment is sealed on its own with AES-256-GCM
// (the STREAM construction: a nonce of a random prefix, the segment's
// number and a mark on the last one), with the file's header as the
// associated data, so nothing in the header, the order of the segments or
// the end of the file can change unnoticed. Every segment but the last
// holds the same number of bytes, so the footer and the manifest are found
// from the file's size alone, without reading the payload. The header ends
// with a sha256 of itself: a damaged header reads as damage, never as a
// wrong passphrase.
import * as crypto from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { pipeline, Readable, type Transform } from "node:stream";
import * as zlib from "node:zlib";
import type { SessionRecord } from "../sessionRecords";
import {
  BundleError,
  LIGHT_STATE_KEYS,
  SECTIONS,
  type BundleFile,
  type BundleHeader,
  type BundleManifest,
  type BundleSink,
  type BundleSource,
  type Codec,
  type FileKind,
  type LightStateKey,
  type ManifestBody,
  type NewFile,
  type SectionId,
  type WindowTabs,
  type WriteOptions,
} from "./types";

/** Bytes of the stream in each segment; the last one holds what is left. */
export const SEGMENT_BYTES = 1024 * 1024;
const MIN_SEGMENT_BYTES = 16;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

const MAGIC = Buffer.from("LOOKOUTB", "latin1");
const END_MAGIC = Buffer.from("LOOKOUTE", "latin1");
/** The magic and the header's length. */
const LEAD_BYTES = MAGIC.length + 4;
const HEADER_MAX = 64 * 1024;
const FOOTER_BYTES = 24 + END_MAGIC.length;
/** `,"sum":"<64 hex>"}`: how the header ends. */
const SUM_BYTES = 74;
const SUM_PATTERN = /^,"sum":"[0-9a-f]{64}"\}$/;
/** A manifest larger than this, compressed or not, is not one Lookout wrote. */
const MANIFEST_MAX = 256 * 1024 * 1024;

const TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 7;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** The passphrase check: the scrypt output's bytes after the key. */
const CHECK_BYTES = 16;
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** scrypt needs 128 × N × r bytes: 128 MiB at the costs above, more than Node allows by default. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** A file asking for more parallel work than this costs too long to open. */
const SCRYPT_P_MAX = 4;

/** zstd keeps the last 128 MiB in reach, so a session's transcript and its subagents' share their bytes. */
const WINDOW_LOG = 27;
const GZIP_LEVEL = 6;
/** The compressors' chunks, and the reads of a file going in. */
const CHUNK_BYTES = 64 * 1024;
/** Segments read ahead of the decompressor. */
const READ_AHEAD = 4;
/** What a file's reader may have waiting before the feeding pauses. */
const OUTLET_BYTES = 256 * 1024;

const FILE_KINDS: ReadonlySet<string> = new Set<FileKind>(["transcript", "subagent", "tool-result", "history", "vault", "usage", "removed-worktrees"]);
const EMPTY = Buffer.alloc(0);

/** Settings the tests turn down. The file records both, so any reader reads it. */
export interface BundleTuning {
  /** Bytes of the stream in each segment. */
  segmentBytes?: number;
  /** scrypt's cost, a power of two. */
  scryptN?: number;
}

/** This Node.js has zstd (22.15 and later). Without it a backup is written with gzip, and one written with zstd cannot be read. */
export function zstdAvailable(): boolean {
  return typeof zlib.createZstdCompress === "function" && typeof zlib.createZstdDecompress === "function";
}

/**
 * Starts a backup at `file`. It is written to `<file>.partial` and moved
 * into place by `finish`. zstd falls back to gzip at level 6 where this
 * Node.js lacks it; the header says which one the file holds. With a
 * passphrase the key is derived here, which takes a second or two.
 */
export async function createBundle(file: string, options: WriteOptions, tuning: BundleTuning = {}): Promise<BundleSink> {
  const segmentBytes = tuning.segmentBytes ?? SEGMENT_BYTES;
  if (!Number.isInteger(segmentBytes) || segmentBytes < MIN_SEGMENT_BYTES || segmentBytes > MAX_SEGMENT_BYTES) throw new RangeError(`Segment size out of range: ${segmentBytes}`);
  const scryptN = tuning.scryptN ?? SCRYPT_N;
  if (!scryptCostOk(scryptN, SCRYPT_R, SCRYPT_P)) throw new RangeError(`scrypt cost out of range: ${scryptN}`);
  const codec: Codec = options.codec === "zstd" && zstdAvailable() ? "zstd" : "gzip";
  const level = codec === options.codec ? options.level : GZIP_LEVEL;
  if (!Number.isInteger(level) || level < 1 || level > (codec === "zstd" ? 19 : 9)) throw new RangeError(`${codec} level out of range: ${level}`);
  if (options.passphrase === "") throw new Error("The passphrase is empty.");

  const fields: Record<string, unknown> = { format: 1, cipher: options.passphrase === undefined ? "none" : "aes-256-gcm-stream" };
  let keys: { key: Buffer; noncePrefix: Buffer } | undefined;
  if (options.passphrase !== undefined) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const derived = await deriveKey(options.passphrase, salt, scryptN, SCRYPT_R, SCRYPT_P);
    // A fresh salt makes a fresh key for every file, and a fresh prefix keeps even a repeated key's nonces apart.
    keys = { key: derived.key, noncePrefix: crypto.randomBytes(NONCE_PREFIX_BYTES) };
    fields.kdf = { name: "scrypt", N: scryptN, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("hex"), check: derived.check.toString("hex") };
  }
  Object.assign(fields, { codec, createdAt: options.createdAt, host: options.host, segment: segmentBytes });
  if (keys) fields.noncePrefix = keys.noncePrefix.toString("hex");
  const lead = headerBytes(fields);

  const partial = `${file}.partial`;
  await fs.promises.rm(partial, { force: true });
  // Only its owner reads it: it holds the user's conversations.
  const handle = await fs.promises.open(partial, "wx", 0o600);
  try {
    await writeAt(handle, lead, 0);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
  const sealer = keys ? new Sealer(keys.key, keys.noncePrefix, lead) : undefined;
  return new Writer(file, partial, handle, new SegmentWriter(handle, lead.length, segmentBytes, sealer), compressor(codec, level), codec, level, lead.length);
}

/** What a backup says about itself, read from its start alone: whether it needs a passphrase, and when and where it was made. */
export async function readBundleHeader(file: string): Promise<BundleHeader> {
  const handle = await fs.promises.open(file, "r");
  try {
    const head = await readHead(handle, (await handle.stat()).size);
    return head.header;
  } finally {
    await handle.close();
  }
}

/**
 * Opens a backup: checks the passphrase, then reads its footer and manifest
 * from the end of the file. The payload is read only by `forEachFile`.
 */
export async function openBundle(file: string, passphrase?: string): Promise<BundleSource> {
  const handle = await fs.promises.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const head = await readHead(handle, size);
    let sealer: Sealer | undefined;
    if (head.seal) {
      if (passphrase === undefined) throw new BundleError("wrong-passphrase", "This backup is encrypted: it needs its passphrase.");
      const { N, r, p } = head.seal;
      const derived = await deriveKey(passphrase, head.seal.salt, N, r, p);
      if (!crypto.timingSafeEqual(derived.check, head.seal.check)) throw new BundleError("wrong-passphrase", "The passphrase is wrong.");
      sealer = new Sealer(derived.key, head.seal.noncePrefix, head.lead);
    }
    const body = new Body(handle, head.lead.length, size - head.lead.length, head.segmentBytes, sealer);
    const footer = await body.footer();
    if (footer.manifestLength > MANIFEST_MAX) throw damaged("its manifest is too large");
    const frame = await body.read(footer.manifestOffset, footer.manifestOffset + footer.manifestLength);
    const manifest = parseManifest(await decompressFrame(frame, head.header.codec), footer.payloadLength);
    return new Reader(handle, head.header, manifest, body, footer, head.header.codec);
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------- writing

/** A backup being written: files stream through the compressor into the segments, the manifest and footer last. */
class Writer implements BundleSink {
  private readonly files: BundleFile[] = [];
  /** Uncompressed bytes taken, a failed file's included: the next file's offset. */
  private payloadBytes = 0;
  /** The files go in one after another: each add waits for the one before. */
  private queue: Promise<unknown> = Promise.resolve();
  private state: "open" | "finishing" | "done" = "open";
  private finishing: Promise<unknown> | undefined;
  private finished = false;
  private failure: Error | undefined;
  private readonly broken: Promise<never>;
  private breakWith: (err: Error) => void = () => undefined;
  private readonly pumped: Promise<void>;
  private source: Readable | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly file: string,
    private readonly partial: string,
    private readonly handle: FileHandle,
    private readonly segments: SegmentWriter,
    private readonly payload: Transform,
    private readonly codec: Codec,
    private readonly level: number,
    private readonly leadBytes: number,
  ) {
    this.broken = new Promise<never>((_, reject) => (this.breakWith = reject));
    this.broken.catch(() => undefined);
    // The pump below hears the compressor's errors; this keeps one from going unheard after it stopped.
    this.payload.on("error", (err) => this.fail(err));
    this.pumped = this.pump();
    this.pumped.catch((err: unknown) => this.fail(asError(err)));
  }

  /** The compressor's output into the segments, as fast as the file takes it: a slow disk holds the compressor back, and it the files going in. */
  private async pump(): Promise<void> {
    for await (const chunk of this.payload) await this.segments.write(chunk as Buffer);
  }

  addFile(entry: NewFile, source: string | Readable): Promise<BundleFile> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.state !== "open") return Promise.reject(new Error("The backup is finished."));
    const added = this.queue.then(() => this.add(entry, source));
    this.queue = added.catch(() => undefined);
    return added;
  }

  /**
   * Streams one file into the payload. A source that fails part way leaves
   * the bytes it gave in the payload, listed nowhere: the next file starts
   * after them, the reader skips them, and the backup goes on.
   */
  private async add(entry: NewFile, source: string | Readable): Promise<BundleFile> {
    if (this.failure) throw this.failure;
    const clean = cleanEntry(entry);
    const input = typeof source === "string" ? fs.createReadStream(source, { highWaterMark: CHUNK_BYTES }) : source;
    this.source = input;
    const hash = crypto.createHash("sha256");
    const offset = this.payloadBytes;
    let size = 0;
    try {
      for await (const chunk of input) {
        if (this.failure) break;
        const bytes = toBuffer(chunk);
        hash.update(bytes);
        size += bytes.length;
        this.payloadBytes += bytes.length;
        if (!this.payload.write(bytes)) await this.drained();
      }
    } catch (err) {
      throw this.failure ?? err;
    } finally {
      this.source = undefined;
    }
    if (this.failure) throw this.failure;
    const file: BundleFile = { ...clean, size, sha256: hash.digest("hex"), offset };
    this.files.push(file);
    return file;
  }

  /** The compressor has room again, or the backup failed. */
  private drained(): Promise<void> {
    const drain = once(this.payload, "drain").then(() => undefined);
    drain.catch(() => undefined);
    return Promise.race([drain, this.broken]);
  }

  finish(manifest: ManifestBody): Promise<{ bytes: number }> {
    if (this.state !== "open") return Promise.reject(this.failure ?? new Error("The backup is finished."));
    this.state = "finishing";
    const finishing = this.complete(manifest);
    this.finishing = finishing;
    return finishing;
  }

  private async complete(manifest: ManifestBody): Promise<{ bytes: number }> {
    try {
      this.check();
      await this.queue;
      this.check();
      this.payload.end();
      await this.pumped;
      this.check();
      const manifestOffset = this.segments.length;
      // The payload's length again, inside the checked manifest: a footer damaged there is caught too.
      const json = JSON.stringify({ ...manifest, files: this.files, payloadLength: this.payloadBytes });
      const frame = await compressFrame(Buffer.from(json, "utf8"), this.codec, this.level);
      this.check();
      await this.segments.write(frame);
      await this.segments.write(footerBytes(this.payloadBytes, manifestOffset, frame.length));
      await this.segments.end();
      this.check();
      await this.handle.sync();
      await this.closeHandle();
      this.check();
      await fs.promises.rename(this.partial, this.file);
      if (this.failure) {
        // Cancelled while it was moved into place: it goes all the same.
        await fs.promises.rm(this.file, { force: true });
        throw this.failure;
      }
      this.finished = true;
      return { bytes: this.leadBytes + this.segments.written };
    } catch (err) {
      await this.discard();
      throw this.failure ?? err;
    } finally {
      this.state = "done";
    }
  }

  async abort(): Promise<void> {
    if (this.finished) return;
    this.fail(new Error("The backup was cancelled."));
    if (this.finishing) await this.finishing.catch(() => undefined);
    await this.queue;
    await this.pumped.catch(() => undefined);
    this.state = "done";
    await this.discard();
  }

  private check(): void {
    if (this.failure) throw this.failure;
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.breakWith(err);
    this.payload.destroy();
    this.source?.destroy();
  }

  private closeHandle(): Promise<void> {
    this.closing ??= this.handle.close();
    return this.closing;
  }

  private async discard(): Promise<void> {
    await this.closeHandle().catch(() => undefined);
    await fs.promises.rm(this.partial, { force: true });
  }
}

/** Cuts the stream into segments, seals each one when there is a key, and writes them in order. The last segment waits for `end`, which marks it. */
class SegmentWriter {
  private held: Buffer[] = [];
  private heldBytes = 0;
  private index = 0;
  /** Bytes of the stream taken so far. */
  length = 0;
  /** Bytes written to the file after the header. */
  written = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly at: number,
    private readonly size: number,
    private readonly sealer: Sealer | undefined,
  ) {}

  async write(chunk: Buffer): Promise<void> {
    if (!chunk.length) return;
    this.held.push(chunk);
    this.heldBytes += chunk.length;
    this.length += chunk.length;
    // More than a segment held: the first one is not the last, so it can go.
    if (this.heldBytes <= this.size) return;
    const all = Buffer.concat(this.held, this.heldBytes);
    let from = 0;
    while (all.length - from > this.size) {
      await this.emit(all.subarray(from, from + this.size), false);
      from += this.size;
    }
    const rest = all.subarray(from);
    this.held = [rest];
    this.heldBytes = rest.length;
  }

  async end(): Promise<void> {
    await this.emit(Buffer.concat(this.held, this.heldBytes), true);
    this.held = [];
    this.heldBytes = 0;
  }

  private async emit(plain: Buffer, last: boolean): Promise<void> {
    if (this.index > 0xffffffff) throw new Error("The backup has more segments than a nonce counts.");
    const out = this.sealer ? this.sealer.seal(plain, this.index, last) : plain;
    await writeAt(this.handle, out, this.at + this.written);
    this.written += out.length;
    this.index++;
  }
}

function compressor(codec: Codec, level: number): Transform {
  if (codec === "gzip") return zlib.createGzip({ level, chunkSize: CHUNK_BYTES });
  const C = zlib.constants;
  return zlib.createZstdCompress({
    chunkSize: CHUNK_BYTES,
    params: { [C.ZSTD_c_compressionLevel]: level, [C.ZSTD_c_windowLog]: WINDOW_LOG, [C.ZSTD_c_enableLongDistanceMatching]: 1, [C.ZSTD_c_checksumFlag]: 1 },
  });
}

/** The manifest's frame: one small input, so the defaults' window serves. */
function compressFrame(data: Buffer, codec: Codec, level: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (codec === "gzip") zlib.gzip(data, { level }, done);
    else zlib.zstdCompress(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level, [zlib.constants.ZSTD_c_checksumFlag]: 1 } }, done);
  });
}

function footerBytes(payloadLength: number, manifestOffset: number, manifestLength: number): Buffer {
  const footer = Buffer.alloc(FOOTER_BYTES);
  footer.writeBigUInt64BE(BigInt(payloadLength), 0);
  footer.writeBigUInt64BE(BigInt(manifestOffset), 8);
  footer.writeBigUInt64BE(BigInt(manifestLength), 16);
  END_MAGIC.copy(footer, 24);
  return footer;
}

/** The magic, the length and the header's JSON, which ends with a sha256 of the JSON before it. */
function headerBytes(fields: Record<string, unknown>): Buffer {
  const body = JSON.stringify(fields);
  const sum = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  const json = Buffer.from(`${body.slice(0, -1)},"sum":"${sum}"}`, "utf8");
  if (json.length > HEADER_MAX) throw new RangeError("The backup's header is too long.");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([MAGIC, length, json]);
}

/** The entry as the manifest keeps it: the contract's fields and no others, its path checked. */
function cleanEntry(entry: NewFile): NewFile {
  if (!FILE_KINDS.has(entry.kind)) throw new Error(`Not a kind of file a backup holds: ${String(entry.kind)}`);
  if (typeof entry.rel !== "string" || !safeRel(entry.rel)) throw new Error(`Not a relative path with forward slashes: ${String(entry.rel)}`);
  if (typeof entry.mtime !== "number" || !Number.isFinite(entry.mtime)) throw new Error(`Not a time: ${String(entry.mtime)}`);
  const clean: NewFile = { kind: entry.kind, rel: entry.rel, mtime: entry.mtime };
  if (typeof entry.dir === "string") clean.dir = entry.dir;
  if (typeof entry.sessionId === "string") clean.sessionId = entry.sessionId;
  if (typeof entry.cwd === "string") clean.cwd = entry.cwd;
  return clean;
}

/** A path under a root: forward slashes, no empty, `.` or `..` part, nothing absolute. */
function safeRel(rel: string): boolean {
  if (rel === "" || rel.includes("\\") || rel.includes("\0") || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError("A file's stream gives bytes or strings.");
}

// ---------------------------------------------------------------- reading

/** A backup's header as the file has it, with what reading the body takes. */
interface Head {
  header: BundleHeader;
  /** The magic, the length and the JSON: every segment's associated data. */
  lead: Buffer;
  segmentBytes: number;
  seal?: { N: number; r: number; p: number; salt: Buffer; check: Buffer; noncePrefix: Buffer };
}

/** Reads and checks the header. A reader without the file's codec refuses it here, before asking for a passphrase. */
async function readHead(handle: FileHandle, size: number): Promise<Head> {
  if (size === 0) throw new BundleError("not-a-backup", "This file is empty, not a Lookout backup.");
  const start = await readAt(handle, 0, Math.min(size, LEAD_BYTES));
  const seen = Math.min(start.length, MAGIC.length);
  if (!start.subarray(0, seen).equals(MAGIC.subarray(0, seen))) throw new BundleError("not-a-backup", "This file is not a Lookout backup.");
  if (start.length < LEAD_BYTES) throw cutShort();
  const length = start.readUInt32BE(MAGIC.length);
  if (length < SUM_BYTES || length > HEADER_MAX) throw damaged("its header's length is wrong");
  if (LEAD_BYTES + length > size) throw cutShort();
  const json = await readAt(handle, LEAD_BYTES, length);
  if (json.length < length) throw cutShort();
  const head = parseHead(json);
  if (head.header.codec === "zstd" && !zstdAvailable()) {
    throw new BundleError("unsupported", `This backup is compressed with zstd, which this Node.js (${process.version}) cannot read: zstd needs Node.js 22.15 or later, as in a newer VS Code.`);
  }
  return { ...head, lead: Buffer.concat([start, json]) };
}

function parseHead(json: Buffer): Omit<Head, "lead"> {
  let fields: unknown;
  try {
    fields = JSON.parse(json.toString("utf8"));
  } catch {
    throw damaged("its header does not parse");
  }
  if (!isRecord(fields)) throw damaged("its header does not parse");
  const tail = json.subarray(json.length - SUM_BYTES).toString("latin1");
  if (!SUM_PATTERN.test(tail)) {
    // A later format may end its header otherwise; this one always ends with the sum.
    if (typeof fields.format === "number" && fields.format !== 1) throw later();
    throw damaged("its header has no checksum");
  }
  const body = Buffer.concat([json.subarray(0, json.length - SUM_BYTES), Buffer.from("}")]);
  if (crypto.createHash("sha256").update(body).digest("hex") !== tail.slice(8, 72)) throw damaged("its header does not match its checksum");

  if (fields.format !== 1) throw later();
  const { cipher, codec, createdAt, host } = fields;
  if (cipher !== "none" && cipher !== "aes-256-gcm-stream") throw unknownFormat();
  if (codec !== "zstd" && codec !== "gzip") throw unknownFormat();
  if (typeof createdAt !== "number" || typeof host !== "string") throw damaged("its header is incomplete");
  const segmentBytes = fields.segment ?? SEGMENT_BYTES;
  if (typeof segmentBytes !== "number" || !Number.isInteger(segmentBytes) || segmentBytes < MIN_SEGMENT_BYTES || segmentBytes > MAX_SEGMENT_BYTES) {
    throw new BundleError("unsupported", "This backup's segments are a size this version of Lookout does not read.");
  }
  const header: BundleHeader = { format: 1, cipher, codec, createdAt, host };
  if (cipher === "none") return { header, segmentBytes };

  const kdf = fields.kdf;
  if (!isRecord(kdf)) throw damaged("its header has no key derivation");
  if (kdf.name !== "scrypt") throw unknownFormat();
  const { N, r, p } = kdf;
  if (typeof N !== "number" || typeof r !== "number" || typeof p !== "number" || !scryptCostOk(N, r, p)) {
    throw new BundleError("unsupported", "This backup's passphrase is stretched at a cost this version of Lookout does not take on.");
  }
  const salt = hexOf(kdf.salt);
  const check = hexOf(kdf.check);
  const noncePrefix = hexOf(fields.noncePrefix);
  if (!salt || salt.length < 8 || check?.length !== CHECK_BYTES || noncePrefix?.length !== NONCE_PREFIX_BYTES) throw damaged("its header's key derivation is incomplete");
  header.kdf = { name: "scrypt", N, r, p, salt: salt.toString("hex") };
  return { header, segmentBytes, seal: { N, r, p, salt, check, noncePrefix } };
}

/** The file's body: its segments, opened and checked one by one, read in any order. */
class Body {
  /** Segments in the file. */
  readonly count: number;
  /** Bytes of the stream they hold, when the file is whole. */
  readonly length: number;
  private readonly stride: number;
  /** The last segment is long enough to be one: a sealed one holds a byte and its tag at least. */
  private readonly ends: boolean;

  constructor(
    private readonly handle: FileHandle,
    private readonly at: number,
    private readonly bytes: number,
    private readonly size: number,
    private readonly sealer: Sealer | undefined,
  ) {
    const tag = sealer ? TAG_BYTES : 0;
    this.stride = size + tag;
    this.count = bytes > 0 ? Math.ceil(bytes / this.stride) : 0;
    const lastBytes = this.count ? bytes - (this.count - 1) * this.stride : 0;
    this.ends = lastBytes > tag;
    this.length = this.ends ? (this.count - 1) * size + lastBytes - tag : 0;
  }

  /** Segment `i` as stored. */
  private async raw(i: number): Promise<Buffer> {
    const start = i * this.stride;
    const length = Math.min(this.stride, this.bytes - start);
    const raw = await readAt(this.handle, this.at + start, length);
    if (raw.length < length) throw cutShort();
    return raw;
  }

  /**
   * Segment `i`'s bytes, checked. A segment before the last that fails its
   * check is damage. The last one is sealed as the last: one that does not
   * open was cut short or changed, and only its unchecked bytes could say
   * which, so it is reported one way.
   */
  async plain(i: number): Promise<Buffer> {
    const raw = await this.raw(i);
    if (!this.sealer) return raw;
    const last = i === this.count - 1;
    const plain = this.sealer.open(raw, i, last);
    if (plain) return plain;
    if (last) throw damagedOrCut();
    throw damaged(`segment ${i + 1} of ${this.count} does not check out`);
  }

  /** The stream's bytes from `from` to `to`, a segment at a time. */
  async *range(from: number, to: number): AsyncGenerator<Buffer> {
    for (let i = Math.floor(from / this.size); i * this.size < to; i++) {
      const plain = await this.plain(i);
      const base = i * this.size;
      yield plain.subarray(Math.max(from - base, 0), Math.min(to - base, plain.length));
    }
  }

  async read(from: number, to: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of this.range(from, to)) parts.push(part);
    return Buffer.concat(parts);
  }

  /**
   * The footer, from the last segments. A sealed file is whole when its
   * last segment opens as the last one; `plain` reports one that does not.
   * A file in the clear holds no secret, so its own bytes tell a cut from
   * damage: one that ends in anything but the footer's magic was cut short,
   * and one whose magic is wrong by a byte is damaged.
   */
  async footer(): Promise<Footer> {
    if (!this.ends || this.length < FOOTER_BYTES) throw cutShort();
    const first = Math.floor((this.length - FOOTER_BYTES) / this.size);
    const parts: Buffer[] = [];
    for (let i = first; i < this.count; i++) parts.push(await this.plain(i));
    const tail = Buffer.concat(parts).subarray(-FOOTER_BYTES);
    const off = differences(tail.subarray(24), END_MAGIC);
    if (off > 1) throw cutShort();
    if (off) throw damaged("its footer is wrong");
    const payloadLength = u64(tail, 0);
    const manifestOffset = u64(tail, 8);
    const manifestLength = u64(tail, 16);
    if (payloadLength === undefined || manifestOffset === undefined || manifestLength === undefined || manifestOffset + manifestLength + FOOTER_BYTES !== this.length) {
      throw damaged("its footer is wrong");
    }
    return { payloadLength, manifestOffset, manifestLength };
  }
}

interface Footer {
  /** Bytes of the payload uncompressed: every file's, and any a failed file left. */
  payloadLength: number;
  /** Where the manifest's frame starts in the stream: the compressed payload's length. */
  manifestOffset: number;
  manifestLength: number;
}

/** A backup open for reading. */
class Reader implements BundleSource {
  private closed = false;

  constructor(
    private readonly handle: FileHandle,
    readonly header: BundleHeader,
    readonly manifest: BundleManifest,
    private readonly body: Body,
    private readonly end: Footer,
    private readonly codec: Codec,
  ) {}

  /**
   * Goes through the payload once, in order. `want` is asked about every
   * file before the payload is read, so the reading stops after the last
   * file wanted. The payload is checked as it goes: a damaged segment, a
   * stream that does not decompress or a file that does not match its
   * sha256 rejects with "corrupt", and the file being read errors with it,
   * so its reader never takes damaged bytes for a whole file.
   */
  async forEachFile(visit: (entry: BundleFile, data: Readable) => Promise<void>, want?: (entry: BundleFile) => boolean): Promise<void> {
    if (this.closed) throw new Error("The backup is closed.");
    const files = this.manifest.files;
    const wanted = files.map((entry) => !want || want(entry));
    const lastWanted = wanted.lastIndexOf(true);
    if (lastWanted < 0) return;

    const compressed = Readable.from(this.body.range(0, this.end.manifestOffset), { highWaterMark: READ_AHEAD });
    const inflate = decompressor(this.codec);
    // Errors reach the reading below through the decompressor; this only says when both streams are done with the file.
    const done = new Promise<void>((resolve) => pipeline(compressed, inflate, () => resolve()));
    const cursor = new Cursor(inflate[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
    try {
      let at = 0;
      for (let i = 0; i <= lastWanted; i++) {
        const entry = files[i]!;
        await cursor.skip(entry.offset - at);
        at = entry.offset + entry.size;
        if (wanted[i]) await deliver(entry, cursor, visit);
        else await cursor.skip(entry.size);
      }
    } finally {
      inflate.destroy();
      compressed.destroy();
      await done;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

/** Hands one file's bytes to `visit` as fast as it reads them, checking them against the file's sha256 before the stream ends. */
async function deliver(entry: BundleFile, cursor: Cursor, visit: (entry: BundleFile, data: Readable) => Promise<void>): Promise<void> {
  const data = new Outlet();
  let refused: { error: unknown } | undefined;
  const visiting = (async () => visit(entry, data))().then(
    () => data.stop(),
    (error: unknown) => {
      refused = { error };
      data.stop();
    },
  );
  const hash = crypto.createHash("sha256");
  let left = entry.size;
  try {
    while (left > 0) {
      const chunk = await cursor.next(left);
      if (!chunk) throw damaged("its payload ends inside a file");
      left -= chunk.length;
      hash.update(chunk);
      if (!(await data.offer(chunk))) break;
    }
    if (!left) {
      if (hash.digest("hex") !== entry.sha256) throw damaged("a file does not match its checksum");
      data.push(null);
    }
  } catch (err) {
    data.destroy(asError(err));
    await visiting;
    throw err;
  }
  await visiting;
  if (refused) throw refused.error;
  // The reader stopped before the end: the rest is read past.
  await cursor.skip(left);
}

/** The stream one file's reader gets: fed while it reads, paused while it does not. */
class Outlet extends Readable {
  private wake: (() => void) | undefined;
  private hungry = false;
  private stopped = false;

  constructor() {
    super({ highWaterMark: OUTLET_BYTES });
  }

  override _read(): void {
    this.hungry = true;
    this.release();
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    this.stop();
    callback(err);
  }

  /** Nobody reads it any more. */
  stop(): void {
    this.stopped = true;
    this.release();
  }

  /** Feeds a chunk, and waits while the reader has enough. False once nobody reads. */
  async offer(chunk: Buffer): Promise<boolean> {
    if (this.stopped) return false;
    this.hungry = false;
    if (this.push(chunk) || this.hungry) return true;
    await new Promise<void>((resolve) => (this.wake = resolve));
    return !this.stopped;
  }

  private release(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

/** Reads the decompressed payload by the byte count, across the decompressor's chunks. */
class Cursor {
  private rest: Buffer = EMPTY;

  constructor(private readonly chunks: AsyncIterator<Buffer>) {}

  /** Up to `max` bytes; nothing at the end of the payload. */
  async next(max: number): Promise<Buffer | undefined> {
    while (!this.rest.length) {
      let step: IteratorResult<Buffer>;
      try {
        step = await this.chunks.next();
      } catch (err) {
        throw fromStream(err);
      }
      if (step.done) return undefined;
      this.rest = step.value;
    }
    const out = this.rest.subarray(0, max);
    this.rest = this.rest.subarray(out.length);
    return out;
  }

  async skip(bytes: number): Promise<void> {
    while (bytes > 0) {
      const chunk = await this.next(bytes);
      if (!chunk) throw damaged("its payload ends early");
      bytes -= chunk.length;
    }
  }
}

function decompressor(codec: Codec): Transform {
  if (codec === "gzip") return zlib.createGunzip({ chunkSize: CHUNK_BYTES });
  return zlib.createZstdDecompress({ chunkSize: CHUNK_BYTES, params: { [zlib.constants.ZSTD_d_windowLogMax]: WINDOW_LOG } });
}

function decompressFrame(data: Buffer, codec: Codec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(fromStream(err)) : resolve(out));
    if (codec === "gzip") zlib.gunzip(data, { maxOutputLength: MANIFEST_MAX }, done);
    else zlib.zstdDecompress(data, { maxOutputLength: MANIFEST_MAX, params: { [zlib.constants.ZSTD_d_windowLogMax]: WINDOW_LOG } }, done);
  });
}

/** The manifest, checked as far as reading the payload needs and its consumers' types say; the restore checks each value again before it uses it. */
function parseManifest(bytes: Buffer, payloadLength: number): BundleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw damaged("its manifest does not parse");
  }
  if (!isRecord(raw)) throw damaged("its manifest does not parse");
  if (raw.format !== 1) throw typeof raw.format === "number" ? later() : damaged("its manifest has no format");
  if (raw.payloadLength !== payloadLength) throw damaged("its footer and its manifest disagree");
  const { createdAt, lookoutVersion, source, sections, state, notes, tabs, claudeDirs, files } = raw;
  if (
    typeof createdAt !== "number" ||
    typeof lookoutVersion !== "string" ||
    !isRecord(source) ||
    typeof source.host !== "string" ||
    typeof source.platform !== "string" ||
    typeof source.home !== "string" ||
    typeof source.wsl !== "boolean" ||
    !Array.isArray(sections) ||
    !isRecord(state) ||
    !Array.isArray(notes) ||
    !Array.isArray(tabs) ||
    !Array.isArray(claudeDirs) ||
    !Array.isArray(files)
  ) {
    throw damaged("its manifest is incomplete");
  }
  const kept: BundleFile[] = [];
  let end = 0;
  for (const item of files) {
    const file = parseFile(item);
    if (file.offset < end || file.offset + file.size > payloadLength) throw damaged("its manifest's files overlap or run past the payload");
    end = file.offset + file.size;
    // A kind a later version adds is left out; its bytes are read past.
    if (FILE_KINDS.has(file.kind)) kept.push(file);
  }
  const lightState: Partial<Record<LightStateKey, unknown>> = {};
  for (const key of LIGHT_STATE_KEYS) if (key in state) lightState[key] = state[key];
  return {
    format: 1,
    createdAt,
    lookoutVersion,
    source: { host: source.host, platform: source.platform as NodeJS.Platform, home: source.home, wsl: source.wsl },
    sections: sections.filter((section): section is SectionId => SECTIONS.includes(section as SectionId)),
    state: lightState,
    notes: notes.filter(isRecord) as unknown as SessionRecord[],
    tabs: tabs.filter(isRecord) as unknown as WindowTabs[],
    claudeDirs: claudeDirs.filter(
      (dir): dir is BundleManifest["claudeDirs"][number] => isRecord(dir) && typeof dir.label === "string" && typeof dir.resolved === "string" && typeof dir.isDefault === "boolean",
    ),
    files: kept,
  };
}

function parseFile(item: unknown): BundleFile {
  if (!isRecord(item)) throw damaged("its manifest lists a file it does not describe");
  const { kind, dir, rel, sessionId, cwd, size, mtime, sha256, offset } = item;
  if (
    typeof kind !== "string" ||
    typeof rel !== "string" ||
    !isCount(size) ||
    !isCount(offset) ||
    typeof mtime !== "number" ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    (dir !== undefined && typeof dir !== "string") ||
    (sessionId !== undefined && typeof sessionId !== "string") ||
    (cwd !== undefined && typeof cwd !== "string")
  ) {
    throw damaged("its manifest lists a file it does not describe");
  }
  const file: BundleFile = { kind: kind as FileKind, rel, size, mtime, sha256, offset };
  if (dir !== undefined) file.dir = dir;
  if (sessionId !== undefined) file.sessionId = sessionId;
  if (cwd !== undefined) file.cwd = cwd;
  return file;
}

// ---------------------------------------------------------------- both

/** Seals and opens segments: AES-256-GCM, a nonce per segment, the file's header as associated data. */
class Sealer {
  constructor(
    private readonly key: Buffer,
    private readonly noncePrefix: Buffer,
    private readonly aad: Buffer,
  ) {}

  /** The random prefix, the segment's number, and 1 on the last segment: no two segments of any file share a nonce. */
  private nonce(index: number, last: boolean): Buffer {
    const nonce = Buffer.alloc(NONCE_PREFIX_BYTES + 5);
    this.noncePrefix.copy(nonce, 0);
    nonce.writeUInt32BE(index, NONCE_PREFIX_BYTES);
    nonce[NONCE_PREFIX_BYTES + 4] = last ? 1 : 0;
    return nonce;
  }

  /** The segment's bytes encrypted, then their tag. */
  seal(plain: Buffer, index: number, last: boolean): Buffer {
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, this.nonce(index, last), { authTagLength: TAG_BYTES });
    cipher.setAAD(this.aad);
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }

  /** The segment's bytes when they check out; nothing when they do not, so unchecked bytes never leave here. */
  open(sealed: Buffer, index: number, last: boolean): Buffer | undefined {
    const cut = sealed.length - TAG_BYTES;
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, this.nonce(index, last), { authTagLength: TAG_BYTES });
    decipher.setAAD(this.aad);
    decipher.setAuthTag(sealed.subarray(cut));
    const plain = decipher.update(sealed.subarray(0, cut));
    try {
      decipher.final();
      return plain;
    } catch {
      return undefined;
    }
  }
}

/**
 * The key and the passphrase check: scrypt's output past the key's 32
 * bytes is a block of its own, so the key is the same as scrypt's 32-byte
 * output and the check tells nothing of it.
 */
function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Promise<{ key: Buffer; check: Buffer }> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase.normalize("NFC"), salt, KEY_BYTES + CHECK_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, out) => {
      if (err) reject(err);
      else resolve({ key: out.subarray(0, KEY_BYTES), check: out.subarray(KEY_BYTES) });
    });
  });
}

function scryptCostOk(N: number, r: number, p: number): boolean {
  const isPowerOfTwo = Number.isInteger(N) && N >= 2 && (N & (N - 1)) === 0;
  return isPowerOfTwo && Number.isInteger(r) && r >= 1 && Number.isInteger(p) && p >= 1 && p <= SCRYPT_P_MAX && 128 * N * r < SCRYPT_MAXMEM;
}

async function writeAt(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < data.length) {
    const { bytesWritten } = await handle.write(data, done, data.length - done, position + done);
    done += bytesWritten;
  }
}

/** Up to `length` bytes from `position`: fewer at the end of the file. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await handle.read(buffer, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === length ? buffer : buffer.subarray(0, got);
}

function u64(buffer: Buffer, offset: number): number | undefined {
  const value = buffer.readBigUInt64BE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function differences(a: Buffer, b: Buffer): number {
  let count = 0;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) count++;
  return count;
}

function hexOf(value: unknown): Buffer | undefined {
  return typeof value === "string" && /^(?:[0-9a-f]{2})+$/.test(value) ? Buffer.from(value, "hex") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** A decompressor's complaint is damage; anything else (the disk, a closed file) stays what it is. */
function fromStream(err: unknown): unknown {
  if (err instanceof BundleError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (code.startsWith("Z_") || code.startsWith("ZSTD_") || code === "ERR_BUFFER_TOO_LARGE")) {
    return damaged(`its data does not decompress (${asError(err).message})`);
  }
  return err;
}

function damaged(why: string): BundleError {
  return new BundleError("corrupt", `This backup is damaged: ${why}.`);
}

function cutShort(): BundleError {
  return new BundleError("truncated", "This backup is incomplete: the file ends before the backup does.");
}

/** A sealed file whose last segment does not open: cut short or changed, one answer for both. */
function damagedOrCut(): BundleError {
  return new BundleError("truncated", "The backup file is damaged or incomplete.");
}

function later(): BundleError {
  return new BundleError("unsupported", "This backup was made by a later version of Lookout.");
}

function unknownFormat(): BundleError {
  return new BundleError("unsupported", "This backup uses a format this version of Lookout cannot read.");
}
