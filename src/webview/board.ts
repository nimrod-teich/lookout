/// <reference lib="dom" />
import { AGENTS, agentInfo, canJump, canRename, canResume, unreachable } from "../core/agents/catalog";
import { describeEvidence, describeReason, formatElapsed, formatResetIn, formatTokens, formatUsd, quietFor, shortModel } from "../core/format";
import type { SearchResult } from "../core/history";
import { GROUPINGS, sectionsBy, type GroupBy, type Section } from "../core/grouping";
import { DEFAULT_SORT, dragInto, orderViews, SORTS, type SessionSort, type SortKey } from "../core/sorting";
import type { PastView, SessionView } from "../core/types";
import { barMeter, chosenGroup, groupHeading, pickBar, sortGroups, tabMeters } from "../core/usageGroups";
import { agentGlyph } from "./glyph";
import { Harbour } from "./harbour";
import { cardLine, contextLevel, contextPercent, groupSessions, hostChip, isFoldKey, isGroupKey, pageOf, pulseBars, secondLine, type Chip, type FoldKey, type GroupKey } from "./model";
import type { BoardUsage, EarlierInfo, EarlierScope, Favourites, FromBoard, ToBoard } from "./protocol";

interface BoardState {
  hidden?: string[];
  /** Favourites and the state groups the user folded to their heading. */
  folded?: string[];
  earlier?: boolean;
  /** The user opened the Parked group. */
  parked?: boolean;
  /** The user opened the Archived group. */
  archive?: boolean;
  /** The user opened the Purged group. */
  purged?: boolean;
  /** Agents the user hid through the legend. */
  agents?: string[];
  /** The agent whose usage tab the user picked. */
  usageTab?: string;
}

declare function acquireVsCodeApi(): {
  postMessage(message: FromBoard): void;
  getState(): BoardState | undefined;
  setState(state: BoardState): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

/** Every session the extension sent. */
let allSessions: SessionView[] = [];
/** The sessions after the legend filters. */
let sessions: SessionView[] = [];
/** State groups the user hid through the legend; kept across reloads. */
const hidden = new Set<GroupKey>((vscode.getState()?.hidden ?? []).filter(isGroupKey));
/** Favourites and the state groups the user folded to their heading; kept across reloads. */
const folded = new Set<FoldKey>((vscode.getState()?.folded ?? []).filter(isFoldKey));
/** Agents the user hid through the legend; kept across reloads, applied while the markers show. */
const hiddenAgents = new Set<string>((vscode.getState()?.agents ?? []).filter((id) => typeof id === "string"));
/** Each agent's usage, in catalog order; empty when there is none to show. */
let usageGroups: BoardUsage[] = [];
/** The agent whose bar the status bar shows: the tide follows it. */
let usageBar: string | undefined;
/** Tell the agents apart: their hue and silhouette, their name in hovers. */
let markers = false;
/** How many agents Lookout watches; unknown from an extension that does not say. */
let watching: number | undefined;
/** The search the user typed, trimmed; empty when the box is empty. */
let query = "";
/** The results for `query`, by session id; sessions absent here are hidden while a query is active. */
let hits = new Map<string, SearchResult>();
/** Sessions whose conversation the extension has not read yet for the current query. */
let pending = 0;
/** The sessions that are not running, newest first. */
let past: PastView[] = [];
/** Which earlier sessions are listed, the most listed, and whether older ones were left out. */
let earlier: EarlierInfo = { scope: "folders", limit: 500, capped: false };
/** The sessions the user starred, newest star first. */
let favourites: Favourites = { ids: [], past: [] };
/** How the sessions are ordered inside each group, as the extension keeps it. */
let sort: SessionSort = DEFAULT_SORT;
/** How the board makes its sections, as the extension keeps it. */
let groupBy: GroupBy = "state";
let favouritesEl: HTMLElement | undefined;
const favouriteCards = new Map<string, HTMLElement>();

const STAR_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.7l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

/** A page with lines: the note the user wrote on a session. */
const NOTE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5.5L13 6v7a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 2.5V6H13M6 8.6h4M6 11h2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

/** The star that marks a favourite; a click stars the session or takes its star away. */
function starButton(id: string): HTMLElement {
  const star = el("span", "star");
  star.innerHTML = STAR_ICON;
  star.setAttribute("role", "button");
  star.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "favourite", id });
  });
  return star;
}

function setStar(card: HTMLElement, id: string): void {
  const star = card.querySelector(".star");
  if (!star) return;
  const on = favourites.ids.includes(id);
  star.classList.toggle("on", on);
  (star as HTMLElement).title = on ? "Take the star away" : "Star this session: it stays under Favourites";
}
/** The user opened the Earlier group; kept across reloads. */
let earlierOpen = vscode.getState()?.earlier === true;
/** The user opened the Parked group, folded until then; kept across reloads. */
let parkedOpen = vscode.getState()?.parked === true;
/** Earlier sessions on one page. */
const PAGE_SIZE = 20;
/** The page of earlier sessions shown, from 0: the newest first. Back to the first when the search or the scope changes. */
let earlierPage = 0;
/** The sessions archived in Lookout that are not running, newest archive first. */
let archivePast: PastView[] = [];
/** The user opened the Archived group; kept across reloads. */
let archiveOpen = vscode.getState()?.archive === true;
/** The agent whose usage tab the user picked last. */
let usageTab: string | undefined = vscode.getState()?.usageTab;
let archivePage = 0;
let archiveEl: HTMLElement | undefined;
const archiveCards = new Map<string, HTMLElement>();
/** The sessions whose transcript the agent deleted, their conversations kept by Lookout, last written first. */
let purgedPast: PastView[] = [];
/** The user opened the Purged group; kept across reloads. */
let purgedOpen = vscode.getState()?.purged === true;
let purgedPage = 0;
let purgedEl: HTMLElement | undefined;
const purgedCards = new Map<string, HTMLElement>();

function saveState(): void {
  vscode.setState({ hidden: [...hidden], folded: [...folded], earlier: earlierOpen, parked: parkedOpen, archive: archiveOpen, purged: purgedOpen, agents: [...hiddenAgents], usageTab });
}

/** On a section by attribute: a dot and a count per state it holds, in the legend's colours. */
function setSummary(summary: HTMLElement, counts: Section["summary"]): void {
  const parts = (["waiting", "done", "working", "idle", "unknown"] as const).filter((state) => counts?.[state]).map((state) => `${state}:${counts![state]}`);
  if (summary.dataset.parts === parts.join(" ")) return;
  summary.dataset.parts = parts.join(" ");
  summary.textContent = "";
  for (const state of ["waiting", "done", "working", "idle", "unknown"] as const) {
    const count = counts?.[state];
    if (!count) continue;
    const item = el("span", `sum state-${state === "unknown" ? "idle" : state}`);
    item.title = `${count} ${{ waiting: "need you", done: "finished", working: "working", idle: "idle", unknown: "state unknown" }[state]}`;
    item.append(el("i", "swatch"), el("b", "", String(count)));
    summary.append(item);
  }
}

/** A click on the heading folds the group to it, or unfolds it; Parked starts folded. */
function foldOnClick(heading: HTMLElement, key: FoldKey): void {
  heading.title =
    key === "parked"
      ? "Running sessions out of the way: you parked them, or they rested longer than lookout.parkAfterHours. Each comes back when it works again. Click to show or hide them."
      : "Click to fold or unfold the group";
  heading.addEventListener("click", () => {
    if (key === "parked") parkedOpen = !parkedOpen;
    else if (folded.has(key)) folded.delete(key);
    else folded.add(key);
    saveState();
    render();
  });
}

/** Opens or folds a group's cards; a search unfolds every group while it runs, so its matches show. */
function showFold(section: HTMLElement, key: FoldKey): void {
  const open = (key === "parked" ? parkedOpen : !folded.has(key)) || query !== "";
  section.classList.toggle("open", open);
  section.querySelector(".cards")!.classList.toggle("hidden", !open);
}
const pastCards = new Map<string, HTMLElement>();
let earlierEl: HTMLElement | undefined;
/** The extension's clock minus ours, so elapsed times agree with the status bar. */
let clockOffset = 0;

const cards = new Map<string, HTMLElement>();
const groupsEl = new Map<string, HTMLElement>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function now(): number {
  return Date.now() + clockOffset;
}

function elapsedText(view: SessionView): string {
  if (view.since === undefined) return "";
  const elapsed = formatElapsed(now() - view.since);
  return view.state === "done" ? `${elapsed} ago` : elapsed;
}

function stateTitle(view: SessionView): string {
  switch (view.state) {
    case "waiting":
      return "Needs you";
    case "done":
      return "Finished";
    case "working":
      return "Working";
    case "idle":
      return "Idle";
    case "unknown":
      return "State unknown";
  }
}

function chips(view: SessionView): Chip[] {
  const out: Chip[] = [{ text: view.worktree ? `${view.project} · ${view.worktree}` : view.project }];
  const where = hostChip(view);
  if (where) out.push({ text: where });
  if (view.branch) out.push(branchChip(view.branch));
  if (view.model) out.push({ text: view.effort ? `${shortModel(view.model)} · ${view.effort}` : shortModel(view.model), title: view.effort ? `Model and reasoning effort of its last reply` : undefined });
  // The ring shows the context when the window is known; the chip covers the rest.
  if (view.contextTokens && !view.contextWindow) out.push({ text: `${formatTokens(view.contextTokens)} tokens` });
  if (view.agents > 0) out.push({ text: view.agents === 1 ? "1 agent" : `${view.agents} agents` });
  if (view.kept) out.push(keptChip());
  return out;
}

/** Lookout keeps a copy of the session's transcript. */
function keptChip(): Chip {
  return { text: "kept", title: "Lookout keeps a copy of this session's transcript, under its own storage, so the agent's deletion of it takes nothing. The card's menu stops the keeping, or puts the transcript back once the agent deleted it.", kind: "kept" };
}

/** The git branch a session works on. */
function branchChip(branch: string): Chip {
  return { text: `⎇ ${branch}`, title: `Git branch: ${branch}`, kind: "branch" };
}

/** Text, hover and look of a chip, written only when they change. */
function setChip(chip: HTMLElement, value: Chip): void {
  if (chip.textContent !== value.text) chip.textContent = value.text;
  const className = value.kind ? `chip ${value.kind}` : "chip";
  if (chip.className !== className) chip.className = className;
  if (chip.title !== (value.title ?? "")) chip.title = value.title ?? "";
}

// The harbour: the lighthouse, its beam, and the sessions as boats.

const beam = el("div", "beam");
const hover = el("div", "hover-card");
const harbour = new Harbour(
  (id) => vscode.postMessage({ type: "jump", id }),
  (boat) => showHover(boat?.id),
  // The agent may not let Lookout bring the session forward: nothing to swing the beam to.
  (id) => {
    const view = allSessions.find((s) => s.id === id);
    return view === undefined || canJump(view);
  },
);
beam.append(harbour.element, hover);

/** The card the pointer links to, highlighted while a boat is hovered. */
let linkedCard: HTMLElement | undefined;

/** A card over the scene for the boat under the pointer, with a caret pointing at the boat. */
function showHover(id: string | undefined): void {
  const view = id === undefined ? undefined : sessions.find((s) => s.id === id);
  linkedCard?.classList.remove("linked");
  linkedCard = undefined;
  if (!view) {
    hover.classList.remove("shown");
    return;
  }
  linkedCard = cards.get(view.id);
  linkedCard?.classList.add("linked");
  hover.textContent = "";
  hover.className = `hover-card tone-${view.state}`;
  const heading = el("div", "hover-title", view.title);
  if (markers) heading.prepend(agentGlyph(view.agent, 11));
  hover.append(heading);
  const status = el("div", "hover-status");
  const elapsed = elapsedText(view);
  status.append(el("i", "dot"), el("span", "", `${stateTitle(view)}${elapsed ? ` · ${elapsed}` : ""}`));
  hover.append(status);
  const second = secondLine(view, now());
  // An unknown state's line is the evidence's own note; it is said once, below.
  if (second && view.state !== "unknown") hover.append(el("div", "hover-line", second));
  const evidence = describeEvidence(view.evidence, now());
  if (evidence) hover.append(el("div", "hover-evidence", evidence));
  const meta = chips(view).map((chip) => chip.text);
  if (markers) meta.unshift(agentInfo(view.agent).label);
  if (view.spend) {
    const tokens = view.spend.input + view.spend.output + view.spend.cacheRead + view.spend.cacheWrite;
    meta.push(`${formatTokens(tokens)} tokens${typeof view.spend.costUsd !== "number" ? "" : ` · ${view.spend.estimated ? "~" : ""}${formatUsd(view.spend.costUsd)}`}`);
  }
  hover.append(el("div", "hover-meta", meta.join(" · ")));
  if (canJump(view)) hover.append(el("div", "hover-hint", unreachable(view) ? "Click to read its conversation" : "Click to jump"));
  const boat = harbour.boatFor(view.id);
  if (!boat) return;
  const { x, y, width } = harbour.position(boat);
  const cardWidth = Math.min(236, width - 16);
  const left = Math.max(8, Math.min(width - cardWidth - 8, x - cardWidth / 2));
  hover.style.width = `${cardWidth}px`;
  hover.style.left = `${left}px`;
  hover.style.setProperty("--caret", `${Math.round(x - left)}px`);
  // Above the boat when the card fits there, else below it; the caret always points at the boat.
  const height = hover.offsetHeight;
  const above = y - 14 - height >= 4;
  hover.classList.toggle("below", !above);
  hover.style.top = `${above ? y - 14 - height : y + 14}px`;
  // Two frames apart, so the transition runs from the hidden state.
  requestAnimationFrame(() => hover.classList.add("shown"));
}
const legend = el("div", "legend");
beam.append(legend);

// The search box: looks through what the user and the agent said in every live session.

const search = el("div", "search");
const field = el("label", "field");
field.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 10l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const input = el("input", "");
input.type = "search";
input.placeholder = "Search the conversations";
input.title = "Every word must appear in one message, or in the session's note. Narrow it with since:3d, before:yesterday, since:2026-10-01, project:api, branch:fix-login, file:src/app.ts; has:note lists the sessions with a note";
input.setAttribute("aria-label", "Search the conversations");
input.spellcheck = false;
field.append(input);
const clear = el("button", "clear", "×");
clear.type = "button";
clear.title = "Clear the search";
// How much the search found; a click reads it all on the search page.
const summary = el("button", "summary");
summary.type = "button";
summary.title = "Open every match on the search page";
summary.addEventListener("click", () => {
  // The page leaves out the agents hidden here, and says so.
  const hide = markers && hiddenAgents.size ? [...hiddenAgents] : undefined;
  if (query !== "") vscode.postMessage(hide ? { type: "openSearch", query, hide } : { type: "openSearch", query });
});

// A chip that names a choice, with a small menu to change it: the board's
// own, in its own style, so the choice is always in view. The chip says what
// it chooses ("Group by:", "Sort by:") and what is chosen.

interface PickerOption<K extends string> {
  key: K;
  label: string;
  /** What the chip says. */
  short: string;
  detail: string;
}

/** Room left between an open menu and the edges of the board. */
const MENU_MARGIN = 6;

function picker<K extends string>(prefix: string, heading: string, title: string, options: readonly PickerOption<K>[], pick: (key: K) => void): { element: HTMLElement; set(key: K): void } {
  const wrap = el("span", "picker");
  const chip = el("button", "chip-button");
  chip.type = "button";
  chip.title = title;
  chip.setAttribute("aria-haspopup", "menu");
  chip.setAttribute("aria-expanded", "false");
  const label = el("span", "label");
  chip.append(el("span", "prefix", prefix), label, el("span", "caret", "▾"));
  const menu = el("div", "menu hidden");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", heading);
  const list = el("div", "menu-items");
  // What the option under the pointer, or in focus, does; the chosen one's otherwise.
  const hint = el("div", "menu-hint");
  menu.append(el("div", "menu-heading", heading), list, hint);
  let current = options[0]!.key;
  const items = new Map<K, HTMLButtonElement>();
  const describe = (key: K) => (hint.textContent = options.find((option) => option.key === key)?.detail ?? "");
  const away = (event: Event) => {
    if (!wrap.contains(event.target as Node)) close();
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close();
      chip.focus();
      return;
    }
    // Tab leaves the menu as it would any other control, and the menu closes behind it.
    if (event.key === "Tab") {
      close();
      return;
    }
    const all = [...items.values()];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    all[(next + all.length) % all.length]?.focus();
  };
  // The board scrolled or resized under the menu: the chip moved, so the menu goes.
  const moved = (event: Event) => {
    if (!(event.target instanceof Node && menu.contains(event.target))) close();
  };
  /** Under the chip, or over it when there is more room there; inside the board's edges, scrolling within itself only when the board is too short for it. */
  const place = () => {
    const at = chip.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    menu.style.maxHeight = "";
    menu.style.left = `${Math.max(MENU_MARGIN, Math.min(at.right - menu.offsetWidth, width - menu.offsetWidth - MENU_MARGIN))}px`;
    const below = height - at.bottom - 4 - MENU_MARGIN;
    const above = at.top - 4 - MENU_MARGIN;
    const tall = menu.offsetHeight;
    if (tall <= below || below >= above) {
      menu.style.top = `${at.bottom + 4}px`;
      menu.style.maxHeight = `${Math.max(below, 80)}px`;
    } else {
      menu.style.top = `${Math.max(MENU_MARGIN, at.top - 4 - tall)}px`;
      menu.style.maxHeight = `${above}px`;
    }
  };
  const open = () => {
    menu.classList.remove("hidden");
    chip.setAttribute("aria-expanded", "true");
    describe(current);
    place();
    const chosen = items.get(current);
    // Into view within the menu, never by scrolling the board.
    chosen?.focus({ preventScroll: true });
    if (chosen && (chosen.offsetTop < list.scrollTop || chosen.offsetTop + chosen.offsetHeight > list.scrollTop + list.clientHeight)) list.scrollTop = chosen.offsetTop - list.clientHeight / 2;
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", keys, true);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
  };
  const close = () => {
    menu.classList.add("hidden");
    chip.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", away, true);
    document.removeEventListener("keydown", keys, true);
    document.removeEventListener("scroll", moved, true);
    window.removeEventListener("resize", moved);
  };
  for (const option of options) {
    const item = el("button", "item");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-description", option.detail);
    item.append(el("span", "mark", "✓"), el("span", "name", option.label));
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      close();
      if (option.key !== current) pick(option.key);
    });
    item.addEventListener("pointerenter", () => describe(option.key));
    item.addEventListener("focus", () => describe(option.key));
    items.set(option.key, item);
    list.append(item);
  }
  list.addEventListener("pointerleave", () => {
    if (!list.contains(document.activeElement)) describe(current);
  });
  chip.addEventListener("click", () => (menu.classList.contains("hidden") ? open() : close()));
  wrap.append(chip, menu);
  const set = (key: K) => {
    current = key;
    label.textContent = options.find((option) => option.key === key)?.short ?? "";
    for (const [other, item] of items) item.setAttribute("aria-checked", String(other === key));
  };
  set(current);
  return { element: wrap, set };
}

/** The order inside each group, as a chip at the end of the search row; a pick goes to the extension, which keeps it for every window. */
const sortPicker = picker<SortKey>("Sort by:", "Sort the sessions in each group by", "How the sessions are ordered inside each group", SORTS, (by) => {
  // Your order starts from the one on screen, the first time it is picked.
  if (by === "custom" && sort.order.length === 0) {
    sort = { by, order: sessions.map((view) => view.id) };
    vscode.postMessage({ type: "order", ids: sort.order });
  } else {
    sort = { ...sort, by };
    vscode.postMessage({ type: "sort", by });
  }
  applyFilters();
  render();
});
/** What the sections are made by, as a chip beside the sort; a pick goes to the extension, which keeps it for every window. */
const groupPicker = picker<GroupBy>("Group by:", "Group the sessions by", "How the board makes its sections: by state, or by what the sessions share", GROUPINGS, (by) => {
  groupBy = by;
  vscode.postMessage({ type: "group", by });
  render();
});
// A toggle beside the pickers: only the sessions with a note, through the search's has:note.
const HAS_NOTE = /(^|\s)has:note(?=\s|$)/i;
const notesChip = el("button", "chip-button toggle notes");
notesChip.type = "button";
notesChip.title = "Only the sessions with a note, wherever they ran: has:note in the search box";
notesChip.setAttribute("aria-pressed", "false");
notesChip.innerHTML = NOTE_ICON;
notesChip.append(el("span", "label", "Notes"));
notesChip.addEventListener("click", () => {
  const current = input.value;
  input.value = HAS_NOTE.test(current) ? current.replace(HAS_NOTE, " ").replace(/\s+/g, " ").trim() : `has:note ${current.trim()}`.trim();
  if (searchTimer) clearTimeout(searchTimer);
  runSearch();
});
/** The chip is lit while the query asks for the noted sessions, typed or clicked. */
function setNotesChip(): void {
  const on = HAS_NOTE.test(query);
  notesChip.classList.toggle("on", on);
  notesChip.setAttribute("aria-pressed", String(on));
}
// The chips move together: beside the field, or under it on a narrow board.
const pickers = el("span", "pickers");
pickers.append(groupPicker.element, sortPicker.element, notesChip);
search.append(field, clear, summary, pickers);
beam.append(search);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** A search starts this long after the last keystroke: answering one takes milliseconds. */
const TYPING_PAUSE_MS = 100;

/** Asks for the current query's results; the days it names go by this board's time zone. */
function askSearch(): void {
  vscode.postMessage({ type: "search", query, zone: new Date().getTimezoneOffset() });
}

function runSearch(): void {
  const next = input.value.trim();
  if (next === query && next !== "") {
    askSearch();
    return;
  }
  query = next;
  setNotesChip();
  hits = new Map();
  earlierPage = 0;
  archivePage = 0;
  search.classList.toggle("active", query !== "");
  if (query === "") {
    // The extension stops sending this search again as it reads more.
    vscode.postMessage({ type: "search", query: "" });
    search.classList.remove("searching");
    summary.textContent = "";
    applyFilters();
    render();
    return;
  }
  search.classList.add("searching");
  askSearch();
}

input.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, TYPING_PAUSE_MS);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    input.value = "";
    runSearch();
  } else if (event.key === "Enter") {
    if (searchTimer) clearTimeout(searchTimer);
    runSearch();
  }
});
clear.addEventListener("click", () => {
  input.value = "";
  runSearch();
  input.focus();
});

function receiveSearch(message: { query: string; results: SearchResult[]; pending: number; follows?: boolean }): void {
  // An answer to an older query is of no use.
  if (message.query !== query) return;
  hits = new Map(message.results.map((result) => [result.id, result]));
  results = message.results;
  pending = message.pending;
  search.classList.toggle("searching", pending > 0);
  summarise();
  applyFilters();
  render();
  // Conversations not read within the time given: ask again shortly, until none is left. The extension sends them itself when it follows.
  if (pending > 0 && !message.follows) {
    setTimeout(() => {
      if (query === message.query) askSearch();
    }, 400);
  }
}

/** The search's results, as last received. */
let results: SearchResult[] = [];

/** The agent of a session the board holds, running or not. */
function agentOfId(id: string): string | undefined {
  return (allSessions.find((view) => view.id === id) ?? past.find((view) => view.id === id) ?? favourites.past.find((view) => view.id === id) ?? archivePast.find((view) => view.id === id) ?? purgedPast.find((view) => view.id === id))?.agent;
}

/** How much the search found, among the sessions the board holds and the agents shown: a session the board has no card for, and those hidden in the legend, are left out of the count as of the cards. */
function summarise(): void {
  const shown = results.filter((result) => {
    const agent = agentOfId(result.id);
    return agent !== undefined && agentShown(agent);
  });
  const matches = shown.reduce((sum, result) => sum + result.count, 0);
  const picked = `${shown.length} ${shown.length === 1 ? "session" : "sessions"}`;
  // Operators alone pick sessions without words to match.
  const found = shown.length === 0 ? "no matches" : matches === 0 ? picked : `${matches} ${matches === 1 ? "match" : "matches"} in ${picked}`;
  summary.textContent = pending > 0 ? `${found} · reading ${pending} more…` : found;
}

/** The agent's chip in the legend is on: its sessions and usage show. Without markers there are no chips, and every agent shows. */
function agentShown(agent: string | undefined): boolean {
  return !markers || !hiddenAgents.has(agent ?? AGENTS[0]!.id);
}

function applyFilters(): void {
  sessions = orderViews(
    allSessions.filter((view) => !hidden.has(groupSessions([view])[0]!.key) && agentShown(view.agent) && (query === "" || hits.has(view.id))),
    sort,
  );
}

// Dragging a card: inside its own group only, since a group is a state. A
// drop puts the board in the user's own order, starting from the one shown.

/** The card being dragged, and the list it may be dropped in. */
let dragging: { id: string; list: HTMLElement } | undefined;

function cardsIn(list: HTMLElement): HTMLElement[] {
  return [...list.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("card"));
}

/** The card a drop at `y` goes before, or none for the end of the list. */
function dropBefore(list: HTMLElement, y: number): HTMLElement | undefined {
  return cardsIn(list).find((card) => {
    if (card.dataset.id === dragging?.id) return false;
    const box = card.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
}

function clearDrop(list: HTMLElement): void {
  for (const card of cardsIn(list)) card.classList.remove("drop-before", "drop-after");
}

/** Lets the cards of `list` be dragged into another order; `drop` gets the dragged id, the id it goes before, and the ids as shown. */
function sortable(list: HTMLElement, drop: (moved: string, before: string | undefined, shown: string[]) => void): void {
  list.addEventListener("dragstart", (event) => {
    const card = (event.target as Element).closest?.(".card") as HTMLElement | null;
    if (!card || card.parentElement !== list || !event.dataTransfer) return;
    dragging = { id: card.dataset.id!, list };
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.dataset.id!);
  });
  list.addEventListener("dragover", (event) => {
    if (dragging?.list !== list) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    clearDrop(list);
    const before = dropBefore(list, event.clientY);
    const last = cardsIn(list).filter((card) => card.dataset.id !== dragging?.id).at(-1);
    (before ?? last)?.classList.add(before ? "drop-before" : "drop-after");
  });
  list.addEventListener("dragleave", (event) => {
    if (!list.contains(event.relatedTarget as Node | null)) clearDrop(list);
  });
  list.addEventListener("drop", (event) => {
    if (dragging?.list !== list) return;
    event.preventDefault();
    const before = dropBefore(list, event.clientY)?.dataset.id;
    drop(
      dragging.id,
      before,
      cardsIn(list).map((card) => card.dataset.id!),
    );
  });
  list.addEventListener("dragend", () => {
    for (const card of cardsIn(list)) card.classList.remove("dragging");
    clearDrop(list);
    dragging = undefined;
  });
}

/** A drop in a group: the user's own order, which is the one shown, since a card drags only in it. */
function dropLive(moved: string, before: string | undefined, shown: string[]): void {
  sort = { by: "custom", order: dragInto(sort.order, shown, moved, before) };
  vscode.postMessage({ type: "order", ids: sort.order });
  applyFilters();
  render();
}

/** A drop among the favourites: the stars in their new order. */
function dropFavourite(moved: string, before: string | undefined, shown: string[]): void {
  favourites = { ...favourites, ids: dragInto(favourites.ids, shown, moved, before) };
  vscode.postMessage({ type: "favouriteOrder", ids: favourites.ids });
  render();
}

/** The usage groups of the agents shown. */
function shownUsage(): BoardUsage[] {
  return usageGroups.filter((group) => agentShown(group.agent));
}

/** The earlier sessions of the agents shown, and of those the ones a search matched. */
function shownPast(): { listed: PastView[]; shown: PastView[] } {
  const listed = past.filter((view) => agentShown(view.agent));
  return { listed, shown: query === "" ? listed : listed.filter((view) => hits.has(view.id)) };
}

function toggleAgent(agent: string): void {
  if (hiddenAgents.has(agent)) hiddenAgents.delete(agent);
  else hiddenAgents.add(agent);
  saveState();
  if (query !== "") summarise();
  applyFilters();
  render();
}

/**
 * The agents on the board, in catalog order, each with how many sessions it
 * runs: those with running sessions, earlier ones or usage, so an agent hidden
 * keeps its chip after its last session ends.
 */
function boardAgents(): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of [...past, ...usageGroups.filter((group) => group.meters.length > 0)]) counts.set(item.agent ?? AGENTS[0]!.id, 0);
  for (const view of allSessions) counts.set(view.agent, (counts.get(view.agent) ?? 0) + 1);
  return [...counts].sort((a, b) => order(a[0]) - order(b[0]));
}

function order(agent: string): number {
  const index = AGENTS.findIndex((info) => info.id === agent);
  return index < 0 ? AGENTS.length : index;
}

function toggleGroup(key: GroupKey): void {
  if (hidden.has(key)) hidden.delete(key);
  else hidden.add(key);
  saveState();
  applyFilters();
  render();
}

/** The legend counts every session; a click hides that group from the board. */
function renderBeam(): void {
  harbour.update(sessions, tidePercent(), now(), markers);
  const counts = { waiting: 0, done: 0, working: 0, idle: 0, parked: 0 };
  for (const group of groupSessions(allSessions)) counts[group.key] = group.views.length;
  legend.textContent = "";
  for (const [key, label] of [
    ["waiting", "need you"],
    ["done", "finished"],
    ["working", "working"],
    ["idle", "idle"],
    ["parked", "parked"],
  ] as const) {
    if (!counts[key] && !hidden.has(key)) continue;
    const item = el("button", `legend-item state-${key}${hidden.has(key) ? " off" : ""}`);
    item.type = "button";
    item.title = hidden.has(key) ? `Show ${label}` : `Hide ${label}`;
    item.setAttribute("aria-pressed", String(!hidden.has(key)));
    item.append(el("i", "swatch"), el("b", "", String(counts[key])), el("span", "", ` ${label}`));
    item.addEventListener("click", () => toggleGroup(key));
    legend.append(item);
  }
  if (!markers) return;
  // One chip per agent on the board, next to the states: a click hides that agent's sessions and usage.
  for (const [agent, count] of boardAgents()) {
    const info = agentInfo(agent);
    const off = hiddenAgents.has(agent);
    const item = el("button", `legend-item agent${off ? " off" : ""}`);
    item.type = "button";
    item.title = off ? `Show ${info.label}'s sessions and usage` : `Hide ${info.label}'s sessions and usage`;
    item.setAttribute("aria-pressed", String(!off));
    item.append(agentGlyph(agent, 10), el("b", "", String(count)), el("span", "", ` ${info.label}`));
    item.addEventListener("click", () => toggleAgent(agent));
    legend.append(item);
  }
}

/** The tide rises with the window the status bar shows, among the agents shown: Claude's 5 hours while it is the one agent with usage. */
function tidePercent(): number | undefined {
  const groups = shownUsage().map((group) => ({ ...group, agent: group.agent ?? AGENTS[0]!.id }));
  const pinned = groups.find((group) => group.agent === usageBar);
  if (pinned) return barMeter(pinned.meters)?.percent;
  return pickBar(groups)?.meter.percent;
}

// Usage, under the beam: a tab per agent with its session window, the limit
// that runs out first, and the chosen agent's limits below it, one line each.

const meters = el("div", "meters");
const usageTabs = el("div", "usage-tabs");
usageTabs.setAttribute("role", "tablist");
usageTabs.setAttribute("aria-label", "Usage by agent");
const usageRefresh = el("button", "link", "refresh");
usageRefresh.type = "button";
usageRefresh.title = "Fetch the usage again now";
usageRefresh.addEventListener("click", () => vscode.postMessage({ type: "refreshUsage", agent: usageRefresh.dataset.agent }));
usageTabs.append(usageRefresh);
const usageRows = el("div", "usage-rows");
usageRows.setAttribute("role", "tabpanel");
meters.append(usageTabs, usageRows);
/** Each agent's tab, by agent id. */
const usageTabEls = new Map<string, HTMLButtonElement>();
/** The chosen agent's limits, by limit. */
const meterRows = new Map<string, HTMLElement>();

/** "3h", until the window resets; empty once it has. */
function resetShort(resetsAt: number | undefined): string {
  if (resetsAt === undefined || resetsAt <= now()) return "";
  return formatResetIn(resetsAt - now()).replace(/^in /, "");
}

/** Fill colour by consumption: calm below half, amber from half, red from 80%. */
function meterLevel(percent: number): "low" | "mid" | "high" {
  return percent >= 80 ? "high" : percent >= 50 ? "mid" : "low";
}

/** One tab per agent shown, in catalog order; the chosen agent's limits under them. */
function renderMeters(): void {
  const groups = shownUsage().map((group) => ({ ...group, agent: group.agent ?? AGENTS[0]!.id }));
  meters.classList.toggle("hidden", groups.length === 0);
  const chosen = chosenGroup(groups, usageTab, usageBar);
  if (!chosen) return;
  let previous: HTMLElement | undefined;
  for (const group of groups) {
    let tab = usageTabEls.get(group.agent);
    if (!tab) {
      const agent = group.agent;
      tab = el("button", "usage-tab");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      const glyph = agentGlyph(agent, 11);
      // The tab's name says the agent already.
      glyph.setAttribute("aria-hidden", "true");
      tab.append(glyph, el("span", "name", agentInfo(agent).label), el("span", "share"));
      tab.addEventListener("click", () => {
        usageTab = agent;
        saveState();
        renderMeters();
      });
      usageTabEls.set(agent, tab);
    }
    const { shown, closest } = tabMeters(group.meters);
    const label = agentInfo(group.agent).label;
    const shareEl = tab.querySelector<HTMLElement>(".share")!;
    shareEl.textContent = shown ? `${Math.floor(shown.percent)}%` : "—";
    shareEl.className = `share ${shown ? meterLevel(shown.percent) : ""}`;
    tab.title = shown
      ? `${groupHeading(group.agent)}: ${shown.label} at ${Math.floor(shown.percent)}%${closest ? `; ${closest.label} is the closest to its limit, at ${Math.floor(closest.percent)}%` : ""}`
      : `${label}: no usage reported`;
    tab.classList.toggle("stale", group.stale);
    tab.setAttribute("aria-selected", String(group.agent === chosen.agent));
    const at = previous ? previous.nextSibling : usageTabs.firstChild;
    if (tab !== at) usageTabs.insertBefore(tab, at);
    previous = tab;
  }
  for (const [agent, tab] of usageTabEls) {
    if (groups.some((group) => group.agent === agent)) continue;
    tab.remove();
    usageTabEls.delete(agent);
  }
  usageRefresh.dataset.agent = chosen.agent;
  usageRefresh.classList.toggle("hidden", !chosen.canRefresh);
  meters.classList.toggle("stale", chosen.stale);
  const seen = new Set<string>();
  let row: Element | null = usageRows.firstElementChild;
  for (const meter of chosen.meters) {
    const id = `${chosen.agent}:${meter.key}`;
    seen.add(id);
    let line = meterRows.get(id);
    if (!line) {
      line = el("div", "meter");
      const bar = el("span", "bar");
      bar.append(el("span", "fill"));
      line.append(el("span", "label"), bar, el("span", "value"), el("span", "reset"));
      meterRows.set(id, line);
    }
    const percent = Math.floor(meter.percent);
    const reset = resetShort(meter.resetsAt);
    line.className = `meter ${meterLevel(meter.percent)}`;
    line.querySelector(".label")!.textContent = meter.label;
    (line.querySelector(".fill") as HTMLElement).style.width = `${Math.min(100, Math.max(0, meter.percent))}%`;
    // The share and the time to reset in columns of their own: the shares line up, with a time or without.
    line.querySelector(".value")!.textContent = `${percent}%`;
    line.querySelector(".reset")!.textContent = reset ? `· ${reset}` : "";
    line.title = reset ? `${meter.label}: ${percent}% used, resets in ${reset}` : `${meter.label}: ${percent}% used`;
    if (line !== row) usageRows.insertBefore(line, row);
    row = line.nextElementSibling;
  }
  for (const [id, line] of meterRows) {
    if (seen.has(id)) continue;
    line.remove();
    meterRows.delete(id);
  }
  usageRows.querySelector(".none")?.remove();
  if (chosen.fetchedAt === undefined || chosen.meters.length === 0) usageRows.append(el("div", "none", chosen.note ?? "No usage reported"));
}

/**
 * The agent's marks on a card: a thin edge in its hue and its silhouette
 * before the title. Both are always there and show only with the markers.
 */
function markCard(card: HTMLElement, row: HTMLElement, agent: string): void {
  card.style.setProperty("--hue", `var(${agentInfo(agent).hue})`);
  card.prepend(el("span", "edge"));
  row.prepend(agentGlyph(agent, 12));
}

/** Who the session belongs to, at the head of a hover, while the markers show. */
function agentPrefix(agent: string): string {
  return markers ? `${agentInfo(agent).label} · ` : "";
}

function createCard(view: SessionView): HTMLElement {
  const card = el("button", "card");
  card.type = "button";
  card.dataset.id = view.id;
  card.append(el("span", "rail"));
  const main = el("span", "main");
  const row = el("span", "row");
  // A click on the title renames the session through the agent, when it can; anywhere else on the card jumps to it.
  const title = el("span", canRename(view) ? "title rename" : "title");
  if (canRename(view)) {
    title.title = "Rename session";
    title.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "rename", id: view.id });
    });
  }
  row.append(title, el("span", "elapsed"));
  const line = el("span", "line");
  line.append(el("span", "mark"), el("span", "kind"), el("span", "text"));
  const options = el("span", "options hidden");
  const pulse = el("span", "pulse");
  const chipsEl = el("span", "chips");
  const costs = el("span", "costs");
  costs.append(el("span", "chip spend"));
  const hitsEl = el("span", "hits hidden");
  main.append(row, line, options, pulse, chipsEl, costs, hitsEl);
  card.append(main);
  const ring = el("span", "ring");
  ring.append(el("span", "ring-value"));
  card.append(ring);
  const actions = el("span", "actions");
  const seen = el("span", "action seen", "✓");
  seen.title = "Mark as seen";
  seen.setAttribute("role", "button");
  seen.addEventListener("click", (event) => {
    event.stopPropagation();
    // On a question read from the reply, the check dismisses that question.
    // A finished turn already seen stays under Finished until its check clears it.
    if (stayingFinished.delete(view.id)) render();
    vscode.postMessage({ type: card.classList.contains("typed") ? "dismiss" : "seen", id: view.id });
  });
  actions.append(seen, parkButton(view.id), noteButton(view.id), starButton(view.id));
  // In the title row, after the time: the same place as the star on earlier cards.
  row.append(actions);
  markCard(card, row, view.agent);
  card.addEventListener("click", () => harbour.jump(view.id));
  card.addEventListener("mouseenter", () => harbour.highlight(view.id, true));
  card.addEventListener("mouseleave", () => harbour.highlight(view.id, false));
  return card;
}

/** A parking sign: the card goes under Parked. */
const PARK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.4 11.6V4.6h2.3a2.1 2.1 0 0 1 0 4.2H6.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** A return arrow: a parked card comes back. */
const UNPARK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3 2.8 6.2 6 9.4M3.2 6.2h6.3a3.4 3.4 0 0 1 0 6.8H7.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The button that parks a session whose turn is over, or brings a parked one back; shown while the session rests. */
function parkButton(id: string): HTMLElement {
  const button = el("span", "action park");
  button.setAttribute("role", "button");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "park", id });
  });
  return button;
}


/** The first line of a note, for a card; the rest reads in the hover and on the note's page. */
function noteHead(note: string): string {
  const lines = note.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? "");
}

/** What a card knows of a session's notes: the newest, when it was written, and how many there are. */
interface NotesOnCard {
  note?: string;
  noteAt?: number;
  noteCount?: number;
}

/** "3 notes, the newest 2h ago", for a hover. */
function notesSummary(view: NotesOnCard): string {
  const count = view.noteCount ?? (view.note === undefined ? 0 : 1);
  const age = view.noteAt === undefined ? "" : `, the newest ${formatElapsed(now() - view.noteAt)} ago`;
  return count === 1 ? `1 note${view.noteAt === undefined ? "" : `, ${formatElapsed(now() - view.noteAt)} ago`}` : `${count} notes${age}`;
}

/** The button on a card's title row that opens the session's notes; lit while there are any. */
function noteButton(id: string): HTMLElement {
  const button = el("span", "note-btn");
  button.setAttribute("role", "button");
  button.innerHTML = NOTE_ICON;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "note", id });
  });
  return button;
}

function setNoteButton(card: HTMLElement, view: NotesOnCard): void {
  const button = card.querySelector<HTMLElement>(".note-btn");
  if (!button) return;
  const noted = view.note !== undefined;
  button.classList.toggle("on", noted);
  const title = noted ? `${notesSummary(view)}:\n${view.note}\nClick to read or add notes` : "Add a note: a line to remember the session by";
  if (button.title !== title) button.title = title;
  button.setAttribute("aria-label", noted ? "The notes" : "Add a note");
}

/** Under the title row of a card that is not running: the newest note, its first line, and how many more; a click opens them all. */
function noteLine(id: string): HTMLElement {
  const line = el("span", "note-line hidden");
  line.setAttribute("role", "button");
  line.innerHTML = NOTE_ICON;
  line.append(el("span", "note-text"), el("span", "note-more hidden"));
  line.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "note", id });
  });
  return line;
}

function setNoteLine(card: HTMLElement, view: NotesOnCard | undefined): void {
  const line = card.querySelector<HTMLElement>(".note-line");
  if (!line) return;
  const note = view?.note;
  line.classList.toggle("hidden", note === undefined);
  const text = line.querySelector(".note-text")!;
  const head = note === undefined ? "" : noteHead(note);
  if (text.textContent !== head) text.textContent = head;
  const more = line.querySelector<HTMLElement>(".note-more")!;
  const extra = (view?.noteCount ?? 1) - 1;
  more.classList.toggle("hidden", note === undefined || extra < 1);
  more.textContent = extra > 0 ? `+${extra}` : "";
  line.title = note === undefined || !view ? "" : `${notesSummary(view)}:\n${note}\nClick to read or add notes`;
}

/**
 * What VS Code's context menu offers on a card: the extension's card
 * commands, each shown when it applies, named in words.
 */
function setMenu(card: HTMLElement, view: SessionView): void {
  const context = JSON.stringify({
    webviewSection: "card",
    preventDefaultContextMenuItems: true,
    sessionId: view.id,
    lookoutCanJump: canJump(view),
    lookoutCanRename: canRename(view),
    lookoutFinished: view.state === "done",
    lookoutStarred: favourites.ids.includes(view.id),
    lookoutResting: view.state === "idle" || view.state === "done",
    lookoutParked: view.parked === true,
    lookoutNoted: view.note !== undefined,
    lookoutCanResume: false,
    lookoutCanArchive: false,
    lookoutArchived: false,
    lookoutPurged: false,
    lookoutKept: view.kept === true,
    lookoutCanKeep: view.empty !== true && view.restored !== true,
  });
  if (card.dataset.vscodeContext !== context) card.dataset.vscodeContext = context;
}

/** The same, on a card that is not running: resume, archive, keep and restore as they apply. */
function setPastMenu(card: HTMLElement, view: PastView, kind: PastKind): void {
  const context = JSON.stringify({
    webviewSection: "card",
    preventDefaultContextMenuItems: true,
    sessionId: view.id,
    lookoutCanJump: false,
    lookoutCanRename: false,
    lookoutFinished: false,
    lookoutStarred: favourites.ids.includes(view.id),
    lookoutResting: false,
    lookoutParked: false,
    lookoutNoted: view.note !== undefined,
    lookoutCanResume: canResume(view) && view.purged !== true,
    lookoutCanArchive: kind !== "purged",
    lookoutArchived: kind === "archived",
    lookoutPurged: view.purged === true,
    lookoutKept: view.kept === true,
    lookoutCanKeep: view.purged !== true,
  });
  if (card.dataset.vscodeContext !== context) card.dataset.vscodeContext = context;
}

function setPark(card: HTMLElement, view: SessionView): void {
  const button = card.querySelector<HTMLElement>(".action.park")!;
  const parked = String(view.parked === true);
  if (button.dataset.parked === parked) return;
  button.dataset.parked = parked;
  button.innerHTML = view.parked ? UNPARK_ICON : PARK_ICON;
  button.title = view.parked ? "Bring back from Parked" : "Park: out of the way under Parked, until it works again";
}

const MARKS = { waiting: "?", working: "›", done: "✓", idle: "", unknown: "" } as const;

/** The card's hover: state, what it asks, and where the state comes from. */
function cardTitle(view: SessionView): string {
  const lines = [`${agentPrefix(view.agent)}${stateTitle(view)} · ${view.title}`];
  if (view.state === "waiting") lines.push(describeReason(view.reason));
  const quiet = quietFor(view, now());
  if (quiet !== undefined) lines.push(`Nothing written to its transcript for ${formatElapsed(quiet)}.`);
  const evidence = describeEvidence(view.evidence, now());
  if (evidence) lines.push(evidence);
  if (view.note !== undefined) lines.push(`${(view.noteCount ?? 1) > 1 ? `Notes (${view.noteCount}), the newest` : "Note"}: ${noteHead(view.note)}`);
  return lines.join("\n");
}

/**
 * Finished turns the user has looked at stay under Finished, dimmed, until
 * the session works again or the check clears them: a click on a card must
 * not make it jump to another group under the pointer.
 */
const stayingFinished = new Set<string>();

function keepFinished(views: SessionView[]): SessionView[] {
  return views.map((view) => {
    // A parked session is out of the way, whatever its state.
    if (view.parked) {
      stayingFinished.delete(view.id);
      return view;
    }
    if (view.state === "done") {
      stayingFinished.add(view.id);
      return view;
    }
    if (view.state === "idle" && stayingFinished.has(view.id)) return { ...view, state: "done", seen: true } as SessionView;
    stayingFinished.delete(view.id);
    return view;
  });
}

function updateCard(card: HTMLElement, view: SessionView): void {
  const typed = view.reason?.kind === "typed";
  const quiet = quietFor(view, now()) !== undefined;
  const prose = view.state === "waiting" && view.reason !== undefined && view.reason.kind !== "permission";
  card.className = `card state-${view.state} host-${view.host}${typed ? " typed" : ""}${quiet ? " quiet" : ""}${prose ? " prose" : ""}${markers ? " marked" : ""}${canJump(view) ? "" : " nojump"}`;
  card.classList.toggle("seen", (view as { seen?: boolean }).seen === true);
  card.title = cardTitle(view);
  setPark(card, view);
  setMenu(card, view);
  // A card drags only in the user's own order: no other order changes behind their back.
  card.draggable = sort.by === "custom";
  card.querySelector(".title")!.textContent = view.title;
  card.querySelector(".elapsed")!.textContent = elapsedText(view);
  setStar(card, view.id);
  // On a running card the note is in the hover only: the board stays quiet.
  setNoteButton(card, view);
  const line = card.querySelector(".line")!;
  const second = cardLine(view, now());
  line.querySelector(".mark")!.textContent = MARKS[view.state];
  line.querySelector(".kind")!.textContent = second.label ?? "";
  line.querySelector(".text")!.textContent = second.text === undefined ? "" : typed ? `“${second.text}”` : second.text;
  line.classList.toggle("empty", second.text === undefined && second.label === undefined);
  line.classList.toggle("stuck", second.stuck === true);
  card.classList.toggle("background", view.background !== undefined);
  const options = card.querySelector(".options") as HTMLElement;
  const answers = second.options ?? [];
  options.classList.toggle("hidden", answers.length === 0);
  while (options.childNodes.length > answers.length) options.lastChild!.remove();
  answers.forEach((answer, i) => {
    const option = options.childNodes[i] ?? options.appendChild(el("span", "option"));
    if (option.textContent !== answer) option.textContent = answer;
  });
  const seen = card.querySelector(".action.seen") as HTMLElement;
  seen.title = typed ? "Dismiss the question: the session goes back to idle until it asks another" : "Mark as seen";
  const pulse = card.querySelector(".pulse") as HTMLElement;
  const bars = pulseBars(view.pulse);
  // The minutes the conversation was compacted carry a pin.
  const marks = new Set(view.pulseMarks ?? []);
  pulse.title = `${bars.length < 15 ? "Tool calls per minute since the session started" : "Tool calls per minute, last 15 minutes"}${marks.size > 0 ? "; a pin marks the minute the conversation was compacted" : ""}`;
  pulse.classList.toggle("empty", bars.length === 0 || (bars.every((b) => b === 0) && marks.size === 0));
  while (pulse.childNodes.length > bars.length) pulse.lastChild!.remove();
  bars.forEach((height, i) => {
    const bar = (pulse.childNodes[i] ?? pulse.appendChild(el("i", "bar"))) as HTMLElement;
    bar.style.height = `${Math.max(12, Math.round(height * 100))}%`;
    bar.classList.toggle("quiet", height === 0);
    bar.classList.toggle("compacted", marks.has(i));
  });
  const ring = card.querySelector(".ring") as HTMLElement;
  const percent = contextPercent(view);
  ring.classList.toggle("hidden", percent === undefined);
  if (percent !== undefined) {
    const level = contextLevel(percent);
    ring.style.setProperty("--p", String(percent));
    ring.classList.toggle("warn", level === "high");
    ring.classList.toggle("full", level === "full");
    ring.querySelector(".ring-value")!.textContent = `${percent}%`;
    ring.title = `Context window ${percent}% full (${formatTokens(view.contextTokens ?? 0)} of ${formatTokens(view.contextWindow ?? 0)}) at the agent's last call; amber from 75%, red from 90%. When it fills, the agent compacts the conversation.`;
  }
  const spendEl = card.querySelector(".spend") as HTMLElement;
  const spend = view.spend;
  spendEl.classList.toggle("hidden", spend === undefined);
  // A row with no chips takes no room.
  card.querySelector(".costs")!.classList.toggle("hidden", spend === undefined);
  if (spend) {
    const tokens = spend.input + spend.output + spend.cacheRead + spend.cacheWrite;
    const cost = typeof spend.costUsd !== "number" ? "" : ` · ${spend.estimated ? "~" : ""}${formatUsd(spend.costUsd)}`;
    spendEl.textContent = `${spend.partial ? "≥ " : ""}${formatTokens(tokens)} tokens${cost}`;
    spendEl.title = [
      `Tokens this session: ${formatTokens(spend.input)} input, ${formatTokens(spend.output)} output, ${formatTokens(spend.cacheRead)} cache read, ${formatTokens(spend.cacheWrite)} cache write.`,
      typeof spend.costUsd !== "number"
        ? spend.basis
          ? `${spend.basis}.`
          : "No price for this model."
        : spend.basis
          ? `API-equivalent: ${formatUsd(spend.costUsd)}, ${spend.basis}.`
          : `API list price: ${formatUsd(spend.costUsd)}${spend.estimated ? ", part of it Lookout's estimate since the agent's last checkpoint (subagents since then not counted)" : ", the agent's own figure"}.`,
      spend.partial ? "Earlier usage is missing: Lookout joined this transcript late." : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  renderHits(card.querySelector(".hits")!, query === "" ? undefined : hits.get(view.id));
  const chipsEl = card.querySelector(".chips")!;
  const values = chips(view);
  while (chipsEl.childNodes.length > values.length) chipsEl.lastChild!.remove();
  values.forEach((value, i) => setChip((chipsEl.childNodes[i] ?? chipsEl.appendChild(el("span", "chip"))) as HTMLElement, value));
}

/** The newest matches of a session under its card, the terms marked. */
function renderHits(hitsEl: Element, result: SearchResult | undefined): void {
  hitsEl.textContent = "";
  // A session that the query's operators picked, with no words to match, shows no snippets.
  hitsEl.classList.toggle("hidden", result === undefined || (result.hits.length === 0 && result.count === 0));
  if (!result) return;
  const id = (hitsEl.closest(".card") as HTMLElement).dataset.id!;
  for (const hit of result.hits) {
    const line = el("span", `hit ${hit.role}`);
    // The session's note is no message: a click changes it rather than opening the conversation.
    line.title = hit.role === "note" ? "The note on this session; click to change it" : "Open the conversation here, in a tab";
    line.setAttribute("role", "button");
    line.addEventListener("click", (event) => {
      event.stopPropagation();
      if (hit.role === "note") vscode.postMessage({ type: "note", id });
      else vscode.postMessage({ type: "openHit", query, id, index: hit.index });
    });
    line.append(el("i", "who", hit.role));
    const text = el("span", "snippet");
    let at = 0;
    for (const [start, end] of hit.ranges) {
      if (start > at) text.append(hit.snippet.slice(at, start));
      text.append(el("mark", "", hit.snippet.slice(start, end)));
      at = end;
    }
    if (at < hit.snippet.length) text.append(hit.snippet.slice(at));
    line.append(text);
    hitsEl.append(line);
  }
  if (result.count > result.hits.length) {
    const more = el("span", "more", `+${result.count - result.hits.length} more`);
    more.title = "Open the conversation in a tab, with every match";
    more.setAttribute("role", "button");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "openHit", query, id });
    });
    hitsEl.append(more);
  }
}

const ARCHIVE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="3.5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 6v6.7c0 .4.3.8.8.8h8.4c.5 0 .8-.4.8-.8V6M6.5 9h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const UNARCHIVE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="3.5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 6v6.7c0 .4.3.8.8.8h8.4c.5 0 .8-.4.8-.8V6M8 12.2V8.2M6.3 9.9 8 8.2l1.7 1.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The button on an earlier card's title row that archives it, or, on an archived card, brings it back to Earlier. */
function archiveButton(id: string, archived: boolean): HTMLElement {
  const button = el("span", "archive");
  button.setAttribute("role", "button");
  button.title = archived ? "Unarchive: back to Earlier" : "Archive: move it to Archived";
  button.setAttribute("aria-label", button.title);
  button.innerHTML = archived ? UNARCHIVE_ICON : ARCHIVE_ICON;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "archive", id });
  });
  return button;
}

/** A broken page: the kept conversation goes. */
const FORGET_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.3 2.5h3.4M4.2 4.5l.7 8.3a.6.6 0 0 0 .6.5h5a.6.6 0 0 0 .6-.5l.7-8.3M6.6 7v4M9.4 7v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The button on a purged card's title row that forgets the session: its kept conversation goes. */
function forgetButton(id: string): HTMLElement {
  const button = el("span", "forget");
  button.setAttribute("role", "button");
  button.title = "Forget: the conversation Lookout kept goes";
  button.setAttribute("aria-label", "Forget the conversation");
  button.innerHTML = FORGET_ICON;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "forget", id });
  });
  return button;
}

/** A box with an arrow in: the kept transcript goes back for the agent. */
const RESTORE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v7M5.3 6.5 8 9.2l2.7-2.7M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The button on a purged card whose transcript Lookout keeps: puts it back for the agent. Hidden while nothing is kept. */
function restoreButton(id: string): HTMLElement {
  const button = el("span", "restore hidden");
  button.setAttribute("role", "button");
  button.title = "Restore: put the kept transcript back where the agent keeps its transcripts, for the agent to resume";
  button.setAttribute("aria-label", "Restore the transcript");
  button.innerHTML = RESTORE_ICON;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "restore", id });
  });
  return button;
}

/** What a card that is not running is listed as: it changes which buttons it carries. */
type PastKind = "earlier" | "archived" | "purged";

/** An earlier session's card; an archived one has no star, and its button brings it back; a purged one's button forgets it. */
function createPastCard(view: PastView, kind: PastKind = "earlier"): HTMLElement {
  const card = el("button", kind === "purged" ? "card past purged" : "card past");
  card.type = "button";
  card.dataset.id = view.id;
  card.append(el("span", "rail"));
  const main = el("span", "main");
  const row = el("span", "row");
  const actions = el("span", "actions");
  actions.append(noteButton(view.id));
  if (kind !== "archived") actions.append(starButton(view.id));
  if (kind === "purged") actions.append(restoreButton(view.id), forgetButton(view.id));
  else actions.append(archiveButton(view.id, kind === "archived"));
  row.append(el("span", "title"), el("span", "elapsed"), actions);
  card.dataset.kind = kind;
  main.append(row, noteLine(view.id), el("span", "chips"), el("span", "hits hidden"));
  card.append(main);
  markCard(card, row, view.agent);
  card.addEventListener("click", () => {
    // The agent resumes only the sessions of this window's folders; another project's opens its conversation.
    if (card.dataset.resumable === "true") vscode.postMessage({ type: "resume", id: view.id });
    else vscode.postMessage({ type: "openHit", query, id: view.id });
  });
  return card;
}

function pastElapsed(view: PastView): string {
  return `${formatElapsed(now() - view.modifiedAt)} ago`;
}

/** Where a session that is not running resumes. */
function resumeWhere(view: PastView): string {
  return (view.resumesIn ?? agentInfo(view.agent).resumesIn) === "terminal" ? "in a terminal" : "in the agent's panel";
}

/** What a click on an earlier session does, and why. */
function pastTitle(view: PastView, resumable: boolean): string {
  const written = `Not running · last written ${pastElapsed(view)}`;
  if (view.purged) return `${written} · the agent deleted its transcript, and Lookout kept what was said: click to read it. It cannot be resumed`;
  if (resumable) return `${written} · click to resume it ${resumeWhere(view)}`;
  if (view.resumable) return `${written} · click to read its conversation; Lookout cannot resume ${agentInfo(view.agent).label}'s sessions`;
  return `${written} · from ${view.cwd || "another project"}, not one of this window's folders: click to read its conversation; the agent resumes it from a window open on that folder`;
}

function updatePastCard(card: HTMLElement, view: PastView): void {
  const resumable = canResume(view);
  card.dataset.resumable = String(resumable);
  card.classList.toggle("marked", markers);
  card.title = `${agentPrefix(view.agent)}${pastTitle(view, resumable)}`;
  card.querySelector(".title")!.textContent = view.title;
  card.querySelector(".elapsed")!.textContent = pastElapsed(view);
  setStar(card, view.id);
  setNoteButton(card, view);
  setPastMenu(card, view, (card.dataset.kind as PastKind | undefined) ?? "earlier");
  card.querySelector(".restore")?.classList.toggle("hidden", view.kept !== true);
  // While a search shows the note among the matches, the line under the title would say it twice.
  const result = query === "" ? undefined : hits.get(view.id);
  setNoteLine(card, result?.hits.some((hit) => hit.role === "note") ? undefined : view);
  const chipsEl = card.querySelector(".chips")!;
  const values: Chip[] = [{ text: view.worktree ? `${view.project} · ${view.worktree}` : view.project }];
  if (view.branch) values.push(branchChip(view.branch));
  if (view.kept) values.push(keptChip());
  while (chipsEl.childNodes.length > values.length) chipsEl.lastChild!.remove();
  values.forEach((value, i) => setChip((chipsEl.childNodes[i] ?? chipsEl.appendChild(el("span", "chip"))) as HTMLElement, value));
  renderHits(card.querySelector(".hits")!, result);
}

/** A starred session as the board has it now: running, or not. */
function favouriteOf(id: string): { live?: SessionView; past?: PastView } {
  const live = allSessions.find((view) => view.id === id);
  if (live) return { live };
  const view = past.find((p) => p.id === id) ?? favourites.past.find((p) => p.id === id) ?? purgedPast.find((p) => p.id === id);
  return view ? { past: view } : {};
}

function createFavouriteCard(id: string, agent: string): HTMLElement {
  const card = el("button", "card fav");
  card.type = "button";
  card.draggable = true;
  card.dataset.id = id;
  card.append(el("span", "rail"));
  const main = el("span", "main");
  const row = el("span", "row");
  const actions = el("span", "actions");
  actions.append(noteButton(id), starButton(id));
  row.append(el("span", "title"), el("span", "elapsed"), actions);
  main.append(row, noteLine(id), el("span", "chips"));
  card.append(main);
  markCard(card, row, agent);
  card.addEventListener("click", () => {
    const { live, past: view } = favouriteOf(id);
    if (live) harbour.jump(id);
    // The agent resumes only the sessions of this window's folders; another project's opens its conversation.
    else if (view && canResume(view)) vscode.postMessage({ type: "resume", id });
    else if (view) vscode.postMessage({ type: "openHit", query, id });
  });
  return card;
}

function updateFavouriteCard(card: HTMLElement, live: SessionView | undefined, view: PastView | undefined): void {
  const shown = (live ?? view)!;
  card.className = `${live ? `card fav state-${live.state}${canJump(live) ? "" : " nojump"}` : "card fav past"}${markers ? " marked" : ""}`;
  const title = live
    ? `${stateTitle(live)}${!canJump(live) ? "" : unreachable(live) ? " · click to read its conversation" : " · click to jump to it"}`
    : canResume(view!)
      ? `Not running · click to resume it ${resumeWhere(view!)}`
      : view!.resumable
        ? `Not running · click to read its conversation; Lookout cannot resume ${agentInfo(view!.agent).label}'s sessions`
        : `Not running · from ${view!.cwd || "another project"}: click to read its conversation`;
  card.title = `${agentPrefix(shown.agent)}${title}`;
  card.querySelector(".title")!.textContent = shown.title;
  card.querySelector(".elapsed")!.textContent = live ? `${stateTitle(live)}${elapsedText(live) ? ` · ${elapsedText(live)}` : ""}` : pastElapsed(view!);
  setStar(card, shown.id);
  setNoteButton(card, shown);
  // A running favourite keeps its note in the hover, like any running card.
  setNoteLine(card, live ? undefined : shown);
  if (live) setMenu(card, live);
  else setPastMenu(card, view!, "earlier");
  const values: Chip[] = [{ text: shown.worktree ? `${shown.project} · ${shown.worktree}` : shown.project }];
  if (shown.branch) values.push(branchChip(shown.branch));
  if (shown.kept) values.push(keptChip());
  const chipsEl = card.querySelector(".chips")!;
  while (chipsEl.childNodes.length > values.length) chipsEl.lastChild!.remove();
  values.forEach((value, i) => setChip((chipsEl.childNodes[i] ?? chipsEl.appendChild(el("span", "chip"))) as HTMLElement, value));
}

/**
 * The starred sessions, at the top: running ones and earlier ones, newest
 * star first; while a search runs, those with matches. Returns what the
 * groups follow.
 */
function renderFavourites(after: HTMLElement): HTMLElement {
  const shown = favourites.ids
    .map((id) => ({ id, ...favouriteOf(id) }))
    .filter((f) => (f.live || f.past) && agentShown((f.live ?? f.past)?.agent) && (query === "" || hits.has(f.id)));
  if (shown.length === 0) {
    favouritesEl?.remove();
    favouritesEl = undefined;
    favouriteCards.clear();
    return after;
  }
  if (!favouritesEl) {
    favouritesEl = el("section", "group group-favourites");
    const heading = el("h2", "heading");
    heading.append(el("i", "chev", "▸"), el("i", "star-mark", "★"), el("span", "label", "Favourites"), el("span", "count"));
    foldOnClick(heading, "favourites");
    const list = el("div", "cards");
    sortable(list, dropFavourite);
    favouritesEl.append(heading, list);
  }
  showFold(favouritesEl, "favourites");
  favouritesEl.querySelector(".count")!.textContent = String(shown.length);
  if (favouritesEl.previousElementSibling !== after) root.insertBefore(favouritesEl, after.nextSibling);
  const list = favouritesEl.querySelector(".cards")!;
  let previous: HTMLElement | undefined;
  for (const f of shown) {
    let card = favouriteCards.get(f.id);
    if (!card) {
      card = createFavouriteCard(f.id, (f.live ?? f.past)!.agent);
      favouriteCards.set(f.id, card);
    }
    updateFavouriteCard(card, f.live, f.past);
    const prev = previous ?? null;
    if (card.parentElement !== list || card.previousElementSibling !== prev) list.insertBefore(card, prev ? prev.nextSibling : list.firstChild);
    previous = card;
  }
  const ids = new Set(shown.map((f) => f.id));
  for (const [id, card] of favouriteCards) {
    if (ids.has(id)) continue;
    card.remove();
    favouriteCards.delete(id);
  }
  return favouritesEl;
}

const SCOPES: { scope: EarlierScope; label: string; title: string }[] = [
  { scope: "folders", label: "This window's folders", title: "List and search the earlier sessions of the folders open in this window" },
  { scope: "all", label: "All projects", title: "List and search the earlier sessions of every project" },
];

/**
 * The sessions that are not running, collapsed under the live ones; open
 * while a search has matches among them. The heading stays when its scope
 * holds none, so the scope can be switched.
 */
function renderEarlier(after: HTMLElement): void {
  const { listed, shown } = shownPast();
  const open = (earlierOpen || query !== "") && shown.length > 0;
  if (!earlierEl) {
    earlierEl = el("section", "group group-past");
    const heading = el("h2", "heading");
    heading.title = "Sessions that are not running. Click to show or hide them; a click on one resumes it in the agent's panel, or, for another project's, opens its conversation.";
    heading.append(el("i", "chev", "▸"), el("span", "label", "Earlier"), el("span", "count"));
    const scopes = el("span", "scopes");
    scopes.setAttribute("role", "group");
    scopes.setAttribute("aria-label", "Which earlier sessions to list");
    for (const option of SCOPES) {
      const button = el("button", "scope", option.label);
      button.type = "button";
      button.title = option.title;
      button.dataset.scope = option.scope;
      button.addEventListener("click", (event) => {
        // A choice of scope, not a click on the heading.
        event.stopPropagation();
        if (earlier.scope === option.scope) return;
        earlier = { ...earlier, scope: option.scope };
        earlierPage = 0;
        vscode.postMessage({ type: "earlierScope", scope: option.scope });
        render();
      });
      scopes.append(button);
    }
    heading.append(scopes);
    heading.addEventListener("click", () => {
      earlierOpen = !earlierOpen;
      saveState();
      render();
    });
    earlierEl.append(heading, el("p", "note hidden"), el("div", "cards"), pager("Pages of earlier sessions", (step) => turnPage(earlierEl, () => (earlierPage += step))));
  }
  earlierEl.classList.toggle("open", open);
  for (const button of earlierEl.querySelectorAll<HTMLElement>(".scope")) button.setAttribute("aria-pressed", String(button.dataset.scope === earlier.scope));
  earlierEl.querySelector(".count")!.textContent = query === "" ? String(shown.length) : `${shown.length} of ${listed.length}`;
  // More earlier sessions than are listed: the newest only, and searches cover those.
  // And what an agent's list leaves out, such as compressed sessions.
  const note = earlierEl.querySelector(".note")!;
  const notes = [...(earlier.capped ? [`Showing the newest ${earlier.limit}; older sessions are not listed or searched.`] : []), ...(earlier.notes ?? [])];
  note.classList.toggle("hidden", notes.length === 0 || !open);
  note.textContent = notes.join(" ");
  if (earlierEl.previousElementSibling !== after) root.insertBefore(earlierEl, after.nextSibling);
  const list = earlierEl.querySelector(".cards")!;
  list.classList.toggle("hidden", !open);
  const { page: at, first, end } = showPage(earlierEl, shown.length, earlierPage, open);
  earlierPage = at;
  const page = shown.slice(first, end);
  const seen = new Set<string>();
  let previousCard: HTMLElement | undefined;
  if (open) {
    for (const view of page) {
      seen.add(view.id);
      let card = pastCards.get(view.id);
      if (!card) {
        card = createPastCard(view);
        pastCards.set(view.id, card);
      }
      updatePastCard(card, view);
      const prev = previousCard ?? null;
      if (card.parentElement !== list || card.previousElementSibling !== prev) list.insertBefore(card, prev ? prev.nextSibling : list.firstChild);
      previousCard = card;
    }
  }
  for (const [id, card] of pastCards) {
    if (seen.has(id)) continue;
    card.remove();
    pastCards.delete(id);
  }
}

/** Under a group's cards: the newer page, which ones show, the older page. */
function pager(label: string, turn: (step: number) => void): HTMLElement {
  const nav = el("nav", "pager hidden");
  nav.setAttribute("aria-label", label);
  const newer = el("button", "newer", "‹ Newer");
  newer.type = "button";
  newer.title = "The newer sessions";
  newer.addEventListener("click", () => turn(-1));
  const older = el("button", "older", "Older ›");
  older.type = "button";
  older.title = "The older sessions";
  older.addEventListener("click", () => turn(1));
  nav.append(newer, el("span", "range"), older);
  return nav;
}

/** Turns a group's page, and brings its heading into view to read the new page from its top. */
function turnPage(section: HTMLElement | undefined, step: () => void): void {
  step();
  render();
  section?.querySelector(".heading")?.scrollIntoView({ block: "nearest" });
}

/** Sets a group's pager for `total` sessions; returns the page shown and the range of its sessions. */
function showPage(section: HTMLElement, total: number, page: number, open: boolean): { page: number; first: number; end: number } {
  const shown = pageOf(total, page, PAGE_SIZE);
  const nav = section.querySelector<HTMLElement>(".pager")!;
  nav.classList.toggle("hidden", !open || shown.pages === 1);
  nav.querySelector(".range")!.textContent = `${shown.first + 1}–${shown.end} of ${total}`;
  nav.querySelector<HTMLButtonElement>(".newer")!.disabled = shown.page === 0;
  nav.querySelector<HTMLButtonElement>(".older")!.disabled = shown.page === shown.pages - 1;
  return shown;
}

/**
 * The sessions archived in Lookout, under Earlier and collapsed; open while
 * a search has matches among them. Gone while nothing is archived.
 */
function renderArchive(after: HTMLElement): void {
  const listed = archivePast.filter((view) => agentShown(view.agent));
  const shown = query === "" ? listed : listed.filter((view) => hits.has(view.id));
  if (listed.length === 0) {
    archiveEl?.remove();
    archiveEl = undefined;
    archiveCards.clear();
    return;
  }
  const open = (archiveOpen || query !== "") && shown.length > 0;
  if (!archiveEl) {
    archiveEl = el("section", "group group-past group-archive");
    const heading = el("h2", "heading");
    heading.title = "Sessions you archived. Click to show or hide them; the button on a card brings it back to Earlier, and a session that runs again leaves the archive.";
    heading.append(el("i", "chev", "▸"), el("span", "label", "Archived"), el("span", "count"));
    heading.addEventListener("click", () => {
      archiveOpen = !archiveOpen;
      saveState();
      render();
    });
    archiveEl.append(heading, el("div", "cards"), pager("Pages of archived sessions", (step) => turnPage(archiveEl, () => (archivePage += step))));
  }
  archiveEl.classList.toggle("open", open);
  archiveEl.querySelector(".count")!.textContent = query === "" ? String(shown.length) : `${shown.length} of ${listed.length}`;
  if (archiveEl.previousElementSibling !== after) root.insertBefore(archiveEl, after.nextSibling);
  const list = archiveEl.querySelector(".cards")!;
  list.classList.toggle("hidden", !open);
  const { page: at, first, end } = showPage(archiveEl, shown.length, archivePage, open);
  archivePage = at;
  const seen = new Set<string>();
  let previousCard: HTMLElement | undefined;
  if (open) {
    for (const view of shown.slice(first, end)) {
      seen.add(view.id);
      let card = archiveCards.get(view.id);
      if (!card) {
        card = createPastCard(view, "archived");
        archiveCards.set(view.id, card);
      }
      updatePastCard(card, view);
      const prev = previousCard ?? null;
      if (card.parentElement !== list || card.previousElementSibling !== prev) list.insertBefore(card, prev ? prev.nextSibling : list.firstChild);
      previousCard = card;
    }
  }
  for (const [id, card] of archiveCards) {
    if (seen.has(id)) continue;
    card.remove();
    archiveCards.delete(id);
  }
}

/**
 * The sessions whose transcript the agent deleted, their conversations kept
 * by Lookout: under Archived, collapsed; open while a search has matches
 * among them. Gone while there is none.
 */
function renderPurged(after: HTMLElement): void {
  const listed = purgedPast.filter((view) => agentShown(view.agent));
  const shown = query === "" ? listed : listed.filter((view) => hits.has(view.id));
  if (listed.length === 0) {
    purgedEl?.remove();
    purgedEl = undefined;
    purgedCards.clear();
    return;
  }
  const open = (purgedOpen || query !== "") && shown.length > 0;
  if (!purgedEl) {
    purgedEl = el("section", "group group-past group-purged");
    const heading = el("h2", "heading");
    heading.title = "Sessions whose transcript the agent deleted: Lookout kept what you and it said. Click to show or hide them; a click on one reads its conversation, and the button on a card forgets it.";
    heading.append(el("i", "chev", "▸"), el("span", "label", "Purged"), el("span", "count"));
    heading.addEventListener("click", () => {
      purgedOpen = !purgedOpen;
      saveState();
      render();
    });
    purgedEl.append(heading, el("div", "cards"), pager("Pages of purged sessions", (step) => turnPage(purgedEl, () => (purgedPage += step))));
  }
  purgedEl.classList.toggle("open", open);
  purgedEl.querySelector(".count")!.textContent = query === "" ? String(shown.length) : `${shown.length} of ${listed.length}`;
  if (purgedEl.previousElementSibling !== after) root.insertBefore(purgedEl, after.nextSibling);
  const list = purgedEl.querySelector(".cards")!;
  list.classList.toggle("hidden", !open);
  const { page: at, first, end } = showPage(purgedEl, shown.length, purgedPage, open);
  purgedPage = at;
  const seen = new Set<string>();
  let previousCard: HTMLElement | undefined;
  if (open) {
    for (const view of shown.slice(first, end)) {
      seen.add(view.id);
      let card = purgedCards.get(view.id);
      if (!card) {
        card = createPastCard(view, "purged");
        purgedCards.set(view.id, card);
      }
      updatePastCard(card, view);
      const prev = previousCard ?? null;
      if (card.parentElement !== list || card.previousElementSibling !== prev) list.insertBefore(card, prev ? prev.nextSibling : list.firstChild);
      previousCard = card;
    }
  }
  for (const [id, card] of purgedCards) {
    if (seen.has(id)) continue;
    card.remove();
    purgedCards.delete(id);
  }
}

/** The groups under the live ones: Earlier, then Archived and Purged under it. */
function renderPastGroups(after: HTMLElement): void {
  renderEarlier(after);
  if (!earlierEl) return;
  renderArchive(earlierEl);
  renderPurged(archiveEl ?? earlierEl);
}

function render(): void {
  if (!beam.isConnected) root.prepend(beam);
  if (!meters.isConnected) beam.append(meters);
  renderBeam();
  renderMeters();
  const sections: Section[] = groupBy === "state" ? groupSessions(sessions).map((group) => ({ id: group.key, label: group.label, views: group.views })) : sectionsBy(sessions, groupBy);
  // While a search runs, archived and purged sessions with matches count too: their groups show them.
  const archiveMatches = query === "" ? 0 : [...archivePast, ...purgedPast].filter((view) => agentShown(view.agent) && hits.has(view.id)).length;
  const pastShown = shownPast().shown.length + archiveMatches;
  const nothing = sessions.length === 0 && pastShown === 0;
  root.classList.toggle("empty", nothing);
  root.querySelector(".nothing")?.remove();
  if (nothing) {
    for (const group of groupsEl.values()) group.remove();
    groupsEl.clear();
    cards.clear();
    const empty = el("div", "nothing");
    if (query !== "") empty.append(el("p", "big", search.classList.contains("searching") ? "Searching…" : "No conversation mentions that"), el("p", "small", "Every word must appear in one message, or in a session's note; since:, before:, project:, branch:, file: and has:note narrow the search. Esc clears it."));
    else if (watching === 0) {
      const open = el("button", "link", "Turn one on in the settings");
      open.addEventListener("click", () => vscode.postMessage({ type: "openAgentSettings" }));
      empty.append(el("p", "big", "Every agent is turned off"), el("p", "small", "Lookout watches no agent, so no session can show here."), open);
    } else if (allSessions.length > 0) empty.append(el("p", "big", "Everything is hidden"), el("p", "small", markers && hiddenAgents.size > 0 ? "Click a state or an agent in the legend to show it again." : "Click a state in the legend to show it again."));
    else empty.append(el("p", "big", "Nothing on the horizon"), el("p", "small", "Sessions appear here as soon as an agent starts."));
    root.append(empty);
    renderFavourites(beam);
    // With no agent watched there is nothing earlier to list either.
    if (watching === 0) {
      earlierEl?.remove();
      earlierEl = undefined;
      pastCards.clear();
      archiveEl?.remove();
      archiveEl = undefined;
      archiveCards.clear();
      purgedEl?.remove();
      purgedEl = undefined;
      purgedCards.clear();
    } else renderPastGroups(empty);
    return;
  }
  const seenIds = new Set<string>();
  const seenGroups = new Set<string>();
  let previousGroup: HTMLElement = renderFavourites(beam);
  for (const group of sections) {
    seenGroups.add(group.id);
    let section = groupsEl.get(group.id);
    // A state section wears its state; one by attribute shows what states it holds.
    const byState = isGroupKey(group.id);
    if (!section) {
      section = el("section", byState ? `group group-${group.id}` : "group group-by");
      const heading = el("h2", "heading");
      heading.append(el("i", "chev", "▸"));
      if (byState) heading.append(el("i", "swatch"));
      heading.append(el("span", "label", group.label), el("span", "count"), el("span", "summary"));
      foldOnClick(heading, group.id as FoldKey);
      if (group.id === "done") {
        // Right after the count, in the cards' own check colour: it acts on this group.
        const all = el("button", "mark-seen", "✓ all seen");
        all.type = "button";
        all.title = "Mark every finished session as seen";
        all.addEventListener("click", (event) => {
          // An action, not a click on the heading.
          event.stopPropagation();
          stayingFinished.clear();
          vscode.postMessage({ type: "seenAll" });
        });
        heading.append(all);
      }
      const list = el("div", "cards");
      sortable(list, dropLive);
      section.append(heading, list);
      groupsEl.set(group.id, section);
    }
    showFold(section, group.id as FoldKey);
    section.querySelector(".count")!.textContent = String(group.views.length);
    setSummary(section.querySelector(".summary")!, group.summary);
    if (section.previousElementSibling !== previousGroup) root.insertBefore(section, previousGroup.nextSibling);
    previousGroup = section;
    const list = section.querySelector(".cards")!;
    let previousCard: HTMLElement | undefined;
    for (const view of group.views) {
      seenIds.add(view.id);
      let card = cards.get(view.id);
      if (!card) {
        card = createCard(view);
        cards.set(view.id, card);
      }
      updateCard(card, view);
      const prev = previousCard ?? null;
      if (card.parentElement !== list || card.previousElementSibling !== prev) {
        list.insertBefore(card, prev ? prev.nextSibling : list.firstChild);
      }
      previousCard = card;
    }
  }
  for (const [id, card] of cards) {
    if (seenIds.has(id)) continue;
    card.remove();
    cards.delete(id);
  }
  for (const [key, section] of groupsEl) {
    if (seenGroups.has(key)) continue;
    section.remove();
    groupsEl.delete(key);
  }
  renderPastGroups(previousGroup);
}

function tick(): void {
  if (document.visibilityState !== "visible") return;
  for (const view of sessions) {
    const card = cards.get(view.id);
    if (!card) continue;
    card.querySelector(".elapsed")!.textContent = elapsedText(view);
    // The quiet mark, the evidence's age and the cache's countdown move with the clock.
    if (view.state === "working") {
      card.classList.toggle("quiet", quietFor(view, now()) !== undefined);
      card.querySelector(".line .kind")!.textContent = cardLine(view, now()).label ?? "";
    }
    card.title = cardTitle(view);
  }
  for (const view of past) {
    const card = pastCards.get(view.id);
    if (card) card.querySelector(".elapsed")!.textContent = pastElapsed(view);
  }
  for (const view of archivePast) {
    const card = archiveCards.get(view.id);
    if (card) card.querySelector(".elapsed")!.textContent = pastElapsed(view);
  }
  for (const view of purgedPast) {
    const card = purgedCards.get(view.id);
    if (card) card.querySelector(".elapsed")!.textContent = pastElapsed(view);
  }
  renderBeam();
  if (usageGroups.length) renderMeters();
}

window.addEventListener("message", (event: MessageEvent<ToBoard>) => {
  const message = event.data;
  if (message.type === "search") {
    receiveSearch(message);
    return;
  }
  if (message.type !== "sessions") return;
  allSessions = keepFinished(message.sessions);
  past = message.past ?? [];
  if (message.earlier) earlier = message.earlier;
  favourites = message.favourites ?? { ids: [], past: [] };
  if (message.sort) sort = message.sort;
  sortPicker.set(sort.by);
  if (message.group) groupBy = message.group;
  groupPicker.set(groupBy);
  archivePast = message.archive ?? [];
  purgedPast = message.purged ?? [];
  // One group, from an extension that knew only Claude's usage, or one per agent.
  usageGroups = sortGroups(Array.isArray(message.usage) ? message.usage : message.usage ? [message.usage] : []);
  usageBar = message.usageBar;
  markers = message.markers === true;
  watching = message.watching;
  clockOffset = message.now - Date.now();
  applyFilters();
  render();
  // The conversations go on; keep an open search current.
  if (query !== "") askSearch();
});

setInterval(tick, 1000);
vscode.postMessage({ type: "ready" });
