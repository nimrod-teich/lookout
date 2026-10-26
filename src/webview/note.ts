/// <reference lib="dom" />
import { agentInfo } from "../core/agents/catalog";
import type { FromNote, NoteItem, NoteSession, ToNote } from "./noteProtocol";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60_000;
/** A removal asked once holds this long for the click that does it. */
const ARM_MS = 4000;

/** When a note was written, in words: "today 14:22", "yesterday 09:10", "26 Oct 14:22", "26 Oct 2025 14:22". */
export function stampOf(at: number, now: number): string {
  const then = new Date(at);
  const today = new Date(now);
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(today) - dayOf(then)) / DAY_MS);
  const clock = `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`;
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `yesterday ${clock}`;
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return then.getFullYear() === today.getFullYear() ? `${date} ${clock}` : `${date} ${then.getFullYear()} ${clock}`;
}

/** The session the page is on. */
let session: NoteSession | undefined;
/** The notes as Lookout keeps them, oldest first. */
let notes: NoteItem[] = [];
let max = 8000;
/** The note being changed, and the text typed so far: kept across a refresh. */
let editing: { id: string; text: string } | undefined;
/** A removal asked once: the second click within a few seconds does it. */
let arming: { id: string; until: number } | undefined;

// The top: the session the notes are on, and the way to it.

const top = el("header", "top");
const eyebrow = el("div", "eyebrow", "Notes on a session");
const heading = el("div", "heading");
const title = el("h1", "title");
heading.append(title);
const where = el("div", "where");
const openButton = button("open", "Open session ↗", "Bring the session to the front, or resume it", () => {
  if (session) vscode.postMessage({ type: "open", id: session.id });
});
top.append(eyebrow, heading, where, openButton);

// The thread: each note with its time, and what can be done with it.

const thread = el("section", "thread");

// The box for the next note.

const composer = el("section", "composer");
const area = el("textarea", "draft");
area.placeholder = "Add a note: why the session matters, what it holds, what came of it.";
area.spellcheck = true;
area.setAttribute("aria-label", "A new note on the session");
const foot = el("footer", "foot");
const status = el("span", "status");
const count = el("span", "count");
const add = button("btn add", "Add note", "Keep this note (Ctrl+Enter)", () => addNow());
foot.append(status, count, add);
composer.append(area, foot);

root.append(top, thread, composer);

function grow(box: HTMLTextAreaElement, least: number): void {
  box.style.height = "auto";
  box.style.height = `${Math.max(box.scrollHeight, least)}px`;
}

function setStatus(text: string, kind: "" | "failed" = ""): void {
  status.textContent = text;
  status.className = kind ? `status ${kind}` : "status";
}

/** The counter and the button follow the draft. */
function refreshComposer(): void {
  add.disabled = area.value.trim() === "";
  count.textContent = `${area.value.length.toLocaleString()} / ${max.toLocaleString()}`;
  count.classList.toggle("near", area.value.length > max * 0.9);
  grow(area, 96);
}

function addNow(): void {
  if (!session || area.value.trim() === "") return;
  vscode.postMessage({ type: "add", id: session.id, text: area.value });
  area.value = "";
  refreshComposer();
  setStatus("");
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
  document.title = `Notes: ${next.title}`;
}

/** One note of the thread: its time, its text, and its Edit and Remove; or, while it is being changed, a box with Save and Cancel. */
function noteItem(note: NoteItem, now: number): HTMLElement {
  const item = el("article", "note");
  item.dataset.id = note.id;
  const head = el("div", "note-head");
  const stamp = el("time", "stamp", stampOf(note.at, now));
  stamp.dateTime = new Date(note.at).toISOString();
  stamp.title = new Date(note.at).toLocaleString();
  head.append(stamp);
  if (note.editedAt !== undefined) {
    const edited = el("span", "edited", "edited");
    edited.title = `Changed ${new Date(note.editedAt).toLocaleString()}`;
    head.append(edited);
  }
  if (editing?.id === note.id) {
    const box = el("textarea", "edit-box");
    box.value = editing.text;
    box.maxLength = max;
    box.setAttribute("aria-label", "The note, changed");
    box.addEventListener("input", () => {
      if (editing) editing.text = box.value;
      grow(box, 72);
    });
    box.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === "Enter" || event.key === "s" || event.key === "S")) {
        event.preventDefault();
        saveEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
      }
    });
    const actions = el("div", "note-actions editing");
    actions.append(button("btn small", "Cancel", "Leave the note as it was (Esc)", cancelEdit), button("btn small save", "Save", "Keep the change (Ctrl+Enter)", saveEdit));
    item.append(head, box, actions);
    requestAnimationFrame(() => {
      grow(box, 72);
      box.focus();
    });
    return item;
  }
  const body = el("div", "note-text", note.text);
  const actions = el("div", "note-actions");
  const armed = arming?.id === note.id && arming.until > Date.now();
  actions.append(
    button("link", "Edit", "Change this note", () => {
      editing = { id: note.id, text: note.text };
      arming = undefined;
      render();
    }),
    button(armed ? "link danger armed" : "link danger", armed ? "Click again to remove" : "Remove", "Take this note away", () => {
      if (!session) return;
      if (arming?.id === note.id && arming.until > Date.now()) {
        arming = undefined;
        vscode.postMessage({ type: "remove", id: session.id, noteId: note.id });
        return;
      }
      arming = { id: note.id, until: Date.now() + ARM_MS };
      render();
      setTimeout(() => {
        if (arming?.id === note.id && arming.until <= Date.now()) {
          arming = undefined;
          render();
        }
      }, ARM_MS + 50);
    }),
  );
  head.append(actions);
  item.append(head, body);
  return item;
}

function saveEdit(): void {
  if (!session || !editing) return;
  const { id, text } = editing;
  editing = undefined;
  // A blank note is a removal; the extension says so by the thread it sends back.
  vscode.postMessage({ type: "edit", id: session.id, noteId: id, text });
  render();
}

function cancelEdit(): void {
  editing = undefined;
  render();
}

/** The thread, oldest first, as a conversation reads. */
function render(): void {
  const now = Date.now();
  thread.textContent = "";
  if (notes.length === 0) {
    thread.append(el("p", "empty", "No notes yet. The first one goes in the box below."));
    return;
  }
  for (const note of notes) thread.append(noteItem(note, now));
}

area.addEventListener("input", refreshComposer);
area.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    addNow();
  }
});

window.addEventListener("message", (event: MessageEvent<ToNote>) => {
  const message = event.data;
  switch (message.type) {
    case "notes": {
      max = message.max;
      area.maxLength = max;
      showSession(message.session, message.markers);
      notes = message.notes;
      // A note changed elsewhere or gone: the edit in progress keeps its text only while its note is still there.
      if (editing && !notes.some((note) => note.id === editing!.id)) editing = undefined;
      render();
      refreshComposer();
      return;
    }
    case "failed":
      if (session?.id === message.id) setStatus("Lookout could not keep that change", "failed");
      return;
  }
});

vscode.postMessage({ type: "ready" });
refreshComposer();
area.focus();
