import * as vscode from "vscode";
import { countStates, describeLocation, describeState, formatCountdown, formatResetIn, quietFor, type Counts } from "../core/format";
import type { SessionView } from "../core/types";
import type { UsageMeter } from "../core/usage";
import type { Usage } from "./controller";
import { BRAND_ICON, iconFor, STATE_ICON } from "./icons";

/** Braille spinner frames for the "working" count. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 100;
/** How often the elapsed times in the hover are refreshed. */
const TOOLTIP_MS = 60_000;
/** Lands the countdown's rewrite just past the turn of its minute. */
const COUNTDOWN_SLACK_MS = 50;
const USAGE_ERROR_AT = 95;
/** Cells in the usage bar. */
const BAR_CELLS = 10;
/** The bar's colour by consumption, like the board's meters: calm below half, amber from half, red from 80%. */
const BAR_COLORS = { low: "charts.green", mid: "charts.yellow", high: "charts.red" } as const;
/** The same colours in the hover, where only an inline style can colour text: VS Code's default chart colours. */
const HOVER_COLORS = { low: "#89d185", mid: "#cca700", high: "#f14c4c", stale: "#8b8b8b" } as const;
/** Numbers too old to go by. */
const STALE_COLOR = "disabledForeground";

export interface StatusBarInput {
  views: readonly SessionView[];
  usage: Usage | undefined;
  enabled: boolean;
  showUsage: boolean;
  /** The time until the 5-hour window resets, after the bar. */
  showReset: boolean;
  canRefreshUsage: boolean;
}

/** Working sessions whose transcripts have gone quiet show a clock rather than the spinner. */
const QUIET_ICON = "$(clock)";

function sessionsText(counts: Counts, quiet: number, frame: number): string {
  const parts: string[] = [];
  if (counts.working > quiet) parts.push(`${FRAMES[frame % FRAMES.length]} ${counts.working - quiet}`);
  if (quiet) parts.push(`${QUIET_ICON} ${quiet}`);
  if (counts.waiting) parts.push(`${STATE_ICON.waiting} ${counts.waiting}`);
  if (counts.done) parts.push(`${STATE_ICON.done} ${counts.done}`);
  if (counts.unknown) parts.push(`${STATE_ICON.unknown} ${counts.unknown}`);
  if (!counts.working && !counts.waiting && !counts.done) parts.push(`${counts.idle} idle`);
  return parts.join("  ");
}

/** The meter the status bar shows: the 5-hour window, the one that runs out first; the hover has the rest. */
function sessionMeter(usage: Usage | undefined): UsageMeter | undefined {
  return usage?.meters.find((m) => m.key === "session") ?? usage?.meters[0];
}

/** A bar of ten cells for a percentage, e.g. ▰▰▱▱▱▱▱▱▱▱ for 18%. */
export function usageBar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(percent / (100 / BAR_CELLS))));
  return `${"▰".repeat(filled)}${"▱".repeat(BAR_CELLS - filled)}`;
}

function usageLevel(percent: number): keyof typeof BAR_COLORS {
  return percent >= 80 ? "high" : percent >= 50 ? "mid" : "low";
}

function usageText(usage: Usage | undefined, showReset: boolean, now: number): string {
  const meter = sessionMeter(usage);
  if (!meter) return "";
  const reset = showReset && meter.resetsAt !== undefined && meter.resetsAt > now ? ` · ${formatCountdown(meter.resetsAt - now)}` : "";
  return `${usageBar(meter.percent)} ${meter.percent}%${reset}`;
}

/** Grey when stale, else by consumption. */
function usageColor(usage: Usage | undefined): string {
  const meter = sessionMeter(usage);
  if (!usage || !meter) return "";
  if (usage.stale) return STALE_COLOR;
  return BAR_COLORS[usageLevel(meter.percent)];
}

function spokenText(counts: Counts, quiet: number, usage: Usage | undefined): string {
  const sessions = `Lookout: ${counts.working} working${quiet ? ` (${quiet} quiet)` : ""}, ${counts.waiting} waiting for you, ${counts.done} finished, ${counts.idle + counts.unknown} idle`;
  const meter = sessionMeter(usage);
  return meter ? `${sessions}. Usage ${meter.label} ${meter.percent}%` : sessions;
}

/** " · resets in 3h", as Claude Code's panel says it. */
function resetText(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || resetsAt <= now) return "";
  return ` · resets ${formatResetIn(resetsAt - now)}`;
}

function tooltip(input: StatusBarInput, now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  // For the coloured usage bars; VS Code keeps only colour styles.
  md.supportHtml = true;
  for (const view of input.views) {
    md.appendMarkdown(`${iconFor(view, now)} **`);
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
        const color = HOVER_COLORS[input.usage.stale ? "stale" : usageLevel(meter.percent)];
        md.appendMarkdown(`<span style="color:${color};">${usageBar(meter.percent)}</span> `);
        md.appendText(`${meter.label}: ${Math.floor(meter.percent)}%${resetText(meter.resetsAt, now)}`);
        md.appendMarkdown("  \n");
      }
    } else {
      md.appendText(`No usage reported${input.canRefreshUsage ? "; run Lookout: Refresh Usage" : ""}`);
    }
    md.appendMarkdown("\n\n");
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
  private shown = { visible: false, text: "", spoken: "", tooltip: "", background: "", color: "" };
  private input: StatusBarInput = { views: [], usage: undefined, enabled: true, showUsage: true, showReset: true, canRefreshUsage: false };
  private counts: Counts = countStates([]);
  /** Working sessions that have gone quiet. */
  private quiet = 0;
  private frame = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  /** Rewrites the text when the countdown's minute turns. */
  private countdown: ReturnType<typeof setTimeout> | undefined;

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem("lookout.status", vscode.StatusBarAlignment.Left, 1000);
    this.item.name = "Lookout";
    this.item.command = command;
  }

  render(input: StatusBarInput, now: number = Date.now()): void {
    this.input = input;
    this.counts = countStates(input.views);
    this.quiet = input.views.filter((view) => quietFor(view, now) !== undefined).length;
    const visible = input.enabled && (input.views.length > 0 || (input.showUsage && input.usage !== undefined));
    this.spin(visible && this.counts.working > this.quiet);
    this.tick(visible);
    this.countDown(visible, now);
    if (!visible) {
      if (this.shown.visible) this.item.hide();
      this.shown.visible = false;
      return;
    }
    this.writeText(now);
    const spoken = spokenText(this.counts, this.quiet, input.showUsage ? input.usage : undefined);
    if (spoken !== this.shown.spoken) {
      this.item.accessibilityInformation = { label: spoken };
      this.shown.spoken = spoken;
    }
    this.writeTooltip(now);
    const meter = input.showUsage ? sessionMeter(input.usage) : undefined;
    const color = input.showUsage ? usageColor(input.usage) : "";
    if (color !== this.shown.color) {
      this.item.color = color ? new vscode.ThemeColor(color) : undefined;
      this.shown.color = color;
    }
    // A question Lookout read in a reply counts, but only a prompt the agent reports lights the background.
    const blocked = input.views.some((view) => view.state === "waiting" && view.reason?.kind !== "typed");
    const background = blocked ? "warning" : meter && !input.usage?.stale && meter.percent >= USAGE_ERROR_AT ? "error" : "";
    if (background !== this.shown.background) {
      this.item.backgroundColor = background === "warning" ? this.warning : background === "error" ? this.error : undefined;
      this.shown.background = background;
    }
    if (!this.shown.visible) this.item.show();
    this.shown.visible = true;
  }

  private writeText(now: number = Date.now()): void {
    const usage = this.input.showUsage ? usageText(this.input.usage, this.input.showReset, now) : "";
    const sessions = this.input.views.length > 0 ? sessionsText(this.counts, this.quiet, this.frame) : "";
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

  /** Keeps the elapsed times in the hover, and the quiet count, current while the item is shown. */
  private tick(on: boolean): void {
    if (on && !this.ticker) {
      this.ticker = setInterval(() => {
        const now = Date.now();
        const quiet = this.input.views.filter((view) => quietFor(view, now) !== undefined).length;
        if (quiet !== this.quiet) this.render(this.input, now);
        else {
          this.writeText(now);
          this.writeTooltip(now);
        }
      }, TOOLTIP_MS);
    } else if (!on && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /**
   * Rewrites the text the moment the countdown's minute turns, rather than on
   * the minute ticker, so it says the same as the board, which counts every second.
   */
  private countDown(on: boolean, now: number): void {
    clearTimeout(this.countdown);
    this.countdown = undefined;
    const resetsAt = on && this.input.showUsage && this.input.showReset ? sessionMeter(this.input.usage)?.resetsAt : undefined;
    if (resetsAt === undefined || resetsAt <= now) return;
    const turns = (resetsAt - now) % 60_000 || 60_000;
    this.countdown = setTimeout(() => {
      const at = Date.now();
      this.writeText(at);
      this.countDown(true, at);
    }, turns + COUNTDOWN_SLACK_MS);
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
    this.countDown(false, 0);
    this.item.dispose();
  }
}
