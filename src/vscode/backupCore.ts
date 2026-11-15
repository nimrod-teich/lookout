// What the backup page calls: the inventory of what there is to back up,
// the files a choice takes, the file's estimated size, and the write.
import { backUp, type BackUpOptions, type BackUpResult } from "../core/transfer/backup";
import { zstdAvailable } from "../core/transfer/bundle";
import { estimate, select, takeInventory, type Inventory, type InventoryItem, type InventorySources, type Selection } from "../core/transfer/inventory";
import type { Codec } from "../core/transfer/types";

export type { BackUpOptions, BackUpResult, Inventory, InventoryItem, InventorySources, Selection };

export interface BackupCore {
  takeInventory(sources: InventorySources): Promise<Inventory>;
  select(inventory: Inventory, selection: Selection): InventoryItem[];
  /** Bytes. */
  estimate(items: readonly InventoryItem[], codec: Codec, level: number): number;
  backUp(
    file: string,
    inventory: Inventory,
    selection: Selection,
    options: BackUpOptions,
    progress?: (doneBytes: number, totalBytes: number) => void,
    signal?: AbortSignal,
  ): Promise<BackUpResult>;
  zstdAvailable(): boolean;
}

export const transferCore: BackupCore = { takeInventory, select, estimate, backUp, zstdAvailable };
