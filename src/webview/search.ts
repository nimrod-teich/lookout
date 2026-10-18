/// <reference lib="dom" />
import { AGENTS, agentInfo } from "../core/agents/catalog";
import { describeSpan, shortSpan } from "../core/format";
import type { SearchHit } from "../core/history";
import { agentGlyph } from "./glyph";
import type { FromSearch, SearchPageSession, ToSearch } from "./searchProtocol";

declare function acquireVsCodeApi(): {
  postMessage(message: FromSearch): void;
  getState(): { query?: string } | undefined;
  setState(state: { query: string }): void;
};

const vscode = acquireVsCodeApi();
const root = document.getElementById("root")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const OPERATORS = "since:3d, before:yesterday, since:2026-10-01, project:api, branch:fix-login, file:src/app.ts";

/** The query whose results are on show, or asked for. */
let query = "";
/** Tell the agents apart: each session's mark and its agent's name. */
let markers = false;
/** Agents hidden on the board the page was opened from: their sessions are left out until "Show them". */
let hiddenAgents = new Set<string>();
/** The results on show, kept to show them again with every agent. */
let shown: Extract<ToSearch, { type: "results" }> | undefined;

// The top: what this is, how much it found, and the box.

const top = el("header", "top");
const heading = el("h1", "heading");
const mark = el("span", "mark");
mark.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6.2 6.5h3.6L11.4 15H4.6z"/><path d="M5 6h6v1.2H5z"/><path d="M6.4 3.4h3.2V6H6.4z"/><path d="M6.6 3.4a1.4 1.4 0 0 1 2.8 0z"/><path d="M7.6 1.2h.8v1.3h-.8z"/><path d="M9.8 4.1L15.6 2.2v4.4z"/></svg>';
const summary = el("span", "count");
heading.append(mark, el("span", "title", "Search every conversation"), summary);
const field = el("label", "field");
field.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 10l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const input = el("input", "");
input.type = "search";
input.placeholder = "Search the conversations";
input.title = `Every word must appear in one message. Narrow it with ${OPERATORS}`;
input.setAttribute("aria-label", "Search the conversations");
input.spellcheck = false;
field.append(input);
top.append(heading, field);
const list = el("div", "sessions");
root.append(top, list);

function ask(): void {
  vscode.postMessage({ type: "search", query, zone: new Date().getTimezoneOffset() });
}

/** Runs what the box holds. */
function run(): void {
  query = input.value.trim();
  vscode.setState({ query });
  if (query === "") {
    summary.textContent = "";
    showHint();
    return;
  }
  summary.textContent = "Searching…";
  ask();
}

let timer: ReturnType<typeof setTimeout> | undefined;
input.addEventListener("input", () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, 250);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    if (timer) clearTimeout(timer);
    run();
  } else if (event.key === "Escape") {
    input.value = "";
    run();
  }
});

function showHint(): void {
  list.textContent = "";
  const hint = el("div", "empty");
  hint.append(el("p", "big", "Every conversation, live and earlier"), el("p", "small", `What you wrote and what the agent replied, in the sessions the board's Earlier group covers. Every word must appear in one message; narrow it with ${OPERATORS}.`));
  list.append(hint);
}

function timeText(at: number | undefined): string {
  if (at === undefined) return "";
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A snippet with its matched ranges marked. */
function marked(hit: SearchHit): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const [start, end] of hit.ranges) {
    if (start > cursor) fragment.append(hit.snippet.slice(cursor, start));
    fragment.append(el("mark", "", hit.snippet.slice(start, end)));
    cursor = end;
  }
  if (cursor < hit.snippet.length) fragment.append(hit.snippet.slice(cursor));
  return fragment;
}

function open(id: string, index?: number): void {
  vscode.postMessage({ type: "open", query, id, index });
}

function sessionBlock(session: SearchPageSession): HTMLElement {
  const block = el("section", `session${session.live ? " live" : ""}`);
  const head = el("button", "session-head");
  head.type = "button";
  head.title = "Open this conversation at its newest match";
  // Line one: what it is, whether it runs, how much matched.
  const top = el("span", "head-top");
  if (markers && session.agent) top.append(agentGlyph(session.agent, 13));
  top.append(el("span", "session-title", session.title), el("span", "tag", session.live ? "running" : "earlier"));
  if (session.count > 0) top.append(el("span", "matches", `${session.count} ${session.count === 1 ? "match" : "matches"}`));
  // Line two: where it worked, and when.
  const meta = el("span", "head-meta");
  if (markers && session.agent) meta.append(el("span", "agent", agentInfo(session.agent).label));
  for (const part of (session.where ?? "").split(" · ").filter(Boolean)) meta.append(el("span", "chip", part));
  const when = shortSpan(session.started, session.lastActive, Date.now());
  if (when) {
    const time = el("span", "when", when);
    time.title = describeSpan(session.started, session.lastActive);
    meta.append(time);
  }
  head.append(top, meta);
  head.addEventListener("click", () => open(session.id));
  block.append(head);
  for (const hit of session.hits) {
    const item = el("button", `hit ${hit.role}`);
    item.type = "button";
    item.title = "Open the conversation at this message";
    const meta = el("span", "meta");
    meta.append(el("span", "who", hit.role === "you" ? "you" : "agent"), el("span", "when", timeText(hit.at)));
    const text = el("span", "text");
    text.append(marked(hit));
    item.append(meta, text);
    item.addEventListener("click", () => open(session.id, hit.index));
    block.append(item);
  }
  const more = session.count - session.hits.length;
  if (more > 0) {
    const link = el("button", "more", `+${more} more in the conversation`);
    link.type = "button";
    link.addEventListener("click", () => open(session.id));
    block.append(link);
  }
  return block;
}

function receive(message: Extract<ToSearch, { type: "results" }>): void {
  // An answer to an older query is of no use.
  if (message.query !== query) return;
  shown = message;
  markers = message.markers === true;
  const left = message.sessions.filter((session) => hiddenAgents.has(session.agent ?? AGENTS[0]!.id));
  const kept = message.sessions.filter((session) => !left.includes(session));
  const matches = kept.reduce((sum, session) => sum + session.count, 0);
  const sessions = `${kept.length} ${kept.length === 1 ? "session" : "sessions"}`;
  const found = kept.length === 0 ? "no matches" : matches === 0 ? sessions : `${matches} ${matches === 1 ? "match" : "matches"} in ${sessions}`;
  summary.textContent = message.pending > 0 ? `${found} · reading ${message.pending} more…` : found;
  list.textContent = "";
  if (left.length > 0) list.append(leftOut(left));
  if (kept.length === 0) {
    const empty = el("div", "empty");
    empty.append(el("p", "big", message.pending > 0 ? "Searching…" : "No conversation mentions that"), el("p", "small", `Every word must appear in one message; ${OPERATORS} narrow the search.`));
    list.append(empty);
  }
  for (const session of kept) list.append(sessionBlock(session));
  // Conversations not read within the time given: ask again shortly, until none is left.
  if (message.pending > 0)
    setTimeout(() => {
      if (message.query === query) ask();
    }, 300);
}

/** Says whose sessions the page leaves out, as the board hides them, with a button to show them here. */
function leftOut(left: SearchPageSession[]): HTMLElement {
  const note = el("p", "left-out");
  const names = [...new Set(left.map((session) => agentInfo(session.agent ?? AGENTS[0]!.id).label))].join(" and ");
  note.append(el("span", "", `${left.length} ${left.length === 1 ? "session" : "sessions"} of ${names} left out, as on the board. `));
  const show = el("button", "link", "Show them");
  show.type = "button";
  show.addEventListener("click", () => {
    hiddenAgents = new Set();
    if (shown) receive(shown);
  });
  note.append(show);
  return note;
}

window.addEventListener("message", (event: MessageEvent<ToSearch>) => {
  const message = event.data;
  if (message.type === "query") {
    hiddenAgents = new Set(message.hide ?? []);
    input.value = message.query || input.value;
    run();
    input.focus();
    return;
  }
  if (message.type === "results") receive(message);
});

input.value = vscode.getState()?.query ?? "";
run();
vscode.postMessage({ type: "ready" });
