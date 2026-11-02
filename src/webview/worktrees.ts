/// <reference lib="dom" />
import { formatBytes } from "../core/format";
import { agoOf, clock, filterWords, matchesFilter, nextTicks, plural, SECTIONS, sortRows, type Section, type SortBy } from "./worktreesModel";
import type { FromWorktrees, RemovedRow, RepoRow, ToWorktrees, WorktreeRow, WorktreesState } from "./worktreesProtocol";

declare function acquireVsCodeApi(): { postMessage(message: FromWorktrees): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A button; `focusKey` names it across renders, so the keyboard's place survives one. */
function button(className: string, text: string, title: string, onClick: () => void, focusKey?: string): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.title = title;
  if (focusKey) b.dataset.focus = focusKey;
  b.addEventListener("click", onClick);
  return b;
}

function tickBox(label: string, focusKey: string, onChange: (checked: boolean) => void): HTMLInputElement {
  const box = el("input", "tick");
  box.type = "checkbox";
  box.setAttribute("aria-label", label);
  box.dataset.focus = focusKey;
  box.addEventListener("change", () => onChange(box.checked));
  return box;
}

const SVG = "http://www.w3.org/2000/svg";
const FOLDER = "M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H7.6L6.2 3.9a1 1 0 0 0-.7-.3H2.5a1 1 0 0 0-1 .9z";
const LENS = "M6.5 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10 10l4 4";

/** A line icon, decorative: the button or field it sits in says what it is. */
function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}

let state: WorktreesState = { repos: [], rows: [], removed: [] };
/** The rows ticked for removal, by folder. */
let ticked = new Set<string>();
/** The check the ticks were set for. */
let tickedFor: number | undefined;
/** The removal whose refused rows were unticked. */
let summaryFor: number | undefined;
/** The filter's words and the order, as the controls stand. */
let words: string[] = [];
let sortBy: SortBy = "size";
/** Stop was pressed and the check has not ended yet. */
let stopping = false;
/** Folded sections and repository groups, by key; the ones folded by default start in it. */
const folded = new Set<string>(["section:keep"]);
const unfolded = new Set<string>();

function isFolded(key: string, byDefault: boolean): boolean {
  return byDefault ? !unfolded.has(key) : folded.has(key);
}

function toggleFold(key: string, byDefault: boolean): void {
  const set = byDefault ? unfolded : folded;
  if (set.has(key)) set.delete(key);
  else set.add(key);
  render();
}

// The top: what was checked, when, and the way to check again.

const top = el("header", "top");
const eyebrow = el("div", "eyebrow", "Worktrees");
const title = el("h1", "title", "Clean up worktrees");
const where = el("div", "where");
const tools = el("div", "tools");
const checkButton = button("tool", "Check again", "Look at every worktree again", () => vscode.postMessage({ type: "check" }), "check");
const settingsButton = button("tool", "Settings", "Where Lookout looks, and what a tool builds again", () => vscode.postMessage({ type: "settings" }), "settings");
tools.append(checkButton, settingsButton);
top.append(eyebrow, title, where, tools);

const progress = el("div", "progress");
const progressLine = el("div", "progress-line");
const progressText = el("div", "progress-text");
const stopButton = button(
  "tool stop",
  "Stop",
  "Stop the check; the rows stay from the one before",
  () => {
    stopping = true;
    stopButton.disabled = true;
    vscode.postMessage({ type: "stop" });
  },
  "stop",
);
progressLine.append(progressText, stopButton);
const bar = el("div", "bar");
const barFill = el("div", "bar-fill");
bar.append(barFill);
progress.append(progressLine, bar);

const banner = el("section", "banner");

// The filter and the order, above the rows.

const controls = el("div", "controls");
const field = el("label", "field");
field.append(icon(LENS));
const filterInput = el("input", "");
filterInput.type = "search";
filterInput.placeholder = "Filter by name, branch, reason or folder";
filterInput.setAttribute("aria-label", "Filter the worktrees by name, branch, reason or folder");
filterInput.spellcheck = false;
filterInput.dataset.focus = "filter";
let renderQueued = false;
filterInput.addEventListener("input", () => {
  words = filterWords(filterInput.value);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
});
field.append(filterInput);
const sortSelect = el("select", "sort");
sortSelect.setAttribute("aria-label", "Order");
sortSelect.title = "The order inside each repository";
for (const [value, label] of [
  ["size", "Biggest first"],
  ["age", "Oldest commit first"],
] as const) {
  const option = el("option", "", label);
  option.value = value;
  sortSelect.append(option);
}
sortSelect.dataset.focus = "sort";
sortSelect.addEventListener("change", () => {
  sortBy = sortSelect.value === "age" ? "age" : "size";
  render();
});
controls.append(field, sortSelect);

/** The removed worktrees, under the summary and above the filter, which is for the rows below it. */
const removedHost = el("div", "removed-host");
const body = el("main", "sections");

const foot = el("footer", "foot");
/** How far the work got, along the bar's top edge, for a page scrolled away from the top. */
const footBar = el("div", "foot-bar");
const footText = el("span", "foot-text");
const removeButton = button(
  "remove",
  "Remove",
  "Remove the ticked worktrees",
  () => {
    const paths = [...ticked].filter((p) => state.rows.some((row) => row.path === p && row.tier !== "keep"));
    if (paths.length) vscode.postMessage({ type: "remove", paths });
  },
  "remove",
);
foot.append(footBar, footText, removeButton);

root.append(top, progress, banner, removedHost, controls, body, foot);

function renderTop(): void {
  const repos = state.repos.length;
  const worktrees = state.rows.length;
  where.textContent =
    state.checkedAt === undefined
      ? state.busy === "check"
        ? "Looking for repositories and their worktrees…"
        : "Not checked yet."
      : `${plural(worktrees, "worktree")} in ${plural(repos, "repository", "repositories")} · checked ${clock(state.checkedAt)}`;
  checkButton.disabled = state.busy !== undefined;
  controls.classList.toggle("hidden", state.checkedAt === undefined);
}

function renderProgress(): void {
  const p = state.progress;
  progress.classList.toggle("hidden", !state.busy);
  if (!state.busy) return;
  progressText.textContent = stopping ? "Stopping…" : workLine();
  barFill.style.width = p && p.total ? `${Math.round((100 * p.done) / p.total)}%` : "0%";
  stopButton.classList.toggle("hidden", state.busy !== "check");
  stopButton.disabled = stopping;
}

function renderBanner(): void {
  banner.replaceChildren();
  const s = state.summary;
  if (s) {
    const parts = [
      s.removed ? `Freed ${formatBytes(s.freedBytes)} from ${plural(s.removed, "worktree")}` : "",
      s.records ? `${plural(s.records, "record")} cleared` : "",
      s.branchesDeleted ? `${plural(s.branchesDeleted, "landed branch", "landed branches")} deleted` : "",
    ].filter(Boolean);
    const done = el("div", "done", parts.length ? parts.join(" · ") : "Nothing was removed.");
    done.append(el("span", "when", clock(s.at)));
    banner.append(done);
    if (s.freeSpaceGrew !== undefined && s.removed) {
      banner.append(el("div", "aside", `Free space on the disk grew by ${formatBytes(Math.max(0, s.freeSpaceGrew))} meanwhile; anything else writing to it counts too.`));
    }
    if (s.failed.length) {
      const failed = el("div", "failed");
      failed.append(el("div", "failed-head", `${plural(s.failed.length, "was", "were")} not removed, and ${s.failed.length === 1 ? "shows" : "show"} below as ${s.failed.length === 1 ? "it stands" : "they stand"} now:`));
      const list = el("ul", "failed-list");
      for (const f of s.failed) {
        const item = el("li", "");
        item.append(el("strong", "", f.name), document.createTextNode(` — ${f.error}`));
        list.append(item);
      }
      failed.append(list);
      banner.append(failed);
    }
    banner.append(button("dismiss", "×", "Dismiss", () => vscode.postMessage({ type: "dismiss" }), "dismiss"));
  }
  if (state.notice) banner.append(el("div", "notice", state.notice));
  if (state.error) banner.append(el("div", "error", state.error));
  banner.classList.toggle("hidden", !banner.childElementCount);
}

function repoInfo(repo: string): RepoRow | undefined {
  return state.repos.find((info) => info.repo === repo);
}

// The ticks: a change touches only the boxes, the All/None buttons and the foot, never the page.

/** The row boxes by folder, the group boxes with their folders, and the All/None buttons with theirs, from the last render. */
let rowBoxes = new Map<string, HTMLInputElement>();
let groupBoxes: { box: HTMLInputElement; paths: string[] }[] = [];
let allButtons: { button: HTMLButtonElement; paths: string[] }[] = [];

function setTicked(paths: readonly string[], on: boolean): void {
  for (const p of paths) {
    if (on) ticked.add(p);
    else ticked.delete(p);
  }
  syncTicks();
}

function syncTicks(): void {
  for (const [p, box] of rowBoxes) box.checked = ticked.has(p);
  for (const group of groupBoxes) {
    const n = group.paths.filter((p) => ticked.has(p)).length;
    group.box.checked = n > 0 && n === group.paths.length;
    group.box.indeterminate = n > 0 && n < group.paths.length;
  }
  for (const all of allButtons) {
    const every = all.paths.every((p) => ticked.has(p));
    all.button.textContent = every ? "None" : "All";
    all.button.title = every ? "Untick them all" : "Tick them all";
  }
  renderFoot();
}

function rowView(row: WorktreeRow, now: number, tickable: boolean): HTMLElement {
  const line = el("div", `row tier-${row.tier}`);
  if (tickable) {
    const box = tickBox(`Remove ${row.name}`, `tick:${row.path}`, (checked) => setTicked([row.path], checked));
    box.checked = ticked.has(row.path);
    rowBoxes.set(row.path, box);
    line.append(box);
  } else {
    line.append(el("span", "tick-none"));
  }
  const main = el("div", `main${tickable ? " tickable" : ""}`);
  if (tickable) {
    // A click on the row ticks it; its buttons keep their own work.
    main.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("button, a, input")) return;
      setTicked([row.path], !ticked.has(row.path));
    });
  }
  const head = el("div", "head");
  const name = el("span", "name", row.name);
  name.title = row.path;
  head.append(name);
  if (row.tier !== "gone") {
    const reveal = button("reveal", "", `Show ${row.path} in the file manager`, () => vscode.postMessage({ type: "reveal", path: row.path }), `reveal:${row.path}`);
    reveal.setAttribute("aria-label", `Show ${row.name} in the file manager`);
    reveal.append(icon(FOLDER));
    head.append(reveal);
  }
  if (row.branch && row.branch !== row.name) head.append(el("span", "branch", `⎇ ${row.branch}`));
  if (row.where) {
    const at = el("span", "at", `in ${row.where}`);
    at.title = row.path;
    head.append(at);
  }
  if (row.landed && row.tier !== "keep") head.append(el("span", "chip", "branch goes too"));
  main.append(head, el("div", "reason", row.reason));
  if (row.ignored?.length) main.append(el("div", "ignored", `Goes with it: ${row.ignored.join(", ")}`));
  line.append(main);
  const size = el("div", "size", row.tier === "gone" ? "—" : formatBytes(row.ownBytes));
  if (row.sharedBytes) {
    const shared = el("div", "shared", `+${formatBytes(row.sharedBytes)} shared`);
    shared.title = `${formatBytes(row.sharedBytes)} of files linked from elsewhere too (a package store), which stay`;
    size.append(shared);
  }
  line.append(size);
  const age = el("div", "age", row.headAt ? agoOf(row.headAt, now) : "");
  if (row.headAt) age.title = `Last commit ${new Date(row.headAt).toLocaleString()}`;
  line.append(age);
  return line;
}

/** The column names over a section's rows. */
function colsView(): HTMLElement {
  const cols = el("div", "cols");
  cols.setAttribute("aria-hidden", "true");
  cols.append(el("span", "", ""), el("span", "", "Worktree"), el("span", "col-size", "Size"), el("span", "col-age", "Last commit"));
  return cols;
}

function sectionView(section: Section, all: WorktreeRow[], rows: WorktreeRow[], now: number): HTMLElement {
  const box = el("section", `section tier-${section.tier}`);
  const key = `section:${section.tier}`;
  const shut = isFolded(key, false);
  const bytes = rows.reduce((sum, row) => sum + row.ownBytes, 0);
  const head = el("div", "section-head");
  const fold = button("fold", `${shut ? "▸" : "▾"} ${section.title}`, shut ? "Show them" : "Hide them", () => toggleFold(key, false), `fold:${key}`);
  fold.setAttribute("aria-expanded", String(!shut));
  const count = section.tier === "gone" ? plural(rows.length, "record") : `${rows.length} · ${formatBytes(bytes)}`;
  head.append(fold, el("span", "count", words.length && rows.length !== all.length ? `${count} of ${all.length}` : count));
  const tickable = section.tier !== "keep";
  if (tickable) {
    const paths = rows.map((row) => row.path);
    const all = button("all", "All", "Tick them all", () => setTicked(paths, !paths.every((p) => ticked.has(p))), `all:${section.tier}`);
    allButtons.push({ button: all, paths });
    head.append(all);
  }
  box.append(head);
  if (shut) return box;
  box.append(el("p", "about", section.about));
  if (section.tier !== "gone") box.append(colsView());
  // A group per repository, the one with the most to give back first.
  const byRepo = new Map<string, WorktreeRow[]>();
  for (const row of rows) byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
  const groups = [...byRepo].sort((a, b) => b[1].reduce((s, r) => s + r.ownBytes, 0) - a[1].reduce((s, r) => s + r.ownBytes, 0) || a[0].localeCompare(b[0]));
  for (const [repo, list] of groups) {
    const info = repoInfo(repo);
    const groupKey = `${section.tier}:${repo}`;
    // A filter opens every group, so its matches show.
    const groupShut = !words.length && isFolded(groupKey, section.foldRepos && groups.length > 1);
    const group = el("div", "group");
    const ghead = el("div", "group-head");
    if (tickable) {
      const paths = list.map((row) => row.path);
      const box = tickBox(`Remove every worktree of ${info?.name ?? repo} here`, `gtick:${groupKey}`, (checked) => setTicked(paths, checked));
      groupBoxes.push({ box, paths });
      ghead.append(box);
    } else {
      ghead.append(el("span", "tick-none"));
    }
    const gfold = button("group-name", `${groupShut ? "▸" : "▾"} ${info?.name ?? repo}`, repo, () => toggleFold(groupKey, section.foldRepos && groups.length > 1), `fold:${groupKey}`);
    gfold.setAttribute("aria-expanded", String(!groupShut));
    ghead.append(gfold, el("span", "group-count", section.tier === "gone" ? plural(list.length, "record") : `${list.length} · ${formatBytes(list.reduce((s, r) => s + r.ownBytes, 0))}`));
    if (info && section.tier !== "gone") {
      const fetched = el("span", "fetched", info.fetchedAt ? `fetched ${agoOf(info.fetchedAt, now)} ago` : "never fetched");
      fetched.title = info.defaultRef ? `"Already on" means on ${info.defaultRef}; "on a remote" is as of this fetch` : "No default branch found: only commits on a remote count, as of this fetch";
      ghead.append(fetched);
    }
    group.append(ghead);
    if (!groupShut) for (const row of sortRows(list, sortBy)) group.append(rowView(row, now, tickable));
    box.append(group);
  }
  return box;
}

function removedView(rows: RemovedRow[], now: number): HTMLElement {
  const box = el("section", "section removed");
  const key = "section:removed";
  // Folded until a removal or a restore brings it up.
  const shut = isFolded(key, !state.summary && !state.notice);
  const head = el("div", "section-head");
  const fold = button("fold", `${shut ? "▸" : "▾"} Removed`, shut ? "Show them" : "Hide them", () => toggleFold(key, !state.summary && !state.notice), `fold:${key}`);
  fold.setAttribute("aria-expanded", String(!shut));
  head.append(fold, el("span", "count", `${plural(rows.length, "worktree")} · can be put back`));
  box.append(head);
  if (shut) return box;
  box.append(el("p", "about", "Put back where it was, on its branch; its ignored files (dependencies, build output) are not."));
  for (const row of rows) {
    const line = el("div", "row");
    line.append(el("span", "tick-none"));
    const main = el("div", "main");
    const headLine = el("div", "head");
    headLine.append(el("span", "name", row.name));
    if (row.branch && row.branch !== row.name) headLine.append(el("span", "branch", `⎇ ${row.branch}`));
    main.append(headLine, el("div", "reason", `removed ${agoOf(row.removedAt, now)} ago${row.branchDeleted ? ", with its branch" : ""} · ${row.path}`));
    line.append(main);
    const restore = button("restore", "Put back", `Make ${row.path} again`, () => vscode.postMessage({ type: "restore", path: row.path }), `restore:${row.path}`);
    restore.disabled = state.busy !== undefined;
    line.append(restore);
    box.append(line);
  }
  return box;
}

/** What runs, in a few words, with how far it got: "Removing 37 of 421 · ops-4741 · 6.1 GB back so far". */
function workLine(): string {
  const p = state.progress;
  const verb = state.busy === "check" ? "Checking" : state.busy === "remove" ? "Removing" : "Putting back";
  if (!p || !p.total) return `${verb}…`;
  const at = p.current ? ` · ${p.current.split(/[\\/]/).pop()}` : "";
  const back = state.busy === "remove" && p.freedBytes ? ` · ${formatBytes(p.freedBytes)} back so far` : "";
  return `${verb} ${Math.min(p.done + 1, p.total)} of ${p.total}${at}${back}`;
}

function renderFoot(): void {
  foot.classList.toggle("busy", state.busy !== undefined);
  foot.classList.toggle("removing", state.busy === "remove");
  if (state.busy) {
    const p = state.progress;
    footText.textContent = stopping ? "Stopping…" : workLine();
    footBar.style.width = p && p.total ? `${Math.round((100 * p.done) / p.total)}%` : "0%";
    removeButton.textContent = state.busy === "remove" ? "Removing…" : "Remove";
    removeButton.disabled = true;
    foot.classList.toggle("hidden", state.checkedAt === undefined);
    return;
  }
  footBar.style.width = "0%";
  const picked = state.rows.filter((row) => ticked.has(row.path) && row.tier !== "keep");
  const trees = picked.filter((row) => row.tier !== "gone");
  const review = trees.filter((row) => row.tier === "review").length;
  const records = picked.length - trees.length;
  const bytes = trees.reduce((sum, row) => sum + row.ownBytes, 0);
  const parts = [trees.length ? `${plural(trees.length, "worktree")} · ${formatBytes(bytes)}${review ? ` · ${review} for review` : ""}` : "", records ? plural(records, "record") : ""].filter(Boolean);
  footText.textContent = parts.length ? `Ticked: ${parts.join(" and ")}` : "Nothing ticked.";
  removeButton.textContent = picked.length ? `Remove ${picked.length}` : "Remove";
  removeButton.disabled = !picked.length || state.busy !== undefined;
  foot.classList.toggle("hidden", state.checkedAt === undefined);
}

function render(): void {
  const now = Date.now();
  // The keyboard's place: the control it was on is made again, and found by its name.
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
  renderTop();
  renderProgress();
  renderBanner();
  rowBoxes = new Map();
  groupBoxes = [];
  allButtons = [];
  removedHost.replaceChildren();
  if (state.removed.length) removedHost.append(removedView(state.removed, now));
  body.replaceChildren();
  if (state.checkedAt !== undefined) {
    let shown = 0;
    for (const section of SECTIONS) {
      const all = state.rows.filter((row) => row.tier === section.tier);
      const rows = words.length ? all.filter((row) => matchesFilter(row, words, repoInfo(row.repo)?.name)) : all;
      if (!rows.length) continue;
      shown += rows.length;
      body.append(sectionView(section, all, rows, now));
    }
    if (!state.rows.length) body.append(el("p", "empty", "No linked worktrees in the repositories Lookout found. The settings say where it looks."));
    else if (!shown) body.append(el("p", "empty", "No worktree matches the filter."));
  }
  syncTicks();
  if (active && active !== document.activeElement?.getAttribute("data-focus")) {
    const again = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(active)}"]`);
    again?.focus({ preventScroll: true });
  }
}

window.addEventListener("message", (event: MessageEvent<ToWorktrees>) => {
  const message = event.data;
  // How far the work got: the bars and the foot, not the rows.
  if (message?.type === "progress") {
    state = { ...state, progress: message.progress };
    renderProgress();
    renderFoot();
    return;
  }
  if (message?.type !== "state") return;
  const before = state;
  state = message.state;
  // A new check ticks what is safe and the records of folders that are gone, and keeps the ticks of rows it left where they were.
  if (state.checkedAt !== undefined && state.checkedAt !== tickedFor) {
    tickedFor = state.checkedAt;
    ticked = nextTicks(before.rows, state.rows, ticked);
  }
  // What a removal refused is ticked no more: it shows as it stands now.
  if (state.summary && state.summary.at !== summaryFor) {
    summaryFor = state.summary.at;
    for (const f of state.summary.failed) ticked.delete(f.path);
  }
  // What went is ticked no more.
  const present = new Set(state.rows.map((row) => row.path));
  for (const p of [...ticked]) if (!present.has(p)) ticked.delete(p);
  if (!state.busy) stopping = false;
  render();
});

render();
vscode.postMessage({ type: "ready" });
