/// <reference lib="dom" />
import { matchesAll, matchRanges, termsOf } from "../core/terms";
import type { FindingsMessage, FromFindings, ToFindings } from "./findingsProtocol";

declare function acquireVsCodeApi(): { postMessage(message: FromFindings): void };

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

/** The conversation on show. */
let conversation: ToFindings | undefined;
let terms: string[] = [];
/** Indices of the messages holding every term, in reading order. */
let matches: number[] = [];
/** Position in `matches` of the message in view. */
let current = -1;
const blocks = new Map<number, HTMLElement>();

// The top: the session, its own search, and the way to its tab.

const top = el("header", "top");
const heading = el("h1", "heading");
const titleEl = el("span", "title");
const countEl = el("span", "count");
heading.append(titleEl, countEl);
const field = el("label", "field");
field.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 10l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const input = el("input", "");
input.type = "search";
input.placeholder = "Search this conversation";
input.setAttribute("aria-label", "Search this conversation");
input.spellcheck = false;
field.append(input);
const nav = el("span", "nav");
const position = el("span", "position");
const prev = button("step", "↑", "Previous match (Shift+Enter)", () => go(-1));
const next = button("step", "↓", "Next match (Enter)", () => go(1));
nav.append(position, prev, next);
const open = button("open", "Open session ↗", "Bring the session's own tab or terminal to the front", () => {
  if (conversation) vscode.postMessage({ type: "jump", id: conversation.session.id });
});
top.append(heading, field, nav, open);
const list = el("div", "messages");
root.append(top, list);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
input.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyQuery(input.value, undefined, true), 200);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (searchTimer) {
      clearTimeout(searchTimer);
      applyQuery(input.value, undefined, true);
    } else go(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    input.value = "";
    applyQuery("", undefined, false);
  }
});

/** The text with every term wrapped in a mark. */
function marked(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const [start, end] of matchRanges(text, terms)) {
    if (start > cursor) fragment.append(text.slice(cursor, start));
    fragment.append(el("mark", "", text.slice(start, end)));
    cursor = end;
  }
  if (cursor < text.length) fragment.append(text.slice(cursor));
  return fragment;
}

function timeText(at: number | undefined): string {
  if (at === undefined) return "";
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function messageBlock(message: FindingsMessage): HTMLElement {
  const hit = matchesAll(message.text, terms);
  const block = el("article", `message ${message.role}${hit ? " hit" : terms.length ? " dim" : ""}`);
  block.dataset.index = String(message.index);
  const head = el("header", "head");
  head.append(el("span", "who", message.role === "you" ? "you" : "agent"), el("span", "when", timeText(message.at)));
  const body = el("div", "body");
  body.append(marked(message.text));
  block.append(head, body);
  return block;
}

function renderMessages(): void {
  list.textContent = "";
  blocks.clear();
  matches = [];
  if (!conversation) return;
  for (const message of conversation.messages) {
    const block = messageBlock(message);
    blocks.set(message.index, block);
    if (block.classList.contains("hit")) matches.push(message.index);
    list.append(block);
  }
}

function showCurrent(scroll: boolean): void {
  for (const block of blocks.values()) block.classList.remove("target");
  const index = matches[current];
  position.textContent = terms.length === 0 ? "" : matches.length === 0 ? "no matches" : `${current + 1} of ${matches.length}`;
  prev.disabled = next.disabled = matches.length < 2;
  if (index === undefined) return;
  const block = blocks.get(index);
  block?.classList.add("target");
  if (scroll) block?.scrollIntoView({ block: "center" });
}

/** Applies a query: marks the terms, dims the rest, and lands on `target`, or the newest match. */
function applyQuery(query: string, target: number | undefined, scroll: boolean): void {
  terms = termsOf(query);
  renderMessages();
  current = target === undefined ? matches.length - 1 : matches.indexOf(target);
  if (current < 0 && target !== undefined) {
    // Asked for a message that is not a match: outline it anyway.
    blocks.get(target)?.classList.add("target");
    if (scroll) blocks.get(target)?.scrollIntoView({ block: "center" });
    position.textContent = terms.length === 0 ? "" : matches.length === 0 ? "no matches" : `${matches.length} ${matches.length === 1 ? "match" : "matches"}`;
    prev.disabled = next.disabled = matches.length < 2;
    return;
  }
  showCurrent(scroll);
}

function go(step: number): void {
  if (matches.length === 0) return;
  current = current < 0 ? (step > 0 ? 0 : matches.length - 1) : (current + step + matches.length) % matches.length;
  showCurrent(true);
}

window.addEventListener("message", (event: MessageEvent<ToFindings>) => {
  const message = event.data;
  if (message.type !== "conversation") return;
  const same = conversation?.session.id === message.session.id;
  const scrollY = window.scrollY;
  conversation = message;
  titleEl.textContent = message.session.title;
  countEl.textContent = `${message.messages.length} ${message.messages.length === 1 ? "message" : "messages"}`;
  if (same) {
    // The conversation grew: keep the search and the place.
    const index = matches[current];
    applyQuery(input.value, index, false);
    window.scrollTo(0, scrollY);
    return;
  }
  input.value = message.query;
  applyQuery(message.query, message.target, true);
  if (terms.length === 0 && message.target === undefined) window.scrollTo(0, document.body.scrollHeight);
  input.focus();
});

vscode.postMessage({ type: "ready" });
