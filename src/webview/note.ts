/// <reference lib="dom" />
import { agentInfo } from "../core/agents/catalog";
import { clockTime } from "../core/format";
import type { FromNote, NoteSession, ToNote } from "./noteProtocol";
import { agentGlyph } from "./glyph";

declare function acquireVsCodeApi(): { postMessage(message: FromNote): void };

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

/** The session the page is on. */
let session: NoteSession | undefined;
/** The note as Lookout keeps it: what the page shows until the user types. */
let saved = "";
let max = 8000;

// The top: the session the note is on, and the way to it.

const top = el("header", "top");
const eyebrow = el("div", "eyebrow", "Note on a session");
const heading = el("div", "heading");
const title = el("h1", "title");
heading.append(title);
const where = el("div", "where");
const openButton = button("open", "Open session ↗", "Bring the session to the front, or resume it", () => {
  if (session) vscode.postMessage({ type: "open", id: session.id });
});
top.append(eyebrow, heading, where, openButton);

// The note itself: a box that grows with it.

const editor = el("section", "editor");
const area = el("textarea", "note");
area.placeholder = "What to remember about this session: why it matters, what it holds, what came of it.";
area.spellcheck = true;
area.setAttribute("aria-label", "The note on the session");
editor.append(area);

// Under it: how the note stands, and what to do with it.

const foot = el("footer", "foot");
const status = el("span", "status");
const count = el("span", "count");
const remove = button("btn remove", "Remove note", "Take the note away", () => {
  if (!session) return;
  area.value = "";
  vscode.postMessage({ type: "remove", id: session.id });
});
const save = button("btn save", "Save", "Keep the note (Ctrl+S)", () => saveNow());
foot.append(status, count, remove, save);

root.append(top, editor, foot);

function dirty(): boolean {
  return area.value !== saved;
}

function grow(): void {
  area.style.height = "auto";
  area.style.height = `${Math.max(area.scrollHeight, 240)}px`;
}

/** The status line, the counter and the buttons follow the text. */
function refresh(): void {
  const changed = dirty();
  save.disabled = !changed;
  remove.classList.toggle("hidden", saved === "" && area.value === "");
  count.textContent = `${area.value.length.toLocaleString()} / ${max.toLocaleString()}`;
  count.classList.toggle("near", area.value.length > max * 0.9);
  if (changed) setStatus("Unsaved changes", "dirty");
  grow();
}

function setStatus(text: string, kind: "" | "dirty" | "failed" = ""): void {
  status.textContent = text;
  status.className = kind ? `status ${kind}` : "status";
}

function saveNow(): void {
  if (!session || !dirty()) return;
  vscode.postMessage({ type: "save", id: session.id, text: area.value });
}

function showSession(next: NoteSession, markers: boolean | undefined): void {
  session = next;
  title.textContent = next.title;
  heading.querySelector(".glyph")?.remove();
  if (markers && next.agent) {
    const glyph = agentGlyph(next.agent, 14);
    glyph.classList.add("glyph");
    glyph.setAttribute("title", agentInfo(next.agent).label);
    heading.prepend(glyph);
  }
  const parts = [next.where, next.live ? "running" : "not running"].filter((part): part is string => !!part);
  where.textContent = parts.join(" · ");
  openButton.classList.toggle("hidden", next.openable === false);
  document.title = `Note: ${next.title}`;
}

function showKept(note: string | undefined, noteAt: number | undefined): void {
  const wasDirty = dirty();
  saved = note ?? "";
  // The user's own typing is never written over: the kept note lands once the page is clean.
  if (!wasDirty) area.value = saved;
  setStatus(note === undefined ? "No note yet" : `Saved${noteAt === undefined ? "" : ` ${clockTime(noteAt)}`}`);
  refresh();
}

area.addEventListener("input", refresh);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S" || event.key === "Enter")) {
    event.preventDefault();
    saveNow();
  }
});

window.addEventListener("message", (event: MessageEvent<ToNote>) => {
  const message = event.data;
  switch (message.type) {
    case "note":
      max = message.max;
      area.maxLength = max;
      showSession(message.session, message.markers);
      showKept(message.note, message.noteAt);
      return;
    case "saved":
      if (session?.id !== message.id) return;
      saved = message.note ?? "";
      area.value = saved;
      setStatus(message.note === undefined ? "Note removed" : `Saved${message.noteAt === undefined ? "" : ` ${clockTime(message.noteAt)}`}`);
      refresh();
      return;
    case "failed":
      if (session?.id === message.id) setStatus("Lookout could not keep the note", "failed");
      return;
  }
});

vscode.postMessage({ type: "ready" });
area.focus();
