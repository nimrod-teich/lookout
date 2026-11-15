import * as crypto from "node:crypto";
import * as fs from "node:fs";

/** Rewrites a backup's header JSON the way the writer writes it, checksum and length included. */
export function rewriteHeader(file: string, edit: (fields: Record<string, unknown>) => void): void {
  const bytes = fs.readFileSync(file);
  const length = bytes.readUInt32BE(8);
  const fields = JSON.parse(bytes.subarray(12, 12 + length).toString("utf8")) as Record<string, unknown>;
  delete fields.sum;
  edit(fields);
  const body = JSON.stringify(fields);
  const json = Buffer.from(`${body.slice(0, -1)},"sum":"${crypto.createHash("sha256").update(body).digest("hex")}"}`);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, 8), size, json, bytes.subarray(12 + length)]));
}
