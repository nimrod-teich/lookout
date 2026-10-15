/// <reference lib="dom" />
import { formatElapsed, formatTokens, formatUsd, shortModel } from "../core/format";
import type { SessionView } from "../core/types";
import { Harbour } from "./harbour";
import { contextPercent, groupSessions, hostChip, isGroupKey, pulseBars, secondLine, type GroupKey } from "./model";
import type { BoardUsage, FromBoard, ToBoard } from "./protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: FromBoard): void;
  getState(): { hidden?: string[] } | undefined;
  setState(state: { hidden?: string[] }): void;
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
    meta.push(`${formatTokens(tokens)} tokens${view.spend.costUsd === undefined ? "" : ` · ${view.spend.estimated ? "~" : ""}${formatUsd(view.spend.costUsd)}`}`);
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

function applyFilters(): void {
  sessions = allSessions.filter((view) => !hidden.has(groupSessions([view])[0]!.key));
}

function toggleGroup(key: GroupKey): void {
  if (hidden.has(key)) hidden.delete(key);
  else hidden.add(key);
  vscode.setState({ hidden: [...hidden] });
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
  pulse.title = "Tool calls per minute, last 15 minutes";
  const chipsEl = el("span", "chips");
  const spend = el("span", "chip spend");
  main.append(row, line, pulse, chipsEl, spend);
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
  const remote = el("span", "action remote");
  remote.append(el("i", "knob"), el("span", "label", "Remote"));
  remote.setAttribute("role", "switch");
  remote.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "remote", id: view.id });
  });
  const seen = el("span", "action seen", "✓");
  seen.title = "Mark as seen";
  seen.setAttribute("role", "button");
  seen.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "seen", id: view.id });
  });
  actions.append(remote, rename, seen);
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
  const remote = card.querySelector(".action.remote")!;
  remote.classList.toggle("on", view.remote === true);
  remote.setAttribute("aria-checked", String(view.remote === true));
  remote.setAttribute("title", view.remote ? "Remote Control is on: reachable from claude.ai/code and the Claude app. Click to turn it off" : "Turn Remote Control on: drive this session from claude.ai/code or the Claude app");
  const line = card.querySelector(".line")!;
  const text = secondLine(view);
  line.querySelector(".mark")!.textContent = MARKS[view.state];
  line.querySelector(".text")!.textContent = text ?? "";
  line.classList.toggle("empty", text === undefined);
  const pulse = card.querySelector(".pulse") as HTMLElement;
  const bars = pulseBars(view.pulse);
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
    const cost = spend.costUsd === undefined ? "" : ` · ${spend.estimated ? "~" : ""}${formatUsd(spend.costUsd)}`;
    spendEl.textContent = `${spend.partial ? "≥ " : ""}${formatTokens(tokens)} tokens${cost}`;
    spendEl.title = [
      `Tokens this session: ${formatTokens(spend.input)} input, ${formatTokens(spend.output)} output, ${formatTokens(spend.cacheRead)} cache read, ${formatTokens(spend.cacheWrite)} cache write.`,
      spend.costUsd === undefined ? "No price for this model." : `API list price: ${formatUsd(spend.costUsd)}${spend.estimated ? ", part of it Lookout's estimate since the agent's last checkpoint (subagents since then not counted)" : ", the agent's own figure"}.`,
      spend.partial ? "Earlier usage is missing: Lookout joined this transcript late." : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const chipsEl = card.querySelector(".chips")!;
  const labels = chips(view);
  while (chipsEl.childNodes.length > labels.length) chipsEl.lastChild!.remove();
  labels.forEach((label, i) => {
    const chip = chipsEl.childNodes[i] ?? chipsEl.appendChild(el("span", "chip"));
    if (chip.textContent !== label) chip.textContent = label;
  });
}

function render(): void {
  if (!beam.isConnected) root.prepend(beam);
  if (!meters.isConnected) beam.append(meters);
  renderBeam();
  renderMeters();
  const groups = groupSessions(sessions);
  root.classList.toggle("empty", sessions.length === 0);
  if (sessions.length === 0) {
    for (const group of groupsEl.values()) group.remove();
    groupsEl.clear();
    cards.clear();
    root.querySelector(".nothing")?.remove();
    const nothing = el("div", "nothing");
    if (allSessions.length > 0) nothing.append(el("p", "big", "Everything is hidden"), el("p", "small", "Click a state in the legend to show it again."));
    else nothing.append(el("p", "big", "Nothing on the horizon"), el("p", "small", "Sessions appear here as soon as an agent starts."));
    root.append(nothing);
    return;
  }
  root.querySelector(".nothing")?.remove();
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
}

function tick(): void {
  if (document.visibilityState !== "visible") return;
  for (const view of sessions) {
    const card = cards.get(view.id);
    if (card) card.querySelector(".elapsed")!.textContent = elapsedText(view);
  }
  renderBeam();
  if (usage) renderMeters();
}

window.addEventListener("message", (event: MessageEvent<ToBoard>) => {
  const message = event.data;
  if (message.type !== "sessions") return;
  allSessions = message.sessions;
  usage = message.usage;
  clockOffset = message.now - Date.now();
  applyFilters();
  render();
});

setInterval(tick, 1000);
vscode.postMessage({ type: "ready" });
