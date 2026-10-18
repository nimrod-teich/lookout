/// <reference lib="dom" />
// The harbour: a night scene with the lighthouse, its beam, and the sessions
// as boats on the water. The beam sweeps on its own, lights the boats it
// passes, and swings to a boat before a jump.
import { agentInfo } from "../core/agents/catalog";
import type { SessionView } from "../core/types";
import { HARBOUR, layoutBoats, waterline, type Boat } from "./model";

const SVG = "http://www.w3.org/2000/svg";
/** Half the beam's opening, in degrees. */
const BEAM_HALF = 7;
/** The sweep: degrees below the horizontal. */
const SWEEP_FROM = 6;
const SWEEP_TO = 27;
const SWEEP_PERIOD_MS = 9000;
const SWING_MS = 380;
const FRAME_MS = 33;
/** The agent's boat in the harbour: its silhouette at this scale, the lantern on its deck. */
const CRAFT_SCALE = 0.95;
const STARS: [number, number, number][] = [[62, 14, 0.6], [118, 28, 0.45], [151, 10, 0.7], [196, 22, 0.5], [233, 38, 0.3], [262, 12, 0.6], [286, 30, 0.4], [94, 46, 0.3], [176, 44, 0.35], [222, 7, 0.4]];

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, className?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute("class", className);
  return node;
}

export class Harbour {
  readonly element: SVGSVGElement;
  private readonly sea: SVGRectElement;
  private readonly waves: SVGGElement;
  private readonly tideLabel: SVGTextElement;
  private readonly beam: SVGGElement;
  private readonly boatsLayer: SVGGElement;
  private readonly boats = new Map<string, { node: SVGGElement; boat: Boat }>();
  private angle = SWEEP_FROM;
  private swing: { to: number; from: number; startedAt: number; done: () => void } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly reduceMotion: boolean;

  constructor(
    private readonly onJump: (id: string) => void,
    /** Called with the boat under the pointer, in SVG units, and with nothing when it leaves. */
    private readonly onHover: (boat: Boat | undefined) => void = () => {},
    /** Lookout can bring the session forward; a boat it cannot is not a link. */
    private readonly jumpable: (id: string) => boolean = () => true,
  ) {
    this.reduceMotion = document.body.classList.contains("vscode-reduce-motion");
    const root = svg("svg", { viewBox: `0 0 ${HARBOUR.width} ${HARBOUR.height}`, preserveAspectRatio: "xMidYMax slice" }, "harbour");
    root.setAttribute("aria-hidden", "true");
    const defs = svg("defs");
    defs.innerHTML = `
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06101a"/><stop offset="1" stop-color="#0c2238"/></linearGradient>
      <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#124a68"/><stop offset="1" stop-color="#061b2b"/></linearGradient>
      <linearGradient id="light" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff3d1" stop-opacity="0.6"/><stop offset="0.5" stop-color="#fff3d1" stop-opacity="0.16"/><stop offset="1" stop-color="#fff3d1" stop-opacity="0"/></linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="#ffd66b" stop-opacity="0.9"/><stop offset="1" stop-color="#ffd66b" stop-opacity="0"/></radialGradient>
      <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"/></filter>`;
    root.append(defs);
    root.append(svg("rect", { width: HARBOUR.width, height: HARBOUR.height, fill: "url(#sky)" }));
    const stars = svg("g", {}, "stars");
    for (const [x, y, o] of STARS) stars.append(svg("circle", { cx: x, cy: y, r: 0.9, opacity: o }));
    root.append(stars);
    this.sea = svg("rect", { x: 0, y: HARBOUR.seaTop, width: HARBOUR.width, height: HARBOUR.height - HARBOUR.seaTop, fill: "url(#water)" });
    root.append(this.sea);
    this.waves = svg("g", {}, "waves");
    this.waves.append(svg("path"), svg("path"));
    root.append(this.waves);
    this.tideLabel = svg("text", { x: HARBOUR.width - 6, "text-anchor": "end" }, "tide");
    root.append(this.tideLabel);
    // The beam is drawn in its own frame, pointing along +x, and rotated around the lamp.
    this.beam = svg("g", { transform: `translate(${HARBOUR.lampX} ${HARBOUR.lampY}) rotate(${this.angle})` }, "beam");
    const reach = 330;
    const spread = Math.tan((BEAM_HALF * Math.PI) / 180) * reach;
    this.beam.append(svg("path", { d: `M0 0 L${reach} ${-spread} L${reach} ${spread} Z`, fill: "url(#light)" }));
    root.append(this.beam);
    this.boatsLayer = svg("g", {}, "boats");
    root.append(this.boatsLayer);
    root.append(this.lighthouse());
    this.element = root;
    this.setWater(waterline(undefined), undefined);
    this.start();
  }

  private lighthouse(): SVGGElement {
    const g = svg("g", {}, "lighthouse");
    const { lampX: x, lampY: y } = HARBOUR;
    g.append(svg("path", { d: `M0 ${HARBOUR.height} L0 104 Q14 92 30 96 Q46 92 58 100 L58 ${HARBOUR.height} Z` }, "rock"));
    g.append(svg("path", { d: `M${x - 7.5} 96 L${x - 4.5} ${y + 10} L${x + 4.5} ${y + 10} L${x + 7.5} 96 Z` }, "tower"));
    g.append(svg("path", { d: `M${x - 6.3} 82 L${x + 6.3} 82 M${x - 5.6} 73 L${x + 5.6} 73` }, "band"));
    g.append(svg("rect", { x: x - 6.5, y: y + 8.5, width: 13, height: 2.2, rx: 0.6 }, "gallery"));
    g.append(svg("circle", { cx: x, cy: y + 2, r: 16, fill: "url(#glow)" }, "lamp-glow"));
    g.append(svg("rect", { x: x - 3.6, y: y - 2, width: 7.2, height: 10.5, rx: 0.8 }, "lantern"));
    g.append(svg("path", { d: `M${x - 4.2} ${y - 2} A4.2 4.2 0 0 1 ${x + 4.2} ${y - 2} Z` }, "dome"));
    g.append(svg("path", { d: `M${x} ${y - 6.2} L${x} ${y - 9}` }, "spire"));
    return g;
  }

  /** Updates the boats and the tide; with `markers`, each boat wears its agent's silhouette and hue. */
  update(views: readonly SessionView[], usagePercent: number | undefined, now: number, markers = false): void {
    const water = waterline(usagePercent);
    this.setWater(water, usagePercent);
    const seen = new Set<string>();
    for (const boat of layoutBoats(views, now, water)) {
      seen.add(boat.id);
      let entry = this.boats.get(boat.id);
      if (!entry) {
        const node = svg("g", {}, "boat");
        // The hit area is wider than the lamp, so the pointer finds the boat easily.
        node.append(svg("rect", { x: -1, y: 5, width: 2, height: 16, rx: 1 }, "reflection"), svg("circle", { r: 7, filter: "url(#soft)" }, "halo"), svg("circle", { r: 3.2 }, "lamp"), svg("circle", { r: 11 }, "hit"));
        const text = svg("text", { x: 9, y: 2.6 }, "label");
        node.append(text);
        const id = boat.id;
        node.addEventListener("click", () => this.jump(id));
        node.addEventListener("mouseenter", () => {
          node.classList.add("hover");
          this.onHover(this.boats.get(id)?.boat);
        });
        node.addEventListener("mouseleave", () => {
          node.classList.remove("hover");
          this.onHover(undefined);
        });
        this.boatsLayer.append(node);
        entry = { node, boat };
        this.boats.set(boat.id, entry);
      }
      entry.boat = boat;
      this.dress(entry.node, boat.agent, markers);
      entry.node.setAttribute("class", `boat state-${boat.state}${markers ? " marked" : ""}${this.jumpable(boat.id) ? "" : " nojump"}${entry.node.classList.contains("hover") ? " hover" : ""}`);
      entry.node.setAttribute("transform", `translate(${boat.x} ${boat.y})`);
      const label = entry.node.querySelector(".label") as SVGTextElement;
      label.textContent = boat.label ?? "";
      // The label reads from the boat's right; from its left when that would run off the right
      // edge and the left has more room; and it slides along the boat when neither side has enough.
      const length = boat.label === undefined ? 0 : textLength(label);
      const roomRight = HARBOUR.width - boat.x - 9;
      const roomLeft = boat.x - 9 - ROCK_WIDTH;
      const flip = length > roomRight && roomLeft > roomRight;
      const x = flip ? -9 + Math.max(0, length - roomLeft + 2) : 9 - Math.max(0, length - roomRight + 2);
      label.setAttribute("x", String(Math.round(x * 10) / 10));
      label.setAttribute("text-anchor", flip ? "end" : "start");
    }
    for (const [id, entry] of this.boats) {
      if (seen.has(id)) continue;
      if (entry.node.classList.contains("hover")) this.onHover(undefined);
      entry.node.remove();
      this.boats.delete(id);
    }
    this.light();
  }

  /**
   * Puts the agent's silhouette under the boat's lantern, or takes it away:
   * the lantern keeps its place and its state colour at the masthead, the
   * hull and sails take the agent's hue.
   */
  private dress(node: SVGGElement, agent: string, markers: boolean): void {
    let craft = node.querySelector<SVGPathElement>(".craft");
    if (!markers) {
      craft?.remove();
      return;
    }
    const { glyph, colors } = agentInfo(agent);
    if (!craft) {
      craft = svg("path", {}, "craft");
      node.insertBefore(craft, node.querySelector(".halo"));
    }
    // The scene is a night one whatever the theme: the hue for dark backgrounds.
    craft.style.fill = colors.dark;
    if (craft.getAttribute("d") !== glyph.path) {
      craft.setAttribute("d", glyph.path);
      craft.setAttribute("transform", `scale(${CRAFT_SCALE}) translate(${-glyph.lamp[0]} ${-glyph.lamp[1]})`);
    }
  }

  /** Lights a boat from outside, for the card the pointer is on. */
  highlight(id: string, on: boolean): void {
    this.boats.get(id)?.node.classList.toggle("hover", on);
  }

  boatFor(id: string): Boat | undefined {
    return this.boats.get(id)?.boat;
  }

  /** The boat's position in CSS pixels relative to the scene's element. */
  position(boat: Boat): { x: number; y: number; width: number } {
    const rect = this.element.getBoundingClientRect();
    const scale = rect.width / HARBOUR.width;
    return { x: boat.x * scale, y: boat.y * scale, width: rect.width };
  }

  private setWater(water: number, usagePercent: number | undefined): void {
    this.sea.setAttribute("y", String(water));
    this.sea.setAttribute("height", String(HARBOUR.height - water));
    const [a, b] = this.waves.children as unknown as [SVGPathElement, SVGPathElement];
    a.setAttribute("d", `M-10 ${water + 12} Q 40 ${water + 10} 90 ${water + 12} T 190 ${water + 12} T 310 ${water + 12}`);
    b.setAttribute("d", `M-10 ${water + 30} Q 50 ${water + 28} 110 ${water + 30} T 230 ${water + 30} T 310 ${water + 30}`);
    this.tideLabel.setAttribute("y", String(water - 3));
    this.tideLabel.textContent = usagePercent === undefined ? "" : `5h ${Math.round(usagePercent)}%`;
  }

  /** Swings the beam to the boat, then jumps; without the boat, or under reduced motion, jumps at once. */
  jump(id: string): void {
    if (!this.jumpable(id)) return;
    const entry = this.boats.get(id);
    if (!entry || this.reduceMotion) {
      this.onJump(id);
      return;
    }
    this.swing = { from: this.angle, to: entry.boat.bearing, startedAt: performance.now(), done: () => this.onJump(id) };
  }

  /** Boats inside the beam glow. */
  private light(): void {
    for (const entry of this.boats.values()) {
      entry.node.classList.toggle("lit", Math.abs(entry.boat.bearing - this.angle) <= BEAM_HALF);
    }
  }

  private frame(): void {
    if (document.visibilityState !== "visible") return;
    const t = performance.now();
    if (this.swing) {
      const k = Math.min(1, (t - this.swing.startedAt) / SWING_MS);
      const ease = 1 - Math.pow(1 - k, 3);
      this.angle = this.swing.from + (this.swing.to - this.swing.from) * ease;
      if (k >= 1) {
        const done = this.swing.done;
        this.swing = undefined;
        done();
      }
    } else if (!this.reduceMotion) {
      const phase = (t % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS;
      this.angle = SWEEP_FROM + ((SWEEP_TO - SWEEP_FROM) * (1 - Math.cos(phase * 2 * Math.PI))) / 2;
    } else {
      this.angle = (SWEEP_FROM + SWEEP_TO) / 2;
    }
    this.beam.setAttribute("transform", `translate(${HARBOUR.lampX} ${HARBOUR.lampY}) rotate(${this.angle.toFixed(2)})`);
    this.light();
  }

  private start(): void {
    this.frame();
    if (!this.reduceMotion) this.timer = setInterval(() => this.frame(), FRAME_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** How far the headland under the lighthouse reaches into the harbour: a label behind it cannot be read. */
const ROCK_WIDTH = 58;

/** The rendered width of an SVG text, or 0 where the DOM cannot measure (tests). */
function textLength(text: SVGTextElement): number {
  try {
    return text.getComputedTextLength();
  } catch {
    return 0;
  }
}
