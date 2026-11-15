// The backup file's reader, as the restore command opens a file with it:
// the one place the restore names it, so another reader (a test's) can
// stand in for it.
import { openBundle, readBundleHeader } from "./bundle";
import type { BundleHeader, BundleSource } from "./types";

export interface BundleReader {
  /** What the file says about itself in the clear: enough to ask for its passphrase. */
  readBundleHeader(file: string): Promise<BundleHeader>;
  /** The file opened for reading, with its passphrase when it is encrypted. */
  openBundle(file: string, passphrase?: string): Promise<BundleSource>;
}

/** The reader the restore command uses. */
export const bundleReader: BundleReader = { readBundleHeader, openBundle };
