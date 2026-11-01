/// <reference lib="dom" />
import { formatBytes } from "../core/format";
import type { FromWorktrees, RemovedRow, RepoRow, ToWorktrees, WorktreeRow, WorktreesState, WorktreeTierView } from "./worktreesProtocol";

declare function acquireVsCodeApi(): { postMessage(message: FromWorktrees): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, short: "5m", "3h", "26d", "4mo", "2y". */
export function agoOf(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)}h`;
  if (ms < 60 * DAY) return `${Math.round(ms / DAY)}d`;
  if (ms < 730 * DAY) return `${Math.round(ms / (30 * DAY))}mo`;
  return `${Math.round(ms / (365 * DAY))}y`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The sections of the page, in order: what each tier is called and what it means. */
const SECTIONS: { tier: WorktreeTierView; title: string; about: string; ticked: boolean; foldRepos: boolean }[] = [
  {
    tier: "safe",
    title: "Safe to remove",
    about: "Nothing in them is lost: no change, no untracked file, only ignored files a tool builds again, and every commit already on the default branch or on a remote. None has had git work in it in the last day.",
    ticked: true,
    foldRepos: true,
  },
  {
    tier: "review",
    title: "For review",
    about: "Each can go, and its commits stay in its branch; read why it is here first.",
    ticked: false,
    foldRepos: false,
  },
  {
    tier: "gone",
    title: "Records with no folder",
    about: "Git still lists them, and keeps their branches checked out, but their folders are gone. Clearing a record frees no space.",
    ticked: true,
    foldRepos: false,
  },
  {
    tier: "keep",
    title: "Kept",
    about: "In use, or holding work only they have: Lookout does not remove them.",
    ticked: false,
    foldRepos: false,
  },
];

let state: WorktreesState = { repos: [], rows: [], removed: [] };
/** The rows ticked for removal, by folder: set afresh on each new check. */
let ticked = new Set<string>();
/** The check the ticks were set for. */
let tickedFor: number | undefined;
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
const checkButton = button("tool", "Check again", "Look at every worktree again", () => vscode.postMessage({ type: "check" }));
const settingsButton = button("tool quiet", "Settings", "Where Lookout looks, and what a tool builds again", () => vscode.postMessage({ type: "settings" }));
tools.append(checkButton, settingsButton);
top.append(eyebrow, title, where, tools);

const progress = el("div", "progress");
const progressText = el("div", "progress-text");
const bar = el("div", "bar");
const barFill = el("div", "bar-fill");
bar.append(barFill);
progress.append(progressText, bar);

const banner = el("section", "banner");
const body = el("main", "sections");

const foot = el("footer", "foot");
const footText = el("span", "foot-text");
const removeButton = button("remove", "Remove", "Remove the ticked worktrees", () => {
  const paths = [...ticked].filter((p) => state.rows.some((row) => row.path === p && row.tier !== "keep"));
  if (paths.length) vscode.postMessage({ type: "remove", paths });
});
foot.append(footText, removeButton);

root.append(top, progress, banner, body, foot);

function renderTop(): void {
  const repos = state.repos.length;
  const worktrees = state.rows.length;
  where.textContent =
    state.checkedAt === undefined
      ? state.busy === "check"
        ? "Looking for repositories and their worktrees…"
        : "Not checked yet."
      : `${plural(worktrees, "worktree")} in ${plural(repos, "repository", "repositories")} · checked ${clock(state.checkedAt)} · "on a remote" is as of each repository's last fetch`;
  checkButton.disabled = state.busy !== undefined;
}

function renderProgress(): void {
  const p = state.progress;
  progress.classList.toggle("hidden", !state.busy);
  if (!state.busy) return;
  const verb = state.busy === "check" ? "Checking" : state.busy === "remove" ? "Removing" : "Putting back";
  const at = p?.current ? ` · ${p.current.split(/[\\/]/).pop()}` : "";
  progressText.textContent = p && p.total ? `${verb} ${Math.min(p.done + 1, p.total)} of ${p.total}${at}` : `${verb}…`;
  barFill.style.width = p && p.total ? `${Math.round((100 * p.done) / p.total)}%` : "0%";
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
    banner.append(done);
    if (s.freeSpaceGrew !== undefined && s.removed) {
      banner.append(el("div", "aside", `Free space on the disk grew by ${formatBytes(Math.max(0, s.freeSpaceGrew))} meanwhile; anything else writing to it counts too.`));
    }
    if (s.failed.length) {
      const failed = el("div", "failed");
      failed.append(el("div", "failed-head", `${plural(s.failed.length, "was", "were")} not removed:`));
      const list = el("ul", "failed-list");
      for (const f of s.failed) {
        const item = el("li", "");
        item.append(el("strong", "", f.name), document.createTextNode(` — ${f.error}`));
        list.append(item);
      }
      failed.append(list);
      banner.append(failed);
    }
  }
  if (state.notice) banner.append(el("div", "notice", state.notice));
  if (state.error) banner.append(el("div", "error", state.error));
  banner.classList.toggle("hidden", !banner.childElementCount);
}

function repoInfo(repo: string): RepoRow | undefined {
  return state.repos.find((info) => info.repo === repo);
}

function rowView(row: WorktreeRow, now: number, tickable: boolean): HTMLElement {
  const line = el("div", `row tier-${row.tier}`);
  if (tickable) {
    const box = el("input", "tick");
    box.type = "checkbox";
    box.checked = ticked.has(row.path);
    box.setAttribute("aria-label", `Remove ${row.name}`);
    box.addEventListener("change", () => {
      if (box.checked) ticked.add(row.path);
      else ticked.delete(row.path);
      render();
    });
    line.append(box);
  } else {
    line.append(el("span", "tick-none"));
  }
  const main = el("div", "main");
  const head = el("div", "head");
  const name = button("name", row.name, `${row.path}\nShow it in the file manager`, () => vscode.postMessage({ type: "reveal", path: row.path }));
  name.disabled = row.tier === "gone";
  head.append(name);
  if (row.branch && row.branch !== row.name) head.append(el("span", "branch", `⎇ ${row.branch}`));
  if (row.landed && row.tier !== "keep") head.append(el("span", "chip", "branch goes too"));
  main.append(head, el("div", "reason", row.reason));
  if (row.ignored?.length) main.append(el("div", "ignored", `Goes with it: ${row.ignored.join(", ")}`));
  line.append(main);
  const size = el("div", "size", row.tier === "gone" ? "—" : formatBytes(row.ownBytes));
  if (row.sharedBytes) size.title = `Plus ${formatBytes(row.sharedBytes)} of files linked from elsewhere too (a package store), which stay`;
  line.append(size);
  const age = el("div", "age", row.headAt ? agoOf(row.headAt, now) : "");
  if (row.headAt) age.title = `Last commit ${new Date(row.headAt).toLocaleString()}`;
  line.append(age);
  return line;
}

function sectionView(section: (typeof SECTIONS)[number], rows: WorktreeRow[], now: number): HTMLElement {
  const box = el("section", `section tier-${section.tier}`);
  const key = `section:${section.tier}`;
  const shut = isFolded(key, false);
  const bytes = rows.reduce((sum, row) => sum + row.ownBytes, 0);
  const head = el("div", "section-head");
  const fold = button("fold", `${shut ? "▸" : "▾"} ${section.title}`, shut ? "Show them" : "Hide them", () => toggleFold(key, false));
  head.append(fold, el("span", "count", section.tier === "gone" ? plural(rows.length, "record") : `${rows.length} · ${formatBytes(bytes)}`));
  const tickable = section.tier !== "keep";
  if (tickable) {
    const all = rows.every((row) => ticked.has(row.path));
    head.append(
      button("all", all ? "None" : "All", all ? "Untick them all" : "Tick them all", () => {
        for (const row of rows) {
          if (all) ticked.delete(row.path);
          else ticked.add(row.path);
        }
        render();
      }),
    );
  }
  box.append(head);
  if (shut) return box;
  box.append(el("p", "about", section.about));
  // A group per repository, the one with the most to give back first.
  const byRepo = new Map<string, WorktreeRow[]>();
  for (const row of rows) byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
  const groups = [...byRepo].sort((a, b) => b[1].reduce((s, r) => s + r.ownBytes, 0) - a[1].reduce((s, r) => s + r.ownBytes, 0) || a[0].localeCompare(b[0]));
  for (const [repo, list] of groups) {
    const info = repoInfo(repo);
    const groupKey = `${section.tier}:${repo}`;
    const groupShut = isFolded(groupKey, section.foldRepos && groups.length > 1);
    const group = el("div", "group");
    const ghead = el("div", "group-head");
    if (tickable) {
      const all = el("input", "tick");
      all.type = "checkbox";
      const n = list.filter((row) => ticked.has(row.path)).length;
      all.checked = n === list.length;
      all.indeterminate = n > 0 && n < list.length;
      all.setAttribute("aria-label", `Remove every worktree of ${info?.name ?? repo} here`);
      all.addEventListener("change", () => {
        for (const row of list) {
          if (all.checked) ticked.add(row.path);
          else ticked.delete(row.path);
        }
        render();
      });
      ghead.append(all);
    } else {
      ghead.append(el("span", "tick-none"));
    }
    ghead.append(
      button("group-name", `${groupShut ? "▸" : "▾"} ${info?.name ?? repo}`, repo, () => toggleFold(groupKey, section.foldRepos && groups.length > 1)),
      el("span", "group-count", section.tier === "gone" ? plural(list.length, "record") : `${list.length} · ${formatBytes(list.reduce((s, r) => s + r.ownBytes, 0))}`),
    );
    if (info && section.tier !== "gone") {
      const fetched = el("span", "fetched", info.fetchedAt ? `fetched ${agoOf(info.fetchedAt, now)} ago` : "never fetched");
      fetched.title = info.defaultRef ? `"Already on" means on ${info.defaultRef}` : "No default branch found: only commits on a remote count";
      ghead.append(fetched);
    }
    group.append(ghead);
    if (!groupShut) for (const row of list) group.append(rowView(row, now, tickable));
    box.append(group);
  }
  return box;
}

function removedView(rows: RemovedRow[], now: number): HTMLElement {
  const box = el("section", "section removed");
  const key = "section:removed";
  const shut = isFolded(key, false);
  const head = el("div", "section-head");
  head.append(button("fold", `${shut ? "▸" : "▾"} Removed`, shut ? "Show them" : "Hide them", () => toggleFold(key, false)), el("span", "count", plural(rows.length, "worktree")));
  box.append(head);
  if (shut) return box;
  box.append(el("p", "about", "Put back where it was, on its branch; its ignored files (dependencies, build output) are not."));
  for (const row of rows) {
    const line = el("div", "row");
    line.append(el("span", "tick-none"));
    const main = el("div", "main");
    const headLine = el("div", "head");
    headLine.append(el("span", "name plain", row.name));
    if (row.branch) headLine.append(el("span", "branch", `⎇ ${row.branch}`));
    main.append(headLine, el("div", "reason", `removed ${agoOf(row.removedAt, now)} ago${row.branchDeleted ? ", with its branch" : ""} · ${row.path}`));
    line.append(main);
    const restore = button("restore", "Put back", `Make ${row.path} again`, () => vscode.postMessage({ type: "restore", path: row.path }));
    restore.disabled = state.busy !== undefined;
    line.append(restore);
    box.append(line);
  }
  return box;
}

function renderFoot(): void {
  const picked = state.rows.filter((row) => ticked.has(row.path) && row.tier !== "keep");
  const trees = picked.filter((row) => row.tier !== "gone");
  const records = picked.length - trees.length;
  const bytes = trees.reduce((sum, row) => sum + row.ownBytes, 0);
  const parts = [trees.length ? `${plural(trees.length, "worktree")} · ${formatBytes(bytes)}` : "", records ? plural(records, "record") : ""].filter(Boolean);
  footText.textContent = parts.length ? `Ticked: ${parts.join(" and ")}` : "Nothing ticked.";
  removeButton.textContent = picked.length ? `Remove ${picked.length}` : "Remove";
  removeButton.disabled = !picked.length || state.busy !== undefined;
  foot.classList.toggle("hidden", state.checkedAt === undefined);
}

function render(): void {
  const now = Date.now();
  renderTop();
  renderProgress();
  renderBanner();
  body.replaceChildren();
  if (state.checkedAt !== undefined) {
    for (const section of SECTIONS) {
      const rows = state.rows.filter((row) => row.tier === section.tier);
      if (rows.length) body.append(sectionView(section, rows, now));
    }
    if (!state.rows.length) body.append(el("p", "empty", "No linked worktrees in the repositories Lookout found. The settings say where it looks."));
  }
  if (state.removed.length) body.append(removedView(state.removed, now));
  renderFoot();
}

window.addEventListener("message", (event: MessageEvent<ToWorktrees>) => {
  const message = event.data;
  if (message?.type !== "state") return;
  state = message.state;
  // A new check ticks what is safe, and the records of folders that are gone.
  if (state.checkedAt !== undefined && state.checkedAt !== tickedFor) {
    tickedFor = state.checkedAt;
    ticked = new Set(state.rows.filter((row) => SECTIONS.find((s) => s.tier === row.tier)?.ticked).map((row) => row.path));
  }
  // What went is ticked no more.
  const present = new Set(state.rows.map((row) => row.path));
  for (const p of [...ticked]) if (!present.has(p)) ticked.delete(p);
  render();
});

render();
vscode.postMessage({ type: "ready" });
