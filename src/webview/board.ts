/// <reference lib="dom" />
import { formatElapsed, formatTokens, formatUsd, shortModel } from "../core/format";
import type { SearchResult } from "../core/history";
import type { PastView, SessionView } from "../core/types";
import { Harbour } from "./harbour";
import { contextPercent, groupSessions, hostChip, isGroupKey, pulseBars, secondLine, type GroupKey } from "./model";
import type { BoardUsage, FromBoard, ToBoard } from "./protocol";

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

function chips(view: SessionView): string[] {
  const out = [view.worktree ? `${view.project} · ${view.worktree}` : view.project];
  const where = hostChip(view);
  if (where) out.push(where);
  if (view.model) out.push(shortModel(view.model));
  // The ring shows the context when the window is known; the chip covers the rest.
  if (view.contextTokens && !view.contextWindow) out.push(`${formatTokens(view.contextTokens)} tokens`);
  if (view.agents > 0) out.push(view.agents === 1 ? "1 agent" : `${view.agents} agents`);
  return out;
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
  const second = secondLine(view);
  if (second) hover.append(el("div", "hover-line", second));
  const meta = chips(view);
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
input.setAttribute("aria-label", "Search the conversations");
input.spellcheck = false;
field.append(input);
const clear = el("button", "clear", "×");
clear.type = "button";
clear.title = "Clear the search";
const summary = el("span", "summary");
search.append(field, clear, summary);
beam.append(search);

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function runSearch(): void {
  const next = input.value.trim();
  if (next === query && next !== "") {
    vscode.postMessage({ type: "search", query });
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
  vscode.postMessage({ type: "search", query });
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
  const found = matches === 0 ? "no matches" : `${matches} ${matches === 1 ? "match" : "matches"} in ${message.results.length} ${message.results.length === 1 ? "session" : "sessions"}`;
  summary.textContent = pending > 0 ? `${found} · reading ${pending} more…` : found;
  applyFilters();
  render();
  // Conversations not read within the time given: ask again shortly, until none is left.
  if (pending > 0) {
    setTimeout(() => {
      if (query === message.query) vscode.postMessage({ type: "search", query });
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

function resetText(resetsAt: number | undefined): string {
  if (resetsAt === undefined || resetsAt <= now()) return "";
  return `resets in ${formatElapsed(resetsAt - now())}`;
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
      row.append(el("span", "label"), bar, el("span", "percent"), el("span", "reset"));
      meterRows.set(meter.key, row);
    }
    row.className = `meter ${meterLevel(meter.percent)}`;
    row.querySelector(".label")!.textContent = meter.label;
    (row.querySelector(".fill") as HTMLElement).style.width = `${Math.min(100, Math.max(0, meter.percent))}%`;
    row.querySelector(".percent")!.textContent = `${meter.percent}%`;
    row.querySelector(".reset")!.textContent = resetText(meter.resetsAt);
    row.title = `${meter.label}: ${meter.percent}% used${meter.resetsAt !== undefined && meter.resetsAt > now() ? `, ${resetText(meter.resetsAt)}` : ""}`;
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
    foot.append(refresh);
    meters.append(foot);
  }
  meters.append(foot);
  foot.querySelector(".link")!.classList.toggle("hidden", !usage.canRefresh);
}

function createCard(view: SessionView): HTMLElement {
  const card = el("button", "card");
  card.type = "button";
  card.dataset.id = view.id;
  card.append(el("span", "rail"));
  const main = el("span", "main");
  const row = el("span", "row");
  row.append(el("span", "title"), el("span", "elapsed"));
  const line = el("span", "line");
  line.append(el("span", "mark"), el("span", "text"));
  const pulse = el("span", "pulse");
  const chipsEl = el("span", "chips");
  const spend = el("span", "chip spend");
  const hitsEl = el("span", "hits hidden");
  main.append(row, line, pulse, chipsEl, spend, hitsEl);
  card.append(main);
  const ring = el("span", "ring");
  ring.append(el("span", "ring-value"));
  card.append(ring);
  const actions = el("span", "actions");
  const rename = el("span", "action rename", "✎");
  rename.title = "Rename session";
  rename.setAttribute("role", "button");
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "rename", id: view.id });
  });
  const seen = el("span", "action seen", "✓");
  seen.title = "Mark as seen";
  seen.setAttribute("role", "button");
  seen.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "seen", id: view.id });
  });
  actions.append(rename, seen);
  card.append(actions);
  card.addEventListener("click", () => harbour.jump(view.id));
  card.addEventListener("mouseenter", () => harbour.highlight(view.id, true));
  card.addEventListener("mouseleave", () => harbour.highlight(view.id, false));
  return card;
}

const MARKS = { waiting: "?", working: "›", done: "✓", idle: "", unknown: "" } as const;

function updateCard(card: HTMLElement, view: SessionView): void {
  card.className = `card state-${view.state} host-${view.host}`;
  card.title = `${stateTitle(view)} · ${view.title}`;
  card.querySelector(".title")!.textContent = view.title;
  card.querySelector(".elapsed")!.textContent = elapsedText(view);
  const line = card.querySelector(".line")!;
  const text = secondLine(view);
  line.querySelector(".mark")!.textContent = MARKS[view.state];
  line.querySelector(".text")!.textContent = text ?? "";
  line.classList.toggle("empty", text === undefined);
  const pulse = card.querySelector(".pulse") as HTMLElement;
  const bars = pulseBars(view.pulse);
  pulse.title = bars.length < 15 ? "Tool calls per minute since the session started" : "Tool calls per minute, last 15 minutes";
  pulse.classList.toggle("empty", bars.length === 0 || bars.every((b) => b === 0));
  while (pulse.childNodes.length > bars.length) pulse.lastChild!.remove();
  bars.forEach((height, i) => {
    const bar = (pulse.childNodes[i] ?? pulse.appendChild(el("i", "bar"))) as HTMLElement;
    bar.style.height = `${Math.max(12, Math.round(height * 100))}%`;
    bar.classList.toggle("quiet", height === 0);
  });
  const ring = card.querySelector(".ring") as HTMLElement;
  const percent = contextPercent(view);
  ring.classList.toggle("hidden", percent === undefined);
  if (percent !== undefined) {
    ring.style.setProperty("--p", String(percent));
    ring.classList.toggle("warn", percent >= 80);
    ring.querySelector(".ring-value")!.textContent = `${percent}%`;
    ring.title = `Context window ${percent}% full (${formatTokens(view.contextTokens ?? 0)} of ${formatTokens(view.contextWindow ?? 0)})`;
  }
  const spendEl = card.querySelector(".spend") as HTMLElement;
  const spend = view.spend;
  spendEl.classList.toggle("hidden", spend === undefined);
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
  const labels = chips(view);
  while (chipsEl.childNodes.length > labels.length) chipsEl.lastChild!.remove();
  labels.forEach((label, i) => {
    const chip = chipsEl.childNodes[i] ?? chipsEl.appendChild(el("span", "chip"));
    if (chip.textContent !== label) chip.textContent = label;
  });
}

/** The newest matches of a session under its card, the terms marked. */
function renderHits(hitsEl: Element, result: SearchResult | undefined): void {
  hitsEl.textContent = "";
  hitsEl.classList.toggle("hidden", result === undefined);
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
  row.append(el("span", "title"), el("span", "elapsed"));
  main.append(row, el("span", "chips"), el("span", "hits hidden"));
  card.append(main);
  card.addEventListener("click", () => vscode.postMessage({ type: "resume", id: view.id }));
  return card;
}

function pastElapsed(view: PastView): string {
  return `${formatElapsed(now() - view.modifiedAt)} ago`;
}

function updatePastCard(card: HTMLElement, view: PastView): void {
  card.title = `Not running · last written ${pastElapsed(view)} · click to resume it in the agent's panel`;
  card.querySelector(".title")!.textContent = view.title;
  card.querySelector(".elapsed")!.textContent = pastElapsed(view);
  const chipsEl = card.querySelector(".chips")!;
  if (chipsEl.childNodes.length === 0) chipsEl.append(el("span", "chip"));
  const label = view.worktree ? `${view.project} · ${view.worktree}` : view.project;
  if (chipsEl.firstChild!.textContent !== label) chipsEl.firstChild!.textContent = label;
  renderHits(card.querySelector(".hits")!, query === "" ? undefined : hits.get(view.id));
}

/** The sessions that are not running, collapsed under the live ones; open while a search has matches among them. */
function renderEarlier(after: HTMLElement): void {
  const shown = query === "" ? past : past.filter((view) => hits.has(view.id));
  if (shown.length === 0) {
    earlierEl?.remove();
    earlierEl = undefined;
    for (const card of pastCards.values()) card.remove();
    pastCards.clear();
    return;
  }
  const open = earlierOpen || query !== "";
  if (!earlierEl) {
    earlierEl = el("section", "group group-past");
    const heading = el("h2", "heading");
    heading.title = "Sessions that are not running. Click to show or hide them; a click on one resumes it in the agent's panel.";
    heading.append(el("i", "chev", "▸"), el("span", "label", "Earlier"), el("span", "count"));
    heading.addEventListener("click", () => {
      earlierOpen = !earlierOpen;
      vscode.setState({ hidden: [...hidden], earlier: earlierOpen });
      render();
    });
    earlierEl.append(heading, el("div", "cards"));
  }
  earlierEl.classList.toggle("open", open);
  earlierEl.querySelector(".count")!.textContent = query === "" ? String(shown.length) : `${shown.length} of ${past.length}`;
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
    earlierEl?.remove();
    earlierEl = undefined;
    pastCards.clear();
    const empty = el("div", "nothing");
    if (query !== "") empty.append(el("p", "big", search.classList.contains("searching") ? "Searching…" : "No conversation mentions that"), el("p", "small", "Every word must appear in one message. Esc clears the search."));
    else if (allSessions.length > 0) empty.append(el("p", "big", "Everything is hidden"), el("p", "small", "Click a state in the legend to show it again."));
    else empty.append(el("p", "big", "Nothing on the horizon"), el("p", "small", "Sessions appear here as soon as an agent starts."));
    root.append(empty);
    return;
  }
  const seenIds = new Set<string>();
  const seenGroups = new Set<string>();
  let previousGroup: HTMLElement = beam;
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
        all.addEventListener("click", () => vscode.postMessage({ type: "seenAll" }));
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
    if (card) card.querySelector(".elapsed")!.textContent = elapsedText(view);
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
  allSessions = message.sessions;
  past = message.past ?? [];
  usage = message.usage;
  clockOffset = message.now - Date.now();
  applyFilters();
  render();
  // The conversations go on; keep an open search current.
  if (query !== "") vscode.postMessage({ type: "search", query });
});

setInterval(tick, 1000);
vscode.postMessage({ type: "ready" });
