import { PolledJson } from "../../polledJson";
import type { ClaudeDir } from "./paths";

/** Who a config directory is signed in as: `oauthAccount` in Claude Code's config file. */
export interface AccountInfo {
  /** The account's id: two directories with the same one are signed in to one account. */
  uuid: string;
  email?: string;
  displayName?: string;
  organizationName?: string;
  organizationUuid?: string;
  billingType?: string;
  seatTier?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The signed-in account in a parsed config file; none without an account id. */
export function parseAccount(config: unknown): AccountInfo | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const account = (config as { oauthAccount?: unknown }).oauthAccount;
  if (typeof account !== "object" || account === null) return undefined;
  const o = account as Record<string, unknown>;
  const uuid = text(o.accountUuid);
  if (uuid === undefined) return undefined;
  const info: AccountInfo = { uuid };
  const fields = {
    email: o.emailAddress,
    displayName: o.displayName,
    organizationName: o.organizationName,
    organizationUuid: o.organizationUuid,
    billingType: o.billingType,
    seatTier: o.seatTier,
  } as const;
  for (const [key, value] of Object.entries(fields) as [keyof typeof fields, unknown][]) {
    const v = text(value);
    if (v !== undefined) info[key] = v;
  }
  return info;
}

/** The account a config directory is signed in to, read from its config file each time the file changes. */
export type AccountFile = PolledJson<AccountInfo | undefined>;

/** Claude Code replaces its config file by rename, so it is polled; a torn write keeps the last account for a moment. */
export function accountFile(file: string): AccountFile {
  return new PolledJson(file, parseAccount, undefined, undefined);
}

/**
 * What the log says of the directories watched, when there are several: each
 * by label and path, then those with no sign-in and those that share one.
 * Never an e-mail or an id.
 */
export function describeDirs(dirs: readonly ClaudeDir[], accounts: readonly (AccountInfo | undefined)[]): string[] {
  if (dirs.length < 2) return [];
  const lines = [`Watching Claude Code in ${dirs.length} directories: ${dirs.map((dir) => `${dir.label} (${dir.dir})`).join(", ")}`];
  const firstWith = new Map<string, string>();
  dirs.forEach((dir, i) => {
    const account = accounts[i];
    if (account === undefined) {
      lines.push(`Claude Code directory ${dir.label} has no sign-in yet`);
      return;
    }
    const first = firstWith.get(account.uuid);
    if (first === undefined) firstWith.set(account.uuid, dir.label);
    else lines.push(`Claude Code directories ${first} and ${dir.label} are signed in to the same account`);
  });
  return lines;
}
