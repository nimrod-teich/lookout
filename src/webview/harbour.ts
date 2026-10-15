/// <reference lib="dom" />
// The harbour: a night scene with the lighthouse, its beam, and the sessions
// as boats on the water. The beam sweeps on its own, lights the boats it
// passes, and swings to a boat before a jump.
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

  constructor(private readonly onJump: (id: string) => void) {
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

  /** Updates the boats and the tide. */
  update(views: readonly SessionView[], usagePercent: number | undefined, now: number): void {
    const water = waterline(usagePercent);
    this.setWater(water, usagePercent);
    const seen = new Set<string>();
    for (const boat of layoutBoats(views, now, water)) {
      seen.add(boat.id);
      let entry = this.boats.get(boat.id);
      if (!entry) {
        const node = svg("g", {}, "boat");
        node.append(svg("rect", { x: -1, y: 5, width: 2, height: 16, rx: 1 }, "reflection"), svg("circle", { r: 7, filter: "url(#soft)" }, "halo"), svg("circle", { r: 3.2 }, "lamp"), svg("title"));
        const text = svg("text", { x: 9, y: 2.6 }, "label");
        node.append(text);
        node.addEventListener("click", () => this.jump(boat.id));
        this.boatsLayer.append(node);
        entry = { node, boat };
        this.boats.set(boat.id, entry);
      }
      entry.boat = boat;
      entry.node.setAttribute("class", `boat state-${boat.state}`);
      entry.node.setAttribute("transform", `translate(${boat.x} ${boat.y})`);
      entry.node.querySelector("title")!.textContent = boat.title;
      const label = entry.node.querySelector(".label")!;
      label.textContent = boat.label ?? "";
      // A label that would run off the right edge sits on the left of the boat instead.
      const flip = boat.label !== undefined && boat.x > HARBOUR.width * 0.55;
      label.setAttribute("x", flip ? "-9" : "9");
      label.setAttribute("text-anchor", flip ? "end" : "start");
    }
    for (const [id, entry] of this.boats) {
      if (seen.has(id)) continue;
      entry.node.remove();
      this.boats.delete(id);
    }
    this.light();
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
