import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { loadSqlite } from "../../../src/core/sqlite";
import { ConversationStore } from "../../../src/core/store";
import type { BundleFile, BundleHeader, BundleManifest, BundleSource, ManifestBody, NewFile } from "../../../src/core/transfer/types";

/** One file of a made-up backup: its entry, and its bytes. A `sha256` or `size` given stands in for the real one, as a damaged file's would. */
export interface FakeFile {
  entry: NewFile & { sha256?: string; size?: number };
  bytes: Buffer | string;
}

export function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export interface FakeSource extends BundleSource {
  /** The files handed to `visit`, by path, in order, over every pass. */
  visits: string[];
  closed: boolean;
}

/** A backup as the reader hands it over, made up in memory: the manifest, and a pass through the payload in small chunks. */
export function fakeBundle(body: ManifestBody, files: readonly FakeFile[], header: Partial<BundleHeader> = {}): FakeSource {
  let offset = 0;
  const payload = files.map(({ entry, bytes }) => {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const full: BundleFile = { ...entry, size: entry.size ?? buf.length, sha256: entry.sha256 ?? sha256(buf), offset };
    offset += buf.length;
    return { entry: full, bytes: buf };
  });
  const manifest: BundleManifest = { ...body, files: payload.map((p) => p.entry) };
  const source: FakeSource = {
    header: { format: 1, cipher: "none", codec: "zstd", createdAt: body.createdAt, host: body.source.host, ...header },
    manifest,
    visits: [],
    closed: false,
    async forEachFile(visit, want) {
      for (const { entry, bytes } of payload) {
        // The reader hands over its own copy of each entry.
        const copy = { ...entry };
        if (want && !want(copy)) continue;
        source.visits.push(entry.rel);
        const chunks: Buffer[] = [];
        for (let i = 0; i < bytes.length; i += 4096) chunks.push(bytes.subarray(i, i + 4096));
        const data = Readable.from(chunks, { objectMode: false });
        await visit(copy, data);
        if (!data.readableEnded && !data.destroyed) throw new Error(`visit left ${entry.rel} unread`);
      }
    },
    async close() {
      source.closed = true;
    },
  };
  return source;
}

/** A conversation the history database holds. */
export interface HistoryRow {
  id: string;
  agent: string;
  file: string;
  cwd: string;
  purgedAt?: number;
  messages: string[];
  paths?: string[];
  tools?: string[];
}

/**
 * A history database as a backup carries one: made with this version's
 * schema, the rows written, then copied whole the way a backup snapshots it
 * (`VACUUM INTO`). `alter` changes the schema first, as another version's.
 * `craft` runs on the copy itself afterwards, as the maker of a crafted file
 * would: with `PRAGMA writable_schema` it rewrites the schema as no
 * `CREATE` statement could.
 */
export function historyBytes(dir: string, rows: readonly HistoryRow[], alter?: string, craft?: string): Buffer {
  const live = path.join(dir, `made-${crypto.randomBytes(4).toString("hex")}.sqlite`);
  ConversationStore.open(live)!.close();
  const { DatabaseSync } = loadSqlite()!;
  const db = new DatabaseSync(live);
  if (alter) db.exec(alter);
  const columns = (db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map((c) => c.name);
  const tools = columns.includes("tools");
  const file = db.prepare(`INSERT INTO files(file, reader, identity, end, tail, messages, build${tools ? ", tools" : ""}) VALUES (?, 'claude-transcript', 'ident', 100, NULL, ?, 'build-1'${tools ? ", 1" : ""})`);
  const message = db.prepare("INSERT INTO messages(file, idx, role, at, text) VALUES (?, ?, ?, ?, ?)");
  const pathRow = db.prepare("INSERT INTO paths(file, path) VALUES (?, ?)");
  const tool = db.prepare("INSERT INTO tools(file, near, at, name, text) VALUES (?, 0, NULL, 'Bash', ?)");
  const session = db.prepare("INSERT INTO sessions(id, agent, file, title, cwd, branch, modified_at, purged_at) VALUES (?, ?, ?, ?, ?, NULL, 5000, ?)");
  db.exec("BEGIN");
  for (const row of rows) {
    file.run(row.file, row.messages.length);
    row.messages.forEach((text, i) => message.run(row.file, i, i % 2 ? "agent" : "you", 1_000 + i, text));
    for (const p of row.paths ?? []) pathRow.run(row.file, p);
    for (const t of row.tools ?? []) tool.run(row.file, t);
    session.run(row.id, row.agent, row.file, `Session ${row.id.slice(-4)}`, row.cwd, row.purgedAt ?? null);
  }
  db.exec("COMMIT");
  const snapshot = path.join(dir, `snapshot-${crypto.randomBytes(4).toString("hex")}.sqlite`);
  db.prepare("VACUUM INTO ?").run(snapshot);
  db.close();
  if (craft) {
    const crafted = new DatabaseSync(snapshot);
    crafted.exec(craft);
    crafted.close();
  }
  const bytes = fs.readFileSync(snapshot);
  fs.rmSync(snapshot);
  return bytes;
}
