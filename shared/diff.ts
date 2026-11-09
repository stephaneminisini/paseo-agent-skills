export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

export const MAX_DIFF_LINES = 5000;
/** Edit distance above which the diff falls back to "all removed, then all added". */
const MAX_EDIT_DISTANCE = 2000;

function splitLines(text: string): string[] {
  return text.split("\n");
}

/**
 * Line diff from `before` to `after` (Myers). Returns null when either side has more than
 * MAX_DIFF_LINES lines. Very different texts get a non-minimal but valid diff.
 */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: "same", text }));
  const middle = myers(a.slice(start, endA), b.slice(start, endB));
  return [...head, ...middle, ...tail];
}

function fallback(a: string[], b: string[]): DiffLine[] {
  return [
    ...a.map((text): DiffLine => ({ kind: "removed", text })),
    ...b.map((text): DiffLine => ({ kind: "added", text })),
  ];
}

function myers(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return fallback(a, b);
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0;
      else x = (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d, offset);
    }
    v = next;
  }
  return fallback(a, b);
}

function backtrack(a: string[], b: string[], trace: Int32Array[], d: number, offset: number): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let step = d; step > 0; step -= 1) {
    const v = trace[step] as Int32Array;
    const k = x - y;
    const prevK =
      k === -step || (k !== step && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0)) ? k + 1 : k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ kind: "same", text: a[x - 1] as string });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) out.push({ kind: "added", text: b[y - 1] as string });
    else out.push({ kind: "removed", text: a[x - 1] as string });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    out.push({ kind: "same", text: a[x - 1] as string });
    x -= 1;
    y -= 1;
  }
  return out.reverse();
}

export type DisplayLine = DiffLine | { kind: "skip"; count: number };

/** Replaces unchanged runs longer than `minRun` lines with a skip marker, keeping `context` lines next to changes. */
export function collapseDiff(lines: DiffLine[], context = 3, minRun = 6): DisplayLine[] {
  const out: DisplayLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as DiffLine;
    if (line.kind !== "same") {
      out.push(line);
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && (lines[end] as DiffLine).kind === "same") end += 1;
    const run = lines.slice(index, end);
    const keepBefore = index === 0 ? 0 : context;
    const keepAfter = end === lines.length ? 0 : context;
    if (run.length > minRun && run.length > keepBefore + keepAfter) {
      out.push(...run.slice(0, keepBefore));
      out.push({ kind: "skip", count: run.length - keepBefore - keepAfter });
      out.push(...run.slice(run.length - keepAfter));
    } else {
      out.push(...run);
    }
    index = end;
  }
  return out;
}
