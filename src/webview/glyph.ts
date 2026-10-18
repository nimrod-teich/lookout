/// <reference lib="dom" />
// An agent's mark in a webview: its silhouette from the catalog, in its hue.
import { agentInfo } from "../core/agents/catalog";

const SVG = "http://www.w3.org/2000/svg";

/** The agent's silhouette at `size` CSS pixels, filled with its hue; its name for screen readers and the pointer. */
export function agentGlyph(agent: string, size: number, className = "glyph"): SVGSVGElement {
  const info = agentInfo(agent);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", `${className} agent-${info.key}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", info.label);
  const title = document.createElementNS(SVG, "title");
  title.textContent = info.label;
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", info.glyph.path);
  svg.append(title, path);
  svg.style.fill = `var(${info.hue})`;
  return svg;
}
