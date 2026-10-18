import type { SearchResult } from "../core/history";
import type { PastView, SessionView } from "../core/types";
import type { UsageMeter } from "../core/usage";

/** One agent's usage on the board. */
export interface BoardUsage {
  /** Id of the agent; none from an extension that showed only Claude's, the first agent of the catalog. */
  agent?: string;
  /** Epoch ms the numbers were fetched; none when there are no numbers to show. */
  fetchedAt?: number;
  /** Old, and nothing will bring them up to date. */
  stale: boolean;
  meters: UsageMeter[];
  /** The extension can fetch fresh numbers. */
  canRefresh: boolean;
}

/** Which earlier sessions are listed and searched: this window's folders, or every project. */
export type EarlierScope = "folders" | "all";

/** The earlier sessions' scope, the most listed, and whether older ones were left out. */
export interface EarlierInfo {
  scope: EarlierScope;
  limit: number;
  capped: boolean;
}

/** The sessions the user starred, newest star first, and those of them that are not running, wherever they ran. */
export interface Favourites {
  ids: string[];
  past: PastView[];
}

/** Extension → webview. */
export type ToBoard =
  | {
      type: "sessions";
      sessions: SessionView[];
      past: PastView[];
      now: number;
      /** One agent's usage, or each agent's. */
      usage?: BoardUsage | BoardUsage[];
      /** The agent whose bar the status bar shows; the tide follows it. */
      usageBar?: string;
      /** Tell the agents apart: hue, silhouette, name. */
      markers?: boolean;
      earlier?: EarlierInfo;
      favourites?: Favourites;
    }
  /** `pending` sessions were not read yet; the board asks again. */
  | { type: "search"; query: string; results: SearchResult[]; pending: number };

/** Webview → extension. */
export type FromBoard =
  | { type: "ready" }
  | { type: "jump"; id: string }
  | { type: "rename"; id: string }
  | { type: "seen"; id: string }
  /** Dismiss the question the session's last message asks. */
  | { type: "dismiss"; id: string }
  | { type: "seenAll" }
  /** Fetch an agent's usage again; Claude's when none is named. */
  | { type: "refreshUsage"; agent?: string }
  /** `zone`: the board's time zone, as `Date.getTimezoneOffset` gives it: in a remote window the extension's clock can be in another. */
  | { type: "search"; query: string; zone?: number }
  /** Open the session's conversation in the findings tab, at one message or at the newest match. */
  | { type: "openHit"; query: string; id: string; index?: number }
  /** Open the search page with this query. */
  /** `hide`: the agents hidden in the legend, left out there too. */
  | { type: "openSearch"; query: string; hide?: string[] }
  /** Resume a session that is not running, in the agent's panel. */
  | { type: "resume"; id: string }
  /** List and search the earlier sessions of this window's folders, or of every project. */
  | { type: "earlierScope"; scope: EarlierScope }
  /** Star a session, or take its star away. */
  | { type: "favourite"; id: string };
