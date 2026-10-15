/// <reference lib="dom" />
import { formatElapsed, formatTokens, shortModel } from "../core/format";
import type { SessionView } from "../core/types";
import { BEAM, groupSessions, hostChip, layoutBlips, secondLine } from "./model";
import type { BoardUsage, FromBoard, ToBoard } from "./protocol";

declare function acquireVsCodeApi(): { postMessage(message: FromBoard): void };

const SVG = "http://www.w3.org/2000/svg";
const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

let sessions: SessionView[] = [];
let usage: BoardUsage | undefined;
/** The extension's clock minus ours, so elapsed times agree with the status bar. */
let clockOffset = 0;

const cards = new Map<string, HTMLElement>();
const groupsEl = new Map<string, HTMLElement>();
const blips = new Map<string, SVGGElement>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
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
  if (view.contextTokens) out.push(`${formatTokens(view.contextTokens)} tokens`);
  if (view.agents > 0) out.push(view.agents === 1 ? "1 agent" : `${view.agents} agents`);
  return out;
}

// The beam strip: the lighthouse, its sweeping beam, and one blip per session.

const beam = el("div", "beam");
const beamSvg = svg("svg", { viewBox: `0 0 ${BEAM.width} ${BEAM.height}`, preserveAspectRatio: "xMidYMax meet" });
beamSvg.setAttribute("aria-hidden", "true");
{
  const defs = svg("defs");
  const gradient = svg("radialGradient", { id: "light", cx: BEAM.originX, cy: BEAM.originY, r: BEAM.maxRadius + 12, gradientUnits: "userSpaceOnUse" });
  gradient.append(svg("stop", { offset: "0", "stop-color": "currentColor", "stop-opacity": "0.55" }));
  gradient.append(svg("stop", { offset: "1", "stop-color": "currentColor", "stop-opacity": "0" }));
  defs.append(gradient);
  beamSvg.append(defs);
  // Faint rings mark 1 minute, 10 minutes and an hour.
  const rings = svg("g", { class: "rings" });
  for (const minutes of [1, 10, 60]) {
    const t = Math.log10(1 + minutes) / Math.log10(241);
    const r = BEAM.minRadius + (BEAM.maxRadius - BEAM.minRadius) * t;
    rings.append(svg("path", { d: `M ${BEAM.originX - r} ${BEAM.originY} A ${r} ${r} 0 0 1 ${BEAM.originX + r} ${BEAM.originY}` }));
  }
  beamSvg.append(rings);
  const sweep = svg("g", { class: "sweep" });
  const reach = BEAM.maxRadius + 14;
  sweep.append(svg("path", { d: `M ${BEAM.originX} ${BEAM.originY} L ${BEAM.originX - reach * 0.32} ${BEAM.originY - reach} L ${BEAM.originX + reach * 0.32} ${BEAM.originY - reach} Z`, fill: "url(#light)" }));
  beamSvg.append(sweep);
  beamSvg.append(svg("g", { class: "blips" }));
  const tower = svg("g", { class: "tower" });
  tower.append(svg("path", { class: "body", d: `M ${BEAM.originX - 4} ${BEAM.height} L ${BEAM.originX - 2.5} ${BEAM.originY + 1} H ${BEAM.originX + 2.5} L ${BEAM.originX + 4} ${BEAM.height} Z` }));
  tower.append(svg("circle", { class: "lamp", cx: BEAM.originX, cy: BEAM.originY - 1, r: 2.6 }));
  beamSvg.append(tower);
}
beam.append(beamSvg);
const legend = el("div", "legend");
beam.append(legend);

function renderBeam(): void {
  const layout = layoutBlips(sessions, now());
  const list = beamSvg.querySelector(".blips")!;
  const seen = new Set<string>();
  for (const blip of layout) {
    seen.add(blip.id);
    let node = blips.get(blip.id);
    if (!node) {
      node = svg("g", { class: "blip" });
      node.append(svg("circle", { class: "halo", r: 7 }), svg("circle", { class: "dot", r: 3.2 }), svg("title"));
      node.addEventListener("click", () => vscode.postMessage({ type: "jump", id: blip.id }));
      blips.set(blip.id, node);
      list.append(node);
    }
    node.setAttribute("class", `blip state-${blip.state}`);
    node.setAttribute("transform", `translate(${blip.x} ${blip.y})`);
    node.querySelector("title")!.textContent = blip.title;
  }
  for (const [id, node] of blips) {
    if (seen.has(id)) continue;
    node.remove();
    blips.delete(id);
  }
  const counts = { waiting: 0, done: 0, working: 0, idle: 0 };
  for (const group of groupSessions(sessions)) counts[group.key] = group.views.length;
  legend.textContent = "";
  for (const [key, label] of [
    ["waiting", "need you"],
    ["done", "finished"],
    ["working", "working"],
    ["idle", "idle"],
  ] as const) {
    if (!counts[key]) continue;
    const item = el("span", `legend-item state-${key}`);
    item.append(el("i", "swatch"), el("b", "", String(counts[key])), el("span", "", ` ${label}`));
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
      bar.append(el("span", "fill"), el("span", "tick"));
      row.append(el("span", "label"), bar, el("span", "percent"), el("span", "reset"));
      meterRows.set(meter.key, row);
    }
    row.className = `meter ${meter.percent >= 95 ? "high" : meter.percent >= 80 ? "warn" : ""}`;
    row.querySelector(".label")!.textContent = meter.label;
    (row.querySelector(".fill") as HTMLElement).style.width = `${Math.min(100, Math.max(0, meter.percent))}%`;
    const tick = row.querySelector(".tick") as HTMLElement;
    // Where in the window we are: lets the burn rate be read against the fill.
    if (meter.resetsAt !== undefined && meter.windowMs) {
      const through = 1 - Math.min(1, Math.max(0, (meter.resetsAt - now()) / meter.windowMs));
      tick.style.left = `${Math.round(through * 100)}%`;
      tick.classList.remove("hidden");
    } else {
      tick.classList.add("hidden");
    }
    row.querySelector(".percent")!.textContent = `${meter.percent}%`;
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
    foot.append(el("span", "asof"));
    const refresh = el("button", "link", "refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => vscode.postMessage({ type: "refreshUsage" }));
    foot.append(refresh);
    meters.append(foot);
  }
  meters.append(foot);
  foot.querySelector(".asof")!.textContent = `Usage as of ${formatElapsed(now() - usage.fetchedAt)} ago${usage.stale ? ", stale" : ""}`;
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
  main.append(row, line, el("span", "chips"));
  card.append(main);
  const seen = el("span", "seen", "✓");
  seen.title = "Mark as seen";
  seen.setAttribute("role", "button");
  seen.addEventListener("click", (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: "seen", id: view.id });
  });
  card.append(seen);
  card.addEventListener("click", () => vscode.postMessage({ type: "jump", id: view.id }));
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
    if (!root.querySelector(".nothing")) {
      const nothing = el("div", "nothing");
      nothing.append(el("p", "big", "Nothing on the horizon"), el("p", "small", "Sessions appear here as soon as an agent starts."));
      root.append(nothing);
    }
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
  sessions = message.sessions;
  usage = message.usage;
  clockOffset = message.now - Date.now();
  render();
});

setInterval(tick, 1000);
vscode.postMessage({ type: "ready" });
