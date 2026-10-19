import * as vscode from "vscode";
import { AGENTS, agentInfo } from "../core/agents/catalog";
import { formatCountdown, formatResetIn } from "../core/format";
import type { UsageMeter } from "../core/usage";
import { groupHeading, pickBar, sortGroups, type UsageGroup } from "../core/usageGroups";
import type { Usage } from "./controller";
import { agentIcon, BRAND_ICON } from "./icons";

/** How often the reset times in the hover are refreshed. */
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
  /** Claude's usage, when `usageGroups` is not given. */
  usage: Usage | undefined;
  /** Every agent's usage, one group each. */
  usageGroups?: readonly UsageGroup[];
  /** Whose bar the item shows: `auto`, or an agent's key. */
  usageAgent?: string;
  /** Tell the agents apart: their marks in the hover, and before the bar. */
  markers?: boolean;
  enabled: boolean;
  showUsage: boolean;
  /** The time until the 5-hour window resets, after the bar. */
  showReset: boolean;
  canRefreshUsage: boolean;
}

/** Every agent's usage, in catalog order; from Claude's alone when the input has no groups. */
function groupsOf(input: StatusBarInput): UsageGroup[] {
  if (input.usageGroups) return sortGroups(input.usageGroups);
  const usage = input.usage;
  return [{ agent: AGENTS[0]!.id, fetchedAt: usage?.fetchedAt, stale: usage?.stale ?? false, meters: usage?.meters ?? [], canRefresh: input.canRefreshUsage }];
}

/**
 * The bar the item shows: one agent's window, the 5-hour one for Claude; by
 * default the one under the most pressure. The hover has the rest.
 */
interface Bar {
  group: UsageGroup;
  meter: UsageMeter;
  /** Its agent's mark goes before it: more than one agent reports usage, or the markers are on. */
  marked: boolean;
}

function barOf(input: StatusBarInput): Bar | undefined {
  const groups = groupsOf(input);
  const picked = pickBar(groups, input.usageAgent);
  if (!picked) return undefined;
  const reporting = groups.filter((group) => group.meters.length > 0).length;
  return { ...picked, marked: input.markers === true || reporting > 1 };
}

/** A bar of ten cells for a percentage, e.g. ▰▰▱▱▱▱▱▱▱▱ for 18%. */
export function usageBar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(percent / (100 / BAR_CELLS))));
  return `${"▰".repeat(filled)}${"▱".repeat(BAR_CELLS - filled)}`;
}

function usageLevel(percent: number): keyof typeof BAR_COLORS {
  return percent >= 80 ? "high" : percent >= 50 ? "mid" : "low";
}

function usageText(bar: Bar | undefined, showReset: boolean, now: number): string {
  if (!bar) return "";
  const { meter } = bar;
  const reset = showReset && meter.resetsAt !== undefined && meter.resetsAt > now ? ` · ${formatCountdown(meter.resetsAt - now)}` : "";
  const mark = bar.marked ? `${agentIcon(bar.group.agent)} ` : "";
  return `${mark}${usageBar(meter.percent)} ${meter.percent}%${reset}`;
}

/** Grey when stale, else by consumption. */
function usageColor(bar: Bar | undefined): string {
  if (!bar) return "";
  if (bar.group.stale) return STALE_COLOR;
  return BAR_COLORS[usageLevel(bar.meter.percent)];
}

function spokenText(bar: Bar | undefined): string {
  if (!bar) return "Lookout";
  const whose = bar.marked ? `${agentInfo(bar.group.agent).label} ` : "";
  return `Lookout: usage ${whose}${bar.meter.label} ${bar.meter.percent}%`;
}

/** " · resets in 3h", as Claude Code's panel says it. */
function resetText(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || resetsAt <= now) return "";
  return ` · resets ${formatResetIn(resetsAt - now)}`;
}

/** The agent's mark in its hue, for the hover, where only an inline style can colour it. */
function hoverMark(agent: string): string {
  const info = agentInfo(agent);
  const light = (vscode.window.activeColorTheme as vscode.ColorTheme | undefined)?.kind;
  // ColorThemeKind.Light and HighContrastLight.
  const color = light === 1 || light === 4 ? info.colors.light : info.colors.dark;
  return `<span style="color:${color};">${agentIcon(agent)}</span>`;
}

function tooltip(input: StatusBarInput, now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  // For the coloured usage bars; VS Code keeps only colour styles.
  md.supportHtml = true;
  if (input.showUsage) {
    const groups = groupsOf(input);
    const marked = input.markers === true || groups.filter((group) => group.meters.length > 0).length > 1;
    for (const group of groups) {
      md.appendMarkdown(`${marked ? `${hoverMark(group.agent)} ` : ""}**${groupHeading(group.agent)}**  \n`);
      if (group.meters.length > 0) {
        for (const meter of group.meters) {
          const color = HOVER_COLORS[group.stale ? "stale" : usageLevel(meter.percent)];
          md.appendMarkdown(`<span style="color:${color};">${usageBar(meter.percent)}</span> `);
          md.appendText(`${meter.label}: ${Math.floor(meter.percent)}%${resetText(meter.resetsAt, now)}`);
          md.appendMarkdown("  \n");
        }
      } else {
        md.appendText(group.note ?? `No usage reported${group.canRefresh ? "; run Lookout: Refresh Usage" : ""}`);
      }
      md.appendMarkdown("\n\n");
    }
    md.appendMarkdown("---\n\n");
  }
  md.appendMarkdown("Click to open Lookout");
  return md;
}

/**
 * The status bar item: the lighthouse and the usage, nothing about the
 * sessions, which the board shows; a click opens the board. Every property
 * write is a message to the VS Code UI, so it writes a property only when its
 * value changes.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly error = new vscode.ThemeColor("statusBarItem.errorBackground");
  private shown = { visible: false, text: "", spoken: "", tooltip: "", background: "", color: "" };
  private input: StatusBarInput = { usage: undefined, enabled: true, showUsage: true, showReset: true, canRefreshUsage: false };
  private ticker: ReturnType<typeof setInterval> | undefined;
  /** Rewrites the text when the countdown's minute turns. */
  private countdown: ReturnType<typeof setTimeout> | undefined;

  /** `command`: what a click runs, the board. */
  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem("lookout.status", vscode.StatusBarAlignment.Left, 1000);
    this.item.name = "Lookout";
    this.item.command = command;
  }

  render(input: StatusBarInput, now: number = Date.now()): void {
    this.input = input;
    const visible = input.enabled;
    this.tick(visible);
    this.countDown(visible, now);
    if (!visible) {
      if (this.shown.visible) this.item.hide();
      this.shown.visible = false;
      return;
    }
    this.writeText(now);
    const bar = input.showUsage ? barOf(input) : undefined;
    const spoken = spokenText(bar);
    if (spoken !== this.shown.spoken) {
      this.item.accessibilityInformation = { label: spoken };
      this.shown.spoken = spoken;
    }
    this.writeTooltip(now);
    const color = usageColor(bar);
    if (color !== this.shown.color) {
      this.item.color = color ? new vscode.ThemeColor(color) : undefined;
      this.shown.color = color;
    }
    const background = bar && !bar.group.stale && bar.meter.percent >= USAGE_ERROR_AT ? "error" : "";
    if (background !== this.shown.background) {
      this.item.backgroundColor = background === "error" ? this.error : undefined;
      this.shown.background = background;
    }
    if (!this.shown.visible) this.item.show();
    this.shown.visible = true;
  }

  private writeText(now: number = Date.now()): void {
    const usage = this.input.showUsage ? usageText(barOf(this.input), this.input.showReset, now) : "";
    const text = usage ? `${BRAND_ICON} ${usage}` : BRAND_ICON;
    if (text !== this.shown.text) this.item.text = this.shown.text = text;
  }

  private writeTooltip(now: number): void {
    const tip = tooltip(this.input, now);
    if (tip.value !== this.shown.tooltip) {
      this.item.tooltip = tip;
      this.shown.tooltip = tip.value;
    }
  }

  /** Keeps the reset times in the hover current while the item is shown. */
  private tick(on: boolean): void {
    if (on && !this.ticker) {
      this.ticker = setInterval(() => {
        const now = Date.now();
        this.writeText(now);
        this.writeTooltip(now);
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
    const resetsAt = on && this.input.showUsage && this.input.showReset ? barOf(this.input)?.meter.resetsAt : undefined;
    if (resetsAt === undefined || resetsAt <= now) return;
    const turns = (resetsAt - now) % 60_000 || 60_000;
    this.countdown = setTimeout(() => {
      const at = Date.now();
      this.writeText(at);
      this.countDown(true, at);
    }, turns + COUNTDOWN_SLACK_MS);
  }

  dispose(): void {
    this.tick(false);
    this.countDown(false, 0);
    this.item.dispose();
  }
}
