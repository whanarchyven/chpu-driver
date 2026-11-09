// G-code reader for the router's .cnc files (UcanCAM output for Syntec 60W-E).
// Self-contained: used by Convex functions and by scripts/check-parse.ts under plain Node.

export type ToolStats = {
  tool: number;
  rpm: number | null;
  cutMm: number;
  timeSec: number;
  minZ: number | null;
};

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

export type GcodeStats = {
  lines: number;
  programNumber: string | null;
  tools: ToolStats[];
  toolChanges: number;
  bounds: Bounds | null;
  cutMm: number;
  rapidMm: number;
  plunges: number;
  estimatedSec: number;
  hasEnd: boolean;
  warnings: string[];
};

export type Segment = { rapid: boolean; points: Array<[number, number]> };

export type ParseOptions = {
  rapidMmPerMin?: number;
  toolChangeSec?: number;
};

const DEFAULT_RAPID = 30000;
const DEFAULT_TOOL_CHANGE_SEC = 12;
const ARC_STEP_RAD = Math.PI / 18;

type Words = Map<string, number>;

function wordsOf(line: string): { words: Words; g: number[]; m: number[] } {
  const words: Words = new Map();
  const g: number[] = [];
  const m: number[] = [];
  const clean = line.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase();
  for (const match of clean.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
    const letter = match[1] ?? "";
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (letter === "G") g.push(value);
    else if (letter === "M") m.push(value);
    else words.set(letter, value);
  }
  return { words, g, m };
}

type Walk = {
  stats: GcodeStats;
  segments: Segment[];
};

function walk(text: string, options: ParseOptions, collect: boolean): Walk {
  const rapidRate = options.rapidMmPerMin ?? DEFAULT_RAPID;
  const toolChangeSec = options.toolChangeSec ?? DEFAULT_TOOL_CHANGE_SEC;
  const rows = text.split(/\r?\n/);
  while (rows.length > 0 && rows[rows.length - 1]?.trim() === "") rows.pop();

  const stats: GcodeStats = {
    lines: rows.length,
    programNumber: null,
    tools: [],
    toolChanges: 0,
    bounds: null,
    cutMm: 0,
    rapidMm: 0,
    plunges: 0,
    estimatedSec: 0,
    hasEnd: false,
    warnings: [],
  };
  const segments: Segment[] = [];
  const toolMap = new Map<number, ToolStats>();

  let x = 0;
  let y = 0;
  let z = 0;
  let motion = 0;
  let feed = 0;
  let absolute = true;
  let pendingTool: number | null = null;
  let tool: ToolStats | null = null;
  let current: Segment | null = null;
  let missingFeed = false;

  const toolFor = (number: number): ToolStats => {
    let entry = toolMap.get(number);
    if (!entry) {
      entry = { tool: number, rpm: null, cutMm: 0, timeSec: 0, minZ: null };
      toolMap.set(number, entry);
      stats.tools.push(entry);
    }
    return entry;
  };

  const grow = (px: number, py: number, pz: number) => {
    const b = stats.bounds;
    if (!b) {
      stats.bounds = { minX: px, maxX: px, minY: py, maxY: py, minZ: pz, maxZ: pz };
      return;
    }
    b.minX = Math.min(b.minX, px);
    b.maxX = Math.max(b.maxX, px);
    b.minY = Math.min(b.minY, py);
    b.maxY = Math.max(b.maxY, py);
    b.minZ = Math.min(b.minZ, pz);
    b.maxZ = Math.max(b.maxZ, pz);
  };

  const addPoint = (rapid: boolean, px: number, py: number) => {
    if (!collect) return;
    if (!current || current.rapid !== rapid) {
      current = { rapid, points: [[x, y]] };
      segments.push(current);
    }
    current.points.push([px, py]);
  };

  for (const raw of rows) {
    const line = raw.trim();
    if (line === "" || line === "%") continue;
    const program = /^O(\d+)/i.exec(line);
    if (program && stats.programNumber === null) stats.programNumber = program[1] ?? null;
    const { words, g, m } = wordsOf(line);

    let machineCoords = false;
    for (const code of g) {
      if (code === 0 || code === 1 || code === 2 || code === 3) motion = code;
      else if (code === 90) absolute = true;
      else if (code === 91) absolute = false;
      else if (code === 53) machineCoords = true;
    }
    const t = words.get("T");
    if (t !== undefined) pendingTool = t;
    for (const code of m) {
      if (code === 6) {
        stats.toolChanges += 1;
        stats.estimatedSec += toolChangeSec;
        // The spindle speed for the new tool comes in the following M3 S... block.
        if (pendingTool !== null) tool = toolFor(pendingTool);
      } else if (code === 30 || code === 2) {
        stats.hasEnd = true;
      }
    }
    const s = words.get("S");
    if (s !== undefined && tool && tool.rpm === null) tool.rpm = s;
    const f = words.get("F");
    if (f !== undefined && f > 0) feed = f;

    const hasMove = words.has("X") || words.has("Y") || words.has("Z");
    // G53 moves go to machine coordinates (park/home), they do not belong to the part.
    if (!hasMove || machineCoords) continue;

    const nx = words.has("X") ? (absolute ? (words.get("X") ?? x) : x + (words.get("X") ?? 0)) : x;
    const ny = words.has("Y") ? (absolute ? (words.get("Y") ?? y) : y + (words.get("Y") ?? 0)) : y;
    const nz = words.has("Z") ? (absolute ? (words.get("Z") ?? z) : z + (words.get("Z") ?? 0)) : z;

    if (motion === 0) {
      const length = Math.hypot(nx - x, ny - y, nz - z);
      stats.rapidMm += length;
      stats.estimatedSec += (length / rapidRate) * 60;
      addPoint(true, nx, ny);
    } else {
      let length: number;
      if (motion === 1) {
        length = Math.hypot(nx - x, ny - y, nz - z);
        if (collect) addPoint(false, nx, ny);
      } else {
        const arc = arcOf(x, y, nx, ny, motion === 2, words);
        if (!arc) {
          stats.warnings.push(`дуга без R/I/J: ${line.slice(0, 60)}`);
          length = Math.hypot(nx - x, ny - y, nz - z);
          addPoint(false, nx, ny);
        } else {
          length = Math.hypot(arc.length, nz - z);
          if (collect) for (const [px, py] of arc.points) addPoint(false, px, py);
        }
      }
      if (nz < z && Math.hypot(nx - x, ny - y) < 1e-6) stats.plunges += 1;
      stats.cutMm += length;
      if (feed > 0) {
        const sec = (length / feed) * 60;
        stats.estimatedSec += sec;
        if (tool) tool.timeSec += sec;
      } else if (length > 0) {
        missingFeed = true;
      }
      if (tool) {
        tool.cutMm += length;
        tool.minZ = tool.minZ === null ? Math.min(z, nz) : Math.min(tool.minZ, z, nz);
      }
      grow(x, y, z);
      grow(nx, ny, nz);
    }
    x = nx;
    y = ny;
    z = nz;
  }

  if (missingFeed) stats.warnings.push("рабочий ход без подачи F");
  if (!stats.hasEnd) stats.warnings.push("нет M30 в конце программы");
  if (stats.tools.length === 0) stats.warnings.push("нет смены инструмента M06 T");
  stats.cutMm = round(stats.cutMm, 1);
  stats.rapidMm = round(stats.rapidMm, 1);
  stats.estimatedSec = Math.round(stats.estimatedSec);
  for (const entry of stats.tools) {
    entry.cutMm = round(entry.cutMm, 1);
    entry.timeSec = Math.round(entry.timeSec);
    if (entry.minZ !== null) entry.minZ = round(entry.minZ, 3);
  }
  if (stats.bounds) {
    const b = stats.bounds;
    stats.bounds = {
      minX: round(b.minX, 3),
      maxX: round(b.maxX, 3),
      minY: round(b.minY, 3),
      maxY: round(b.maxY, 3),
      minZ: round(b.minZ, 3),
      maxZ: round(b.maxZ, 3),
    };
  }
  return { stats, segments };
}

function arcOf(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  clockwise: boolean,
  words: Words,
): { length: number; points: Array<[number, number]> } | null {
  let cx: number;
  let cy: number;
  const r = words.get("R");
  if (words.has("I") || words.has("J")) {
    cx = x0 + (words.get("I") ?? 0);
    cy = y0 + (words.get("J") ?? 0);
  } else if (r !== undefined) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const chord = Math.hypot(dx, dy);
    if (chord === 0) return null;
    const half = chord / 2;
    const h = Math.sqrt(Math.max(0, r * r - half * half));
    // R>0 takes the short arc, R<0 the long one; the centre side depends on direction.
    const sign = (clockwise ? 1 : -1) * (r >= 0 ? 1 : -1);
    cx = x0 + dx / 2 + (sign * h * dy) / chord;
    cy = y0 + dy / 2 - (sign * h * dx) / chord;
  } else {
    return null;
  }
  const radius = Math.hypot(x0 - cx, y0 - cy);
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  if (clockwise) {
    while (a1 >= a0) a1 -= 2 * Math.PI;
  } else {
    while (a1 <= a0) a1 += 2 * Math.PI;
  }
  if (Math.hypot(x1 - x0, y1 - y0) < 1e-9) a1 = a0 + (clockwise ? -2 : 2) * Math.PI;
  const sweep = a1 - a0;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP_RAD));
  const points: Array<[number, number]> = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    points.push(i === steps ? [x1, y1] : [cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return { length: Math.abs(sweep) * radius, points };
}

function round(value: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

export function parseGcode(text: string, options: ParseOptions = {}): GcodeStats {
  return walk(text, options, false).stats;
}

// Top view (XY) of the toolpath: cuts solid, rapids dashed. Y grows up like on the machine table.
export function gcodePreviewSvg(text: string, options: ParseOptions & { width?: number } = {}): string {
  const { stats, segments } = walk(text, options, true);
  const b = stats.bounds;
  const width = options.width ?? 900;
  if (!b) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="60"><text x="10" y="35">нет рабочих ходов</text></svg>`;
  }
  const pad = 10;
  const spanX = Math.max(1, b.maxX - b.minX);
  const spanY = Math.max(1, b.maxY - b.minY);
  const scale = (width - 2 * pad) / spanX;
  const height = Math.max(60, Math.round(spanY * scale + 2 * pad));
  const px = (value: number) => (pad + (value - b.minX) * scale).toFixed(1);
  const py = (value: number) => (height - pad - (value - b.minY) * scale).toFixed(1);
  const cut: string[] = [];
  const rapid: string[] = [];
  for (const segment of segments) {
    const first = segment.points[0];
    if (!first || segment.points.length < 2) continue;
    let d = `M${px(first[0])} ${py(first[1])}`;
    for (let i = 1; i < segment.points.length; i++) {
      const point = segment.points[i];
      if (point) d += `L${px(point[0])} ${py(point[1])}`;
    }
    (segment.rapid ? rapid : cut).push(d);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="#fbfaf7"/>`,
    `<path d="${rapid.join("")}" fill="none" stroke="#9aa4b2" stroke-width="0.6" stroke-dasharray="3 3"/>`,
    `<path d="${cut.join("")}" fill="none" stroke="#1f5fbf" stroke-width="1.2" stroke-linejoin="round"/>`,
    `</svg>`,
  ].join("");
}

export type ProgramName = {
  brand: string | null;
  kind: string | null;
  side: "L" | "R" | null;
  widthMm: number | null;
  thicknessMm: number | null;
};

// Names like Ard_LIC_L_86-1_10mm, Pi_nal_860_12L_10mm, BR01_nal_L-960-11_10.
export function parseProgramName(fileName: string, folder?: string): ProgramName {
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const parts = stem.split(/[_]/).filter(Boolean);
  const brand = parts[0] ?? null;
  const kind = parts.length > 1 ? (parts[1] ?? null) : null;
  const rest = parts.slice(2).join("_");
  const sideMatch = /(?:^|[_-])([LR])(?:[_-]|$)/.exec(rest) ?? /\d+([LR])(?:[_-]|$)/.exec(rest);
  const side = (sideMatch?.[1] as "L" | "R" | undefined) ?? null;
  let widthMm: number | null = null;
  const width = /(?:^|[_-])(8[0-9]0|9[0-9]0|8[0-9]|9[0-9])(?:[_-]|$)/.exec(rest);
  if (width?.[1]) widthMm = Number(width[1]) < 100 ? Number(width[1]) * 10 : Number(width[1]);
  if (widthMm === null && folder) {
    const fromFolder = /(?:^|[\\/])(\d{3})(?:[\\/]|$)/.exec(folder);
    if (fromFolder?.[1]) widthMm = Number(fromFolder[1]);
  }
  const thick = /_(\d+(?:[.,]\d+)?)(?:mm)?$/i.exec(stem);
  const thicknessMm = thick?.[1] ? Number(thick[1].replace(",", ".")) : null;
  return { brand, kind, side, widthMm, thicknessMm };
}
