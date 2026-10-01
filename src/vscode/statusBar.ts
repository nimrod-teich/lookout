import * as vscode from "vscode";
import { countStates, describeLocation, describeState, type Counts } from "../core/format";
import type { SessionView } from "../core/types";
import { STATE_ICON } from "./icons";

/** Braille spinner frames for the "working" count. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 100;
/** How often the elapsed times in the hover are refreshed. */
const TOOLTIP_MS = 60_000;

function statusText(counts: Counts, frame: number): string {
  const parts: string[] = [];
  if (counts.working) parts.push(`${FRAMES[frame % FRAMES.length]} ${counts.working}`);
  if (counts.waiting) parts.push(`${STATE_ICON.waiting} ${counts.waiting}`);
  if (counts.done) parts.push(`${STATE_ICON.done} ${counts.done}`);
  if (counts.unknown) parts.push(`${STATE_ICON.unknown} ${counts.unknown}`);
  if (!counts.working && !counts.waiting && !counts.done) parts.push(`${counts.idle} idle`);
  return `$(telescope) ${parts.join("  ")}`;
}

function spokenText(counts: Counts): string {
  return `Lookout: ${counts.working} working, ${counts.waiting} waiting for you, ${counts.done} finished, ${counts.idle + counts.unknown} idle`;
}

function tooltip(views: readonly SessionView[], now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  for (const view of views) {
    md.appendMarkdown(`${STATE_ICON[view.state]} **`);
    md.appendText(view.title);
    md.appendMarkdown("**  \n");
    md.appendText(`${describeLocation(view)} · ${describeState(view, now)}`);
    md.appendMarkdown("\n\n");
  }
  md.appendMarkdown("Click to jump to a session");
  return md;
}

/**
 * The status bar item. Every property write is a message to the VS Code UI, so
 * it writes a property only when its value changes. The spinner is the one
 * exception: while a session works, the text is rewritten once per frame.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly warning = new vscode.ThemeColor("statusBarItem.warningBackground");
  private shown = { visible: false, text: "", spoken: "", tooltip: "", warning: false };
  private counts: Counts = countStates([]);
  private views: readonly SessionView[] = [];
  private frame = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem("lookout.sessions", vscode.StatusBarAlignment.Left, 1000);
    this.item.name = "Lookout";
    this.item.command = command;
  }

  render(views: readonly SessionView[], enabled: boolean, now: number = Date.now()): void {
    const visible = enabled && views.length > 0;
    this.views = views;
    this.counts = countStates(views);
    this.spin(visible && this.counts.working > 0);
    this.tick(visible);
    if (!visible) {
      if (this.shown.visible) this.item.hide();
      this.shown.visible = false;
      return;
    }
    this.writeText();
    const spoken = spokenText(this.counts);
    if (spoken !== this.shown.spoken) {
      this.item.accessibilityInformation = { label: spoken };
      this.shown.spoken = spoken;
    }
    this.writeTooltip(now);
    const warning = this.counts.waiting > 0;
    if (warning !== this.shown.warning) {
      this.item.backgroundColor = warning ? this.warning : undefined;
      this.shown.warning = warning;
    }
    if (!this.shown.visible) this.item.show();
    this.shown.visible = true;
  }

  private writeTooltip(now: number): void {
    const tip = tooltip(this.views, now);
    if (tip.value !== this.shown.tooltip) {
      this.item.tooltip = tip;
      this.shown.tooltip = tip.value;
    }
  }

  /** Keeps the elapsed times in the hover current while the item is shown. */
  private tick(on: boolean): void {
    if (on && !this.ticker) {
      this.ticker = setInterval(() => this.writeTooltip(Date.now()), TOOLTIP_MS);
    } else if (!on && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private writeText(): void {
    const text = statusText(this.counts, this.frame);
    if (text !== this.shown.text) this.item.text = this.shown.text = text;
  }

  private spin(on: boolean): void {
    if (on && !this.spinner) {
      this.spinner = setInterval(() => {
        this.frame++;
        this.writeText();
      }, FRAME_MS);
    } else if (!on && this.spinner) {
      clearInterval(this.spinner);
      this.spinner = undefined;
    }
  }

  dispose(): void {
    this.spin(false);
    this.tick(false);
    this.item.dispose();
  }
}
