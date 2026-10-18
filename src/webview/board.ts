/// <reference lib="dom" />
import { describeEvidence, describeReason, formatElapsed, formatResetIn, formatTokens, formatUsd, quietFor, shortModel } from "../core/format";
import type { SearchResult } from "../core/history";
import type { PastView, SessionView } from "../core/types";
import { Harbour } from "./harbour";
import { cardLine, contextLevel, contextPercent, groupSessions, hostChip, isGroupKey, pulseBars, secondLine, type Chip, type GroupKey } from "./model";
import type { BoardUsage, EarlierInfo, EarlierScope, Favourites, FromBoard, ToBoard } from "./protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: FromBoard): void;
  getState(): { hidden?: string[]; earlier?: boolean } | undefined;
  setState(state: { hidden?: string[]; earlier?: boolean }): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

/** Every session the extension sent. */
let allSessions: SessionView[] = [];
/** The sessions after the legend filters. */
let sessions: SessionView[] = [];
/** State groups the user hid through the legend; kept across reloads. */
const hidden = new Set<GroupKey>((vscode.getState()?.hidden ?? []).filter(isGroupKey));
let usage: BoardUsage | undefined;
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
let favouritesEl: HTMLElement | undefined;
const favouriteCards = new Map<string, HTMLElement>();

/** The star that marks a favourite; a click stars the session or takes its star away. */
function starButton(id: string): HTMLElement {
  const star = el("span", "star", "☆");
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
  star.textContent = on ? "★" : "☆";
  (star as HTMLElement).title = on ? "Take the star away" : "Star this session: it stays under Favourites";
}
/** The user opened the Earlier group; kept across reloads. */
let earlierOpen = vscode.getState()?.earlier === true;
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
  if (view.model) out.push({ text: shortModel(view.model) });
  // The ring shows the context when the window is known; the chip covers the rest.
  if (view.contextTokens && !view.contextWindow) out.push({ text: `${formatTokens(view.contextTokens)} tokens` });
  if (view.agents > 0) out.push({ text: view.agents === 1 ? "1 agent" : `${view.agents} agents` });
  return out;
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
  hover.append(el("div", "hover-title", view.title));
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
  if (view.spend) {
    const tokens = view.spend.input + view.spend.output + view.spend.cacheRead + view.spend.cacheWrite;
    meta.push(`${formatTokens(tokens)} tokens${typeof view.spend.costUsd !== "number" ? "" : ` · ${view.spend.estimated ? "~" : ""}${formatUsd(view.spend.costUsd)}`}`);
  }
  hover.append(el("div", "hover-meta", meta.join(" · ")));
  hover.append(el("div", "hover-hint", "Click to jump"));
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
input.title = "Every word must appear in one message. Narrow it with since:3d, before:yesterday, since:2026-10-01, project:api, branch:fix-login, file:src/app.ts";
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
  if (query !== "") vscode.postMessage({ type: "openSearch", query });
});
search.append(field, clear, summary);
beam.append(search);

let searchTimer: ReturnType<typeof setTimeout> | undefined;

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
  hits = new Map();
  search.classList.toggle("active", query !== "");
  if (query === "") {
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
  searchTimer = setTimeout(runSearch, 250);
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

function receiveSearch(message: { query: string; results: SearchResult[]; pending: number }): void {
  // An answer to an older query is of no use.
  if (message.query !== query) return;
  hits = new Map(message.results.map((result) => [result.id, result]));
  pending = message.pending;
  search.classList.toggle("searching", pending > 0);
  const matches = message.results.reduce((sum, result) => sum + result.count, 0);
  const picked = `${message.results.length} ${message.results.length === 1 ? "session" : "sessions"}`;
  // Operators alone pick sessions without words to match.
  const found = message.results.length === 0 ? "no matches" : matches === 0 ? picked : `${matches} ${matches === 1 ? "match" : "matches"} in ${picked}`;
  summary.textContent = pending > 0 ? `${found} · reading ${pending} more…` : found;
  applyFilters();
  render();
  // Conversations not read within the time given: ask again shortly, until none is left.
  if (pending > 0) {
    setTimeout(() => {
      if (query === message.query) askSearch();
    }, 400);
  }
}

function applyFilters(): void {
  sessions = allSessions.filter((view) => !hidden.has(groupSessions([view])[0]!.key) && (query === "" || hits.has(view.id)));
}

function toggleGroup(key: GroupKey): void {
  if (hidden.has(key)) hidden.delete(key);
  else hidden.add(key);
  vscode.setState({ hidden: [...hidden], earlier: earlierOpen });
  applyFilters();
  render();
}

/** The legend counts every session; a click hides that group from the board. */
function renderBeam(): void {
  harbour.update(sessions, usage?.meters.find((m) => m.key === "session")?.percent, now());
  const counts = { waiting: 0, done: 0, working: 0, idle: 0 };
  for (const group of groupSessions(allSessions)) counts[group.key] = group.views.length;
  legend.textContent = "";
  for (const [key, label] of [
    ["waiting", "need you"],
    ["done", "finished"],
    ["working", "working"],
    ["idle", "idle"],
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
}

// Usage meters: one bar per limit, under the beam.

const meters = el("div", "meters");
const meterRows = new Map<string, HTMLElement>();

/** "Resets in 3h", as Claude Code's panel says it. */
function resetText(resetsAt: number | undefined): string {
  if (resetsAt === undefined || resetsAt <= now()) return "";
  return `Resets ${formatResetIn(resetsAt - now())}`;
}

/** Fill colour by consumption: calm below half, amber from half, red from 80%. */
function meterLevel(percent: number): "low" | "mid" | "high" {
  return percent >= 80 ? "high" : percent >= 50 ? "mid" : "low";
}

function renderMeters(): void {
  meters.classList.toggle("hidden", usage === undefined);
  meters.classList.toggle("stale", usage?.stale === true);
  if (!usage) return;
  const seen = new Set<string>();
  let previous: HTMLElement | undefined;
  for (const meter of usage.meters) {
    seen.add(meter.key);
    let row = meterRows.get(meter.key);
    if (!row) {
      row = el("div", "meter");
      const bar = el("span", "bar");
      bar.append(el("span", "fill"));
      row.append(el("span", "label"), el("span", "percent"), bar, el("span", "reset"));
      meterRows.set(meter.key, row);
    }
    row.className = `meter ${meterLevel(meter.percent)}`;
    row.querySelector(".label")!.textContent = meter.label;
    (row.querySelector(".fill") as HTMLElement).style.width = `${Math.min(100, Math.max(0, meter.percent))}%`;
    row.querySelector(".percent")!.textContent = `${Math.floor(meter.percent)}%`;
    row.querySelector(".reset")!.textContent = resetText(meter.resetsAt);
    if (row.previousElementSibling !== (previous ?? null) || row.parentElement !== meters) meters.insertBefore(row, previous ? previous.nextSibling : meters.firstChild);
    previous = row;
  }
  for (const [key, row] of meterRows) {
    if (seen.has(key)) continue;
    row.remove();
    meterRows.delete(key);
  }
  let foot = meters.querySelector<HTMLElement>(".foot");
  if (!foot) {
    foot = el("div", "foot");
    const refresh = el("button", "link", "refresh");
    refresh.type = "button";
    refresh.title = "Fetch the usage again now";
    refresh.addEventListener("click", () => vscode.postMessage({ type: "refreshUsage" }));
    foot.append(el("span", "age"), refresh);
    meters.append(foot);
  }
  meters.append(foot);
  foot.querySelector(".age")!.textContent = usage.fetchedAt === undefined ? "No usage reported" : "";
  foot.querySelector(".link")!.classList.toggle("hidden", !usage.canRefresh);
}

function createCard(view: SessionView): HTMLElement {
  const card = el("button", "card");
  card.type = "button";
  card.dataset.id = view.id;
  card.append(el("span", "rail"));
  const main = el("span", "main");
  const row = el("span", "row");
  // A click on the title renames the session through the agent; anywhere else on the card jumps to it.
  const title = el("span", "title rename");
  title.title = "Rename session";
  title.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "rename", id: view.id });
  });
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
  actions.append(starButton(view.id), seen);
  card.append(actions);
  card.addEventListener("click", () => harbour.jump(view.id));
  card.addEventListener("mouseenter", () => harbour.highlight(view.id, true));
  card.addEventListener("mouseleave", () => harbour.highlight(view.id, false));
  return card;
}

const MARKS = { waiting: "?", working: "›", done: "✓", idle: "", unknown: "" } as const;

/** The card's hover: state, what it asks, and where the state comes from. */
function cardTitle(view: SessionView): string {
  const lines = [`${stateTitle(view)} · ${view.title}`];
  if (view.state === "waiting") lines.push(describeReason(view.reason));
  const quiet = quietFor(view, now());
  if (quiet !== undefined) lines.push(`Nothing written to its transcript for ${formatElapsed(quiet)}.`);
  const evidence = describeEvidence(view.evidence, now());
  if (evidence) lines.push(evidence);
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
  card.className = `card state-${view.state} host-${view.host}${typed ? " typed" : ""}${quiet ? " quiet" : ""}${prose ? " prose" : ""}`;
  card.classList.toggle("seen", (view as { seen?: boolean }).seen === true);
  card.title = cardTitle(view);
  card.querySelector(".title")!.textContent = view.title;
  card.querySelector(".elapsed")!.textContent = elapsedText(view);
  setStar(card, view.id);
  const line = card.querySelector(".line")!;
  const second = cardLine(view, now());
  line.querySelector(".mark")!.textContent = MARKS[view.state];
  line.querySelector(".kind")!.textContent = second.label ?? "";
  line.querySelector(".text")!.textContent = second.text === undefined ? "" : typed ? `“${second.text}”` : second.text;
  line.classList.toggle("empty", second.text === undefined && second.label === undefined);
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
      typeof spend.costUsd !== "number" ? "No price for this model." : `API list price: ${formatUsd(spend.costUsd)}${spend.estimated ? ", part of it Lookout's estimate since the agent's last checkpoint (subagents since then not counted)" : ", the agent's own figure"}.`,
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
    line.title = "Open the conversation here, in a tab";
    line.setAttribute("role", "button");
    line.addEventListener("click", (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: "openHit", query, id, index: hit.index });
    });
    line.append(el("i", "who", hit.role === "you" ? "you" : "agent"));
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

function createPastCard(view: PastView): HTMLElement {
  const card = el("button", "card past");
  card.type = "button";
  card.dataset.id = view.id;
  card.append(el("span", "rail"));
  const main = el("span", "main");
  const row = el("span", "row");
  row.append(el("span", "title"), el("span", "elapsed"), starButton(view.id));
  main.append(row, el("span", "chips"), el("span", "hits hidden"));
  card.append(main);
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

function updatePastCard(card: HTMLElement, view: PastView): void {
  card.dataset.resumable = String(view.resumable);
  card.title = view.resumable
    ? `Not running · last written ${pastElapsed(view)} · click to resume it in the agent's panel`
    : `Not running · last written ${pastElapsed(view)} · from ${view.cwd || "another project"}, not one of this window's folders: click to read its conversation; the agent resumes it from a window open on that folder`;
  card.querySelector(".title")!.textContent = view.title;
  card.querySelector(".elapsed")!.textContent = pastElapsed(view);
  setStar(card, view.id);
  const chipsEl = card.querySelector(".chips")!;
  const values: Chip[] = [{ text: view.worktree ? `${view.project} · ${view.worktree}` : view.project }];
  if (view.branch) values.push(branchChip(view.branch));
  while (chipsEl.childNodes.length > values.length) chipsEl.lastChild!.remove();
  values.forEach((value, i) => setChip((chipsEl.childNodes[i] ?? chipsEl.appendChild(el("span", "chip"))) as HTMLElement, value));
  renderHits(card.querySelector(".hits")!, query === "" ? undefined : hits.get(view.id));
}

/** A starred session as the board has it now: running, or not. */
function favouriteOf(id: string): { live?: SessionView; past?: PastView } {
  const live = allSessions.find((view) => view.id === id);
  if (live) return { live };
  const view = past.find((p) => p.id === id) ?? favourites.past.find((p) => p.id === id);
  return view ? { past: view } : {};
}

function createFavouriteCard(id: string): HTMLElement {
  const card = el("button", "card fav");
  card.type = "button";
  card.dataset.id = id;
  card.append(el("span", "rail"));
  const main = el("span", "main");
  const row = el("span", "row");
  row.append(el("span", "title"), el("span", "elapsed"), starButton(id));
  main.append(row, el("span", "chips"));
  card.append(main);
  card.addEventListener("click", () => {
    const { live, past: view } = favouriteOf(id);
    if (live) harbour.jump(id);
    // The agent resumes only the sessions of this window's folders; another project's opens its conversation.
    else if (view?.resumable) vscode.postMessage({ type: "resume", id });
    else if (view) vscode.postMessage({ type: "openHit", query, id });
  });
  return card;
}

function updateFavouriteCard(card: HTMLElement, live: SessionView | undefined, view: PastView | undefined): void {
  const shown = (live ?? view)!;
  card.className = live ? `card fav state-${live.state}` : "card fav past";
  card.title = live ? `${stateTitle(live)} · click to jump to it` : view!.resumable ? "Not running · click to resume it in the agent's panel" : `Not running · from ${view!.cwd || "another project"}: click to read its conversation`;
  card.querySelector(".title")!.textContent = shown.title;
  card.querySelector(".elapsed")!.textContent = live ? `${stateTitle(live)}${elapsedText(live) ? ` · ${elapsedText(live)}` : ""}` : pastElapsed(view!);
  setStar(card, shown.id);
  const values: Chip[] = [{ text: shown.worktree ? `${shown.project} · ${shown.worktree}` : shown.project }];
  if (shown.branch) values.push(branchChip(shown.branch));
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
    .filter((f) => (f.live || f.past) && (query === "" || hits.has(f.id)));
  if (shown.length === 0) {
    favouritesEl?.remove();
    favouritesEl = undefined;
    favouriteCards.clear();
    return after;
  }
  if (!favouritesEl) {
    favouritesEl = el("section", "group group-favourites");
    const heading = el("h2", "heading");
    heading.append(el("i", "star-mark", "★"), el("span", "label", "Favourites"), el("span", "count"));
    favouritesEl.append(heading, el("div", "cards"));
  }
  favouritesEl.querySelector(".count")!.textContent = String(shown.length);
  if (favouritesEl.previousElementSibling !== after) root.insertBefore(favouritesEl, after.nextSibling);
  const list = favouritesEl.querySelector(".cards")!;
  let previous: HTMLElement | undefined;
  for (const f of shown) {
    let card = favouriteCards.get(f.id);
    if (!card) {
      card = createFavouriteCard(f.id);
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
  const shown = query === "" ? past : past.filter((view) => hits.has(view.id));
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
        vscode.postMessage({ type: "earlierScope", scope: option.scope });
        render();
      });
      scopes.append(button);
    }
    heading.append(scopes);
    heading.addEventListener("click", () => {
      earlierOpen = !earlierOpen;
      vscode.setState({ hidden: [...hidden], earlier: earlierOpen });
      render();
    });
    earlierEl.append(heading, el("p", "note hidden"), el("div", "cards"));
  }
  earlierEl.classList.toggle("open", open);
  for (const button of earlierEl.querySelectorAll<HTMLElement>(".scope")) button.setAttribute("aria-pressed", String(button.dataset.scope === earlier.scope));
  earlierEl.querySelector(".count")!.textContent = query === "" ? String(shown.length) : `${shown.length} of ${past.length}`;
  // More earlier sessions than are listed: the newest only, and searches cover those.
  const note = earlierEl.querySelector(".note")!;
  note.classList.toggle("hidden", !earlier.capped || !open);
  note.textContent = earlier.capped ? `Showing the newest ${earlier.limit}; older sessions are not listed or searched.` : "";
  if (earlierEl.previousElementSibling !== after) root.insertBefore(earlierEl, after.nextSibling);
  const list = earlierEl.querySelector(".cards")!;
  list.classList.toggle("hidden", !open);
  const seen = new Set<string>();
  let previousCard: HTMLElement | undefined;
  if (open) {
    for (const view of shown) {
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

function render(): void {
  if (!beam.isConnected) root.prepend(beam);
  if (!meters.isConnected) beam.append(meters);
  renderBeam();
  renderMeters();
  const groups = groupSessions(sessions);
  const pastShown = query === "" ? past.length : past.filter((view) => hits.has(view.id)).length;
  const nothing = sessions.length === 0 && pastShown === 0;
  root.classList.toggle("empty", nothing);
  root.querySelector(".nothing")?.remove();
  if (nothing) {
    for (const group of groupsEl.values()) group.remove();
    groupsEl.clear();
    cards.clear();
    const empty = el("div", "nothing");
    if (query !== "") empty.append(el("p", "big", search.classList.contains("searching") ? "Searching…" : "No conversation mentions that"), el("p", "small", "Every word must appear in one message; since:, before:, project:, branch: and file: narrow the search. Esc clears it."));
    else if (allSessions.length > 0) empty.append(el("p", "big", "Everything is hidden"), el("p", "small", "Click a state in the legend to show it again."));
    else empty.append(el("p", "big", "Nothing on the horizon"), el("p", "small", "Sessions appear here as soon as an agent starts."));
    root.append(empty);
    renderFavourites(beam);
    renderEarlier(empty);
    return;
  }
  const seenIds = new Set<string>();
  const seenGroups = new Set<string>();
  let previousGroup: HTMLElement = renderFavourites(beam);
  for (const group of groups) {
    seenGroups.add(group.key);
    let section = groupsEl.get(group.key);
    if (!section) {
      section = el("section", `group group-${group.key}`);
      const heading = el("h2", "heading");
      heading.append(el("i", "swatch"), el("span", "label", group.label), el("span", "count"));
      if (group.key === "done") {
        const all = el("button", "link", "mark all seen");
        all.type = "button";
        all.addEventListener("click", () => {
          stayingFinished.clear();
          vscode.postMessage({ type: "seenAll" });
        });
        heading.append(all);
      }
      section.append(heading, el("div", "cards"));
      groupsEl.set(group.key, section);
    }
    section.querySelector(".count")!.textContent = String(group.views.length);
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
  renderEarlier(previousGroup);
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
  renderBeam();
  if (usage) renderMeters();
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
  usage = message.usage;
  clockOffset = message.now - Date.now();
  applyFilters();
  render();
  // The conversations go on; keep an open search current.
  if (query !== "") askSearch();
});

setInterval(tick, 1000);
vscode.postMessage({ type: "ready" });
