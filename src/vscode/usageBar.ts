import * as vscode from "vscode";
import { formatElapsed } from "../core/format";
import type { Usage } from "./controller";
import { BRAND_ICON } from "./icons";

const WARN_AT = 80;
const ERROR_AT = 95;

/** "resets in 2h 10m", or nothing once the window has passed. */
function resetText(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || resetsAt <= now) return "";
  return ` · resets in ${formatElapsed(resetsAt - now)}`;
}

function text(usage: Usage | undefined): string {
  if (!usage) return `${BRAND_ICON} usage`;
  const session = usage.meters.find((m) => m.key === "session");
  const week = usage.meters.find((m) => m.key === "weekly_all");
  const parts = [session && `5h ${session.percent}%`, week && `wk ${week.percent}%`].filter(Boolean);
  if (parts.length === 0) for (const meter of usage.meters.slice(0, 2)) parts.push(`${meter.label} ${meter.percent}%`);
  return `${BRAND_ICON} ${parts.join(" · ")}`;
}

function tooltip(usage: Usage | undefined, canRefresh: boolean, now: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  if (!usage) {
    md.appendMarkdown("**Claude usage**\n\nNo numbers yet.");
  } else {
    md.appendMarkdown("**Claude usage**\n\n");
    for (const meter of usage.meters) {
      md.appendText(`${meter.label}: ${meter.percent}%${resetText(meter.resetsAt, now)}`);
      md.appendMarkdown("  \n");
    }
    md.appendMarkdown("\n");
    md.appendText(`As of ${formatElapsed(now - usage.fetchedAt)} ago${usage.stale ? " (stale)" : ""}`);
  }
  if (canRefresh) md.appendMarkdown("\n\nClick to refresh");
  return md;
}

/** The usage item in the status bar: the 5-hour and weekly limits. */
export class UsageBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly warning = new vscode.ThemeColor("statusBarItem.warningBackground");
  private readonly error = new vscode.ThemeColor("statusBarItem.errorBackground");
  private shown = { visible: false, text: "", tooltip: "", background: "" };

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem("lookout.usage", vscode.StatusBarAlignment.Left, 999);
    this.item.name = "Lookout usage";
    this.item.command = command;
  }

  render(usage: Usage | undefined, enabled: boolean, canRefresh: boolean, now: number = Date.now()): void {
    // Without numbers and without a way to get them, there is nothing to show.
    if (!enabled || (!usage && !canRefresh)) {
      if (this.shown.visible) this.item.hide();
      this.shown.visible = false;
      return;
    }
    const t = text(usage);
    if (t !== this.shown.text) this.item.text = this.shown.text = t;
    const tip = tooltip(usage, canRefresh, now);
    if (tip.value !== this.shown.tooltip) {
      this.item.tooltip = tip;
      this.shown.tooltip = tip.value;
    }
    const peak = Math.max(0, ...(usage?.meters.map((m) => m.percent) ?? []));
    const background = usage && !usage.stale ? (peak >= ERROR_AT ? "error" : peak >= WARN_AT ? "warning" : "") : "";
    if (background !== this.shown.background) {
      this.item.backgroundColor = background === "error" ? this.error : background === "warning" ? this.warning : undefined;
      this.shown.background = background;
    }
    if (!this.shown.visible) this.item.show();
    this.shown.visible = true;
  }

  dispose(): void {
    this.item.dispose();
  }
}
