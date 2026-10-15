import * as vscode from "vscode";
import { countStates, describeLocation, describeState, formatElapsed, type Counts } from "../core/format";
import type { SessionView } from "../core/types";
import type { Usage } from "./controller";
import { BRAND_ICON, STATE_ICON } from "./icons";

/** Braille spinner frames for the "working" count. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 100;
/** How often the elapsed times in the hover are refreshed. */
const TOOLTIP_MS = 60_000;
const USAGE_ERROR_AT = 95;

export interface StatusBarInput {
  views: readonly SessionView[];
  usage: Usage | undefined;
  enabled: boolean;
  showUsage: boolean;
  canRefreshUsage: boolean;
}

function sessionsText(counts: Counts, frame: number): string {
  const parts: string[] = [];
  if (counts.working) parts.push(`${FRAMES[frame % FRAMES.length]} ${counts.working}`);
  if (counts.waiting) parts.push(`${STATE_ICON.waiting} ${counts.waiting}`);
  if (counts.done) parts.push(`${STATE_ICON.done} ${counts.done}`);
  if (counts.unknown) parts.push(`${STATE_ICON.unknown} ${counts.unknown}`);
  if (!counts.working && !counts.waiting && !counts.done) parts.push(`${counts.idle} idle`);
  return parts.join("  ");
}

function usageText(usage: Usage | undefined): string {
  if (!usage) return "";
  const session = usage.meters.find((m) => m.key === "session");
  const week = usage.meters.find((m) => m.key === "weekly_all");
  const parts = [session && `5h ${session.percent}%`, week && `wk ${week.percent}%`].filter(Boolean);
  if (parts.length === 0) for (const meter of usage.meters.slice(0, 2)) parts.push(`${meter.label} ${meter.percent}%`);
  return parts.join(" · ");
}

function spokenText(counts: Counts, usage: string): string {
  const sessions = `Lookout: ${counts.working} working, ${counts.waiting} waiting for you, ${counts.done} finished, ${counts.idle + counts.unknown} idle`;
  return usage ? `${sessions}. Usage ${usage}` : sessions;
}

function resetText(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || resetsAt <= now) return "";
  return ` · resets in ${formatElapsed(resetsAt - now)}`;
}

function tooltip(input: StatusBarInput, now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  for (const view of input.views) {
    md.appendMarkdown(`${STATE_ICON[view.state]} **`);
    md.appendText(view.title);
    md.appendMarkdown("**  \n");
    md.appendText(`${describeLocation(view)} · ${describeState(view, now)}`);
    md.appendMarkdown("\n\n");
  }
  if (input.views.length === 0) md.appendMarkdown("No agent sessions running.\n\n");
  if (input.showUsage) {
    md.appendMarkdown("---\n\n**Claude usage**  \n");
    if (input.usage) {
      for (const meter of input.usage.meters) {
        md.appendText(`${meter.label}: ${meter.percent}%${resetText(meter.resetsAt, now)}`);
        md.appendMarkdown("  \n");
      }
      md.appendText(`As of ${formatElapsed(now - input.usage.fetchedAt)} ago${input.usage.stale ? " (stale)" : ""}`);
      md.appendMarkdown("\n\n");
    } else {
      md.appendMarkdown(input.canRefreshUsage ? "No numbers yet; run Lookout: Refresh Usage.\n\n" : "No numbers.\n\n");
    }
  }
  md.appendMarkdown("Click to jump to a session");
  return md;
}

/**
 * The status bar item: the session counts and the usage, under one
 * lighthouse. Every property write is a message to the VS Code UI, so it
 * writes a property only when its value changes. The spinner is the one
 * exception: while a session works, the text is rewritten once per frame.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly warning = new vscode.ThemeColor("statusBarItem.warningBackground");
  private readonly error = new vscode.ThemeColor("statusBarItem.errorBackground");
  private shown = { visible: false, text: "", spoken: "", tooltip: "", background: "" };
  private input: StatusBarInput = { views: [], usage: undefined, enabled: true, showUsage: true, canRefreshUsage: false };
  private counts: Counts = countStates([]);
  private frame = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem("lookout.status", vscode.StatusBarAlignment.Left, 1000);
    this.item.name = "Lookout";
    this.item.command = command;
  }

  render(input: StatusBarInput, now: number = Date.now()): void {
    this.input = input;
    this.counts = countStates(input.views);
    const visible = input.enabled && (input.views.length > 0 || (input.showUsage && input.usage !== undefined));
    this.spin(visible && this.counts.working > 0);
    this.tick(visible);
    if (!visible) {
      if (this.shown.visible) this.item.hide();
      this.shown.visible = false;
      return;
    }
    this.writeText();
    const spoken = spokenText(this.counts, input.showUsage ? usageText(input.usage) : "");
    if (spoken !== this.shown.spoken) {
      this.item.accessibilityInformation = { label: spoken };
      this.shown.spoken = spoken;
    }
    this.writeTooltip(now);
    const peak = Math.max(0, ...(input.usage && !input.usage.stale ? input.usage.meters.map((m) => m.percent) : []));
    const background = this.counts.waiting > 0 ? "warning" : input.showUsage && peak >= USAGE_ERROR_AT ? "error" : "";
    if (background !== this.shown.background) {
      this.item.backgroundColor = background === "warning" ? this.warning : background === "error" ? this.error : undefined;
      this.shown.background = background;
    }
    if (!this.shown.visible) this.item.show();
    this.shown.visible = true;
  }

  private writeText(): void {
    const usage = this.input.showUsage ? usageText(this.input.usage) : "";
    const sessions = this.input.views.length > 0 ? sessionsText(this.counts, this.frame) : "";
    const text = `${BRAND_ICON} ${[sessions, usage].filter(Boolean).join("   ")}`;
    if (text !== this.shown.text) this.item.text = this.shown.text = text;
  }

  private writeTooltip(now: number): void {
    const tip = tooltip(this.input, now);
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
