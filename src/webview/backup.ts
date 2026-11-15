/// <reference lib="dom" />
import { formatBytes, formatElapsed } from "../core/format";
import type { SectionId } from "../core/transfer/types";
import { AGES, clock, count, countText, defaultChoice, LEVELS, PAGE_SECTIONS, passphraseProblem, plainWarning, SECTION_INFO, SHORT_PASSPHRASE, TRANSCRIPT_PARTS } from "./backupModel";
import type { BackupChoice, BackupState, Chosen, FromBackup, SectionRow, ToBackup } from "./backupProtocol";

declare function acquireVsCodeApi(): { postMessage(message: FromBackup): void };

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

function input(type: "checkbox" | "radio" | "password", id: string, className = ""): HTMLInputElement {
  const box = el("input", className);
  box.type = type;
  box.id = id;
  return box;
}

let state: BackupState = { host: "", sections: [], repos: [], zstd: true };
let choice: BackupChoice = defaultChoice();
/** Back Up was pressed and the extension has not answered yet. */
let pending = false;
/** Stop was pressed and the write has not ended yet. */
let stopping = false;
/** The repository list shows them all, not only the biggest. */
let allRepos = false;
/** The repositories shown before the fold. */
const REPOS_SHOWN = 6;

function send(): void {
  vscode.postMessage({ type: "choose", choice });
}

function rowOf(id: SectionId): SectionRow | undefined {
  return state.sections.find((row) => row.id === id);
}

function isOn(id: SectionId): boolean {
  return choice.sections.includes(id);
}

function setSection(id: SectionId, on: boolean): void {
  choice = { ...choice, sections: on ? [...choice.sections, id] : choice.sections.filter((other) => other !== id) };
  send();
  render();
}

/** The transcripts are narrowed: by age, or by a repository unticked. */
function narrowed(): boolean {
  return choice.days !== undefined || state.repos.some((repo) => choice.skipRepos.includes(repo.repo));
}

// The top: what there is, when it was looked at, and the way to look again.

const top = el("header", "top");
const where = el("div", "where");
const tools = el("div", "tools");
const lookButton = button("tool", "Look again", "Look at what there is to back up again", () => vscode.postMessage({ type: "look" }));
tools.append(lookButton);
top.append(el("div", "eyebrow", "Backup"), el("h1", "title", "Back up Lookout"), where, tools);

const progress = el("div", "progress");
const progressLine = el("div", "progress-line");
const progressText = el("div", "progress-text");
progressText.setAttribute("role", "status");
const stopButton = button("tool stop", "Stop", "Stop the backup; nothing is saved", () => {
  stopping = true;
  stopButton.disabled = true;
  vscode.postMessage({ type: "stop" });
});
progressLine.append(progressText, stopButton);
const bar = el("div", "bar");
bar.setAttribute("role", "progressbar");
bar.setAttribute("aria-label", "Backup progress");
const barFill = el("div", "bar-fill");
bar.append(barFill);
progress.append(progressLine, bar);

const banner = el("section", "banner");

// The form: a fieldset, so the whole of it is disabled while work runs.

const form = el("fieldset", "form");

interface ItemView {
  row: HTMLElement;
  box: HTMLInputElement;
  count: HTMLElement;
  size: HTMLElement;
}

const itemViews = new Map<SectionId, ItemView>();

function itemView(id: SectionId, part = false): ItemView {
  const info = SECTION_INFO[id];
  const row = el("div", part ? "item part" : "item");
  const box = input("checkbox", `section-${id}`, "tick");
  box.addEventListener("change", () => setSection(id, box.checked));
  const main = el("div", "item-main");
  const name = el("label", "item-name", info.title);
  name.htmlFor = box.id;
  const about = el("div", "item-about", info.about);
  about.id = `about-${id}`;
  main.append(name, about);
  const countEl = el("span", "item-count");
  countEl.id = `count-${id}`;
  const size = el("span", "item-size");
  size.id = `size-${id}`;
  box.setAttribute("aria-describedby", `${countEl.id} ${size.id} ${about.id}`);
  row.append(box, main, countEl, size);
  const view = { row, box, count: countEl, size };
  itemViews.set(id, view);
  return view;
}

const what = el("section", "block");
what.append(el("h2", "block-title", "What goes in"));
const list = el("div", "items");

// The transcripts, with their age filter, their two inclusions and their repositories.
const transcripts = itemView("transcripts");
const nest = el("div", "nest");
const ages = el("fieldset", "segments");
const agesLegend = el("legend", "nest-label", "Active");
agesLegend.title = "By when each session's transcript was last written";
ages.append(agesLegend);
const ageBoxes: HTMLInputElement[] = [];
for (const age of AGES) {
  const option = el("label", "segment");
  const radio = input("radio", `age-${age.days ?? "all"}`);
  radio.name = "age";
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    choice = { ...choice, ...(age.days ? { days: age.days } : {}) };
    if (!age.days) delete choice.days;
    send();
    render();
  });
  ageBoxes.push(radio);
  option.append(radio, el("span", "", age.label));
  ages.append(option);
}
const parts = TRANSCRIPT_PARTS.map((id) => itemView(id, true).row);
const reposHead = el("div", "repos-head");
const reposTitle = el("span", "nest-label", "Repositories");
reposTitle.id = "repos-title";
const reposAll = button("all", "None", "Untick them all", () => {
  const every = !choice.skipRepos.length;
  choice = { ...choice, skipRepos: every ? state.repos.map((repo) => repo.repo) : [] };
  send();
  render();
});
reposHead.append(reposTitle, reposAll);
const reposList = el("div", "repos");
reposList.setAttribute("role", "group");
reposList.setAttribute("aria-labelledby", reposTitle.id);
const reposMore = button("more", "", "", () => {
  allRepos = !allRepos;
  renderRepos();
});
nest.append(ages, ...parts, reposHead, reposList, reposMore);
list.append(transcripts.row, nest);
for (const id of PAGE_SECTIONS.filter((id) => id !== "transcripts")) list.append(itemView(id).row);
what.append(list);

// The compression.

const levels = el("fieldset", "block levels");
levels.append(el("legend", "block-title", "Compression"));
const levelOptions = el("div", "options");
const levelViews = LEVELS.map((level) => {
  const option = el("label", "option");
  const radio = input("radio", `level-${level.level}`);
  radio.name = "level";
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    choice = { ...choice, level: level.level };
    send();
    render();
  });
  const name = el("span", "option-name", level.label);
  const about = el("span", "option-about", level.about);
  const estimate = el("span", "option-estimate");
  option.append(radio, name, about, estimate);
  levelOptions.append(option);
  return { level: level.level, option, radio, about, estimate, title: level.about };
});
const levelNote = el("p", "note", "This VS Code's runtime has no zstd: the file is compressed with gzip, which makes it about twice as large.");
levels.append(levelOptions, levelNote);

// The passphrase. Its fields are the only place it is kept, and they are emptied once a write ends.

const secret = el("section", "block secret");
const secretTitle = el("h2", "block-title", "Passphrase");
const secretAbout = el("p", "about", "The file is encrypted with it. Keep it somewhere safe: without it the backup cannot be restored, and nobody can recover it.");
const fields = el("div", "fields");
function passField(id: string, label: string): HTMLInputElement {
  const field = el("label", "pass");
  field.htmlFor = id;
  const box = input("password", id);
  box.autocomplete = "new-password";
  box.spellcheck = false;
  box.setAttribute("aria-describedby", "pass-problem");
  box.addEventListener("input", () => {
    renderSecret();
    renderFoot();
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveButton.click();
  });
  field.append(el("span", "pass-label", label), box);
  fields.append(field);
  return box;
}
const passphrase = passField("passphrase", "Passphrase");
const confirm = passField("confirm", "Confirm");
const passProblem = el("div", "problem");
passProblem.id = "pass-problem";
passProblem.setAttribute("aria-live", "polite");
const plainRow = el("div", "plain");
const plainBox = input("checkbox", "plain");
const plainLabel = el("label", "", "Don't encrypt");
plainLabel.htmlFor = plainBox.id;
plainRow.append(plainBox, plainLabel);
plainBox.addEventListener("change", () => {
  choice = { ...choice, encrypt: !plainBox.checked };
  // A passphrase that will not be used is not kept.
  if (plainBox.checked) clearSecret();
  send();
  render();
});
const warning = el("div", "warning");
warning.setAttribute("role", "alert");
secret.append(secretTitle, secretAbout, fields, passProblem, plainRow, warning);

form.append(what, levels, secret);

const foot = el("footer", "foot");
const footBar = el("div", "foot-bar");
const footText = el("span", "foot-text");
const saveButton = button("save", "Back Up…", "Choose where to save the backup, and write it", () => {
  if (blocked() || pending || state.busy) return;
  pending = true;
  const typed = choice.encrypt && passphrase.value !== "" ? passphrase.value : undefined;
  vscode.postMessage({ type: "save", choice, ...(typed !== undefined ? { passphrase: typed } : {}) });
  renderFoot();
});
foot.append(footBar, footText, saveButton);

root.append(top, progress, banner, form, foot);

function clearSecret(): void {
  passphrase.value = "";
  confirm.value = "";
}

/** The passphrase fields' problem, as a save would meet it. */
function secretProblem(): string | undefined {
  return passphraseProblem({ encrypt: choice.encrypt, passphrase: passphrase.value, confirm: confirm.value });
}

/** Why Back Up cannot go ahead; none when it can. */
function blocked(): string | undefined {
  const c = state.chosen;
  if (!c) return "Nothing to back up yet.";
  if (!c.files && !Object.keys(c.sections).length) return "Nothing ticked has anything in it.";
  return secretProblem();
}

/** "1,204 sessions and 9,310 other files", from what the choice takes. */
function takesText(c: Pick<Chosen, "sessions" | "files">): string {
  const others = c.files - c.sessions;
  return [c.sessions ? count(c.sessions, "session") : "", others ? count(others, "other file") : ""].filter(Boolean).join(" and ") || "Notes and lists";
}

function renderTop(): void {
  const transcriptsRow = rowOf("transcripts");
  const total = state.sections.reduce((sum, row) => sum + row.bytes, 0);
  where.textContent =
    state.lookedAt === undefined
      ? state.busy === "look"
        ? "Looking at what there is to back up…"
        : "Not looked at yet."
      : `${state.host} · ${count(transcriptsRow?.count ?? 0, "session")}, ${formatBytes(total)} in all · looked at ${clock(state.lookedAt)}`;
  lookButton.disabled = state.busy !== undefined;
}

function renderProgress(): void {
  progress.classList.toggle("hidden", !state.busy);
  bar.classList.toggle("indeterminate", state.busy === "look");
  stopButton.classList.toggle("hidden", state.busy !== "write");
  if (!state.busy) return;
  if (state.busy === "look") {
    progressText.textContent = "Looking at the transcripts, the history and the kept files. On a large machine this takes a few seconds.";
    bar.removeAttribute("aria-valuenow");
    barFill.style.width = "";
    return;
  }
  const p = state.progress;
  const percent = p && p.total ? Math.min(100, Math.round((100 * p.done) / p.total)) : 0;
  progressText.textContent = stopping ? "Stopping…" : p && p.total ? `Backing up · ${formatBytes(p.done)} of ${formatBytes(p.total)} · ${percent}%` : "Backing up…";
  bar.setAttribute("aria-valuenow", String(percent));
  barFill.style.width = `${percent}%`;
  stopButton.disabled = stopping;
}

function renderBanner(): void {
  banner.replaceChildren();
  const s = state.summary;
  if (s) {
    const done = el("div", "done", `Saved ${s.name}`);
    done.title = s.file;
    done.append(el("span", "when", clock(s.at)));
    banner.append(done, el("div", "aside", `${formatBytes(s.bytes)} · ${takesText(s)} · ${s.encrypted ? "encrypted" : "not encrypted"} · took ${formatElapsed(s.tookMs)}`));
    if (s.encrypted) banner.append(el("div", "aside", "Keep the passphrase: the backup cannot be restored without it."));
    if (s.left) banner.append(el("div", "left", `${count(s.left, "file")} had gone since Lookout looked, and ${s.left === 1 ? "was" : "were"} left out.`));
    const actions = el("div", "banner-actions");
    actions.append(button("tool", "Show in Folder", `Show ${s.file} in the file manager`, () => vscode.postMessage({ type: "reveal" })));
    const dismiss = button("dismiss", "×", "Dismiss", () => vscode.postMessage({ type: "dismiss" }));
    dismiss.setAttribute("aria-label", "Dismiss");
    banner.append(actions, dismiss);
  }
  if (state.notice) banner.append(el("div", "notice", state.notice));
  if (state.error) banner.append(el("div", "error", state.error));
  banner.classList.toggle("hidden", !banner.childElementCount);
  banner.classList.toggle("failed", !s && state.error !== undefined);
}

function renderItems(): void {
  const c = state.chosen;
  for (const [id, view] of itemViews) {
    const row = rowOf(id);
    const empty = !row || row.count === 0;
    const part = TRANSCRIPT_PARTS.includes(id);
    const on = isOn(id) && !empty && (!part || isOn("transcripts"));
    view.box.checked = isOn(id) && !empty;
    view.box.disabled = empty || (part && !isOn("transcripts"));
    view.row.classList.toggle("empty", empty);
    view.row.classList.toggle("off", !on);
    if (!row || empty) {
      view.count.textContent = "none";
      view.size.textContent = "—";
      view.size.title = "";
      continue;
    }
    const taken = c?.sections[id];
    const filtered = on && narrowed() && (id === "transcripts" || part) && taken !== undefined && taken.count !== row.count;
    view.count.textContent = filtered ? `${taken.count.toLocaleString("en-US")} of ${countText(row)}` : countText(row);
    view.size.textContent = formatBytes(filtered ? taken.bytes : row.bytes);
    view.size.title = filtered ? `of ${formatBytes(row.bytes)}` : "";
  }
  const days = choice.days;
  AGES.forEach((age, i) => (ageBoxes[i]!.checked = age.days === days));
  nest.classList.toggle("off", !isOn("transcripts") || !rowOf("transcripts")?.count);
  ages.disabled = !isOn("transcripts");
}

let reposFor: number | undefined;
let repoViews = new Map<string, { row: HTMLElement; box: HTMLInputElement; count: HTMLElement; size: HTMLElement }>();

/** The repository rows, made again for a new look; their ticks and numbers set from the choice. */
function renderRepos(): void {
  if (reposFor !== state.lookedAt) {
    reposFor = state.lookedAt;
    reposList.replaceChildren();
    repoViews = new Map();
    state.repos.forEach((repo, i) => {
      const row = el("div", "repo");
      const box = input("checkbox", `repo-${i}`, "tick");
      box.addEventListener("change", () => {
        const skip = new Set(choice.skipRepos);
        if (box.checked) skip.delete(repo.repo);
        else skip.add(repo.repo);
        choice = { ...choice, skipRepos: [...skip] };
        send();
        render();
      });
      const name = el("label", "repo-name", repo.name);
      name.htmlFor = box.id;
      name.title = repo.repo;
      const countEl = el("span", "repo-count");
      countEl.id = `repo-count-${i}`;
      const size = el("span", "repo-size");
      size.id = `repo-size-${i}`;
      box.setAttribute("aria-describedby", `${countEl.id} ${size.id}`);
      row.append(box, name, countEl, size);
      reposList.append(row);
      repoViews.set(repo.repo, { row, box, count: countEl, size });
    });
  }
  const off = !isOn("transcripts");
  state.repos.forEach((repo, i) => {
    const view = repoViews.get(repo.repo);
    if (!view) return;
    const ticked = !choice.skipRepos.includes(repo.repo);
    const left = state.chosen?.repos[repo.repo] ?? { sessions: 0, bytes: 0 };
    view.box.checked = ticked;
    view.box.disabled = off;
    view.row.classList.toggle("hidden", !allRepos && i >= REPOS_SHOWN);
    view.row.classList.toggle("off", !ticked || !left.sessions);
    view.count.textContent = !left.sessions ? (choice.days ? `none in the last ${choice.days} days` : "none") : choice.days ? `${left.sessions.toLocaleString("en-US")} of ${count(repo.sessions, "session")}` : count(repo.sessions, "session");
    view.size.textContent = left.sessions ? formatBytes(left.bytes) : "—";
  });
  const every = !choice.skipRepos.some((repo) => state.repos.some((r) => r.repo === repo));
  reposAll.textContent = every ? "None" : "All";
  reposAll.title = every ? "Untick them all" : "Tick them all";
  reposAll.disabled = off;
  reposHead.classList.toggle("hidden", !state.repos.length);
  const hidden = state.repos.length - REPOS_SHOWN;
  reposMore.classList.toggle("hidden", hidden <= 0);
  reposMore.textContent = allRepos ? "Show fewer" : `Show ${count(hidden, "more repository", "more repositories")}`;
  reposMore.title = allRepos ? `Show only the ${REPOS_SHOWN} biggest` : "Show every repository";
  reposMore.setAttribute("aria-expanded", String(allRepos));
}

function renderLevels(): void {
  for (const view of levelViews) {
    view.radio.checked = choice.level === view.level;
    const estimate = state.chosen?.estimate[view.level];
    view.estimate.textContent = estimate !== undefined ? `about ${formatBytes(estimate)}` : "";
    view.about.textContent = state.zstd ? view.title : "gzip";
    view.radio.disabled = !state.zstd && view.level === "smaller";
    view.option.classList.toggle("off", view.radio.disabled);
  }
  levelNote.classList.toggle("hidden", state.zstd);
}

function renderSecret(): void {
  plainBox.checked = !choice.encrypt;
  passphrase.disabled = confirm.disabled = !choice.encrypt;
  fields.classList.toggle("off", !choice.encrypt);
  passphrase.required = confirm.required = choice.encrypt;
  // A problem shows under the fields once something is typed; the foot says it from the start.
  const problem = passphrase.value || confirm.value ? secretProblem() : undefined;
  const short = !problem && choice.encrypt && passphrase.value !== "" && [...passphrase.value].length < SHORT_PASSPHRASE;
  passProblem.textContent = problem ?? (short ? "Short: a longer passphrase is harder to guess." : "");
  passProblem.classList.toggle("hint", !problem);
  // Set only when it changes: the warning is an alert, said again whenever its text is replaced.
  const plain = plainWarning(choice, state.sections);
  if (warning.textContent !== plain) warning.textContent = plain;
  warning.classList.toggle("hidden", choice.encrypt);
}

function renderFoot(): void {
  const looked = state.lookedAt !== undefined;
  foot.classList.toggle("hidden", !looked);
  foot.classList.toggle("busy", state.busy !== undefined);
  foot.classList.toggle("writing", state.busy === "write");
  if (state.busy === "write") {
    const p = state.progress;
    footText.textContent = stopping ? "Stopping…" : p && p.total ? `Backing up · ${formatBytes(p.done)} of ${formatBytes(p.total)}` : "Backing up…";
    footBar.style.width = p && p.total ? `${Math.min(100, Math.round((100 * p.done) / p.total))}%` : "0%";
    saveButton.textContent = "Backing up…";
    saveButton.disabled = true;
    return;
  }
  footBar.style.width = "0%";
  saveButton.textContent = "Back Up…";
  const reason = blocked();
  const c = state.chosen;
  const encrypted = choice.encrypt && passphrase.value !== "";
  footText.textContent = reason ?? (c ? `${takesText(c)} · ${formatBytes(c.bytes)} → about ${formatBytes(c.estimate[choice.level])} · ${encrypted ? "encrypted" : "not encrypted"}` : "");
  footText.classList.toggle("reason", reason !== undefined);
  saveButton.disabled = reason !== undefined || pending || state.busy !== undefined;
}

function render(): void {
  renderTop();
  renderProgress();
  renderBanner();
  form.classList.toggle("hidden", state.lookedAt === undefined);
  form.disabled = state.busy !== undefined;
  renderItems();
  renderRepos();
  renderLevels();
  renderSecret();
  renderFoot();
}

window.addEventListener("message", (event: MessageEvent<ToBackup>) => {
  const message = event.data;
  // How far the write got: the bars and the foot, not the form.
  if (message?.type === "progress") {
    state = { ...state, progress: message.progress };
    renderProgress();
    renderFoot();
    return;
  }
  if (message?.type !== "state") return;
  // A write that ends, however it ends, takes the passphrase off the page.
  if (state.busy === "write" && message.state.busy !== "write") clearSecret();
  state = message.state;
  pending = false;
  if (!state.busy) stopping = false;
  render();
});

render();
vscode.postMessage({ type: "ready" });
send();
