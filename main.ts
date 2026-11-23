// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 5: files, lines and matching ----

/** A file's lines, its own line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    parts.pop();
  }
  return { lines: parts, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A line of N: `text` as the patch wrote it, `ctx` the index into O when it is a context line, -1 otherwise. */
interface NLine {
  text: string;
  ctx: number;
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions i at or after `from` where O matches lines[i..] at `tier`. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const nO = o.map((l) => normLine(l, tier));
  const start = Math.max(0, from);
  for (let i = start; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(lines[i + k]!, tier) !== nO[k]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0, 1, 2, or only 0 when strict) at which O occurs at or after `from`. */
function findTiered(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The replacement lines for an occurrence at `start`: context lines are the file's own matched lines; at tier 2 every other line is re-indented (section 5). */
function buildNewLines(fileLines: string[], o: string[], n: NLine[], start: number, tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = /^[ \t]*/.exec(fileLines[start] ?? '')![0];
    p = /^[ \t]*/.exec(o[0] ?? '')![0];
  }
  for (const nl of n) {
    if (nl.ctx >= 0) {
      out.push(fileLines[start + nl.ctx]!);
      continue;
    }
    const t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

/** Moves a successful edit recorded, as [old, new] pairs, for the `R` output lines (section 2). */
const moves: Array<[string, string]> = [];
function recordMove(oldP: string, newP: string): void {
  moves.push([oldP, newP]);
}

/** O and N from body lines (unified hunk or V4A chunk): ' ' and '' are context, '-' old, '+' new, '\' skipped. */
function chunkON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const r of body) {
    if (r === '' || r[0] === ' ') {
      const t = r === '' ? '' : r.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (r[0] === '-') {
      o.push(r.slice(1));
    } else if (r[0] === '+') {
      n.push({ text: r.slice(1), ctx: -1 });
    }
  }
  return { o, n };
}

// ---- section 6: unified diffs ----

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A '\' line follows the hunk's last context or '+' line. */
  backslashAfterLast: boolean;
  /** A '\' line follows the hunk's last '+' line. */
  lastPlusBackslash: boolean;
  hasPlus: boolean;
}

function buildHunk(a: number, body: string[]): Hunk {
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  let backslashAfterLast = false;
  let lastPlusBackslash = false;
  let hasPlus = false;
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const r = body[i]!;
    if (r === '' || r[0] === ' ' || r[0] === '+') {
      lastCtxOrPlus = i;
      if (r[0] === '+') {
        hasPlus = true;
        lastPlus = i;
      }
    }
  }
  if (lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]![0] === '\\') backslashAfterLast = true;
  if (lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\') lastPlusBackslash = true;
  const { o, n } = chunkON(body);
  return { a, o, n, backslashAfterLast, lastPlusBackslash, hasPlus };
}

function parsePatchPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function sectionPaths(s: Section): { oldP: string | null; newP: string | null } {
  const oldP = s.hasPair ? s.pairOld : s.renFrom !== null ? s.renFrom : s.gitOld;
  const newP = s.hasPair ? s.pairNew : s.renTo !== null ? s.renTo : s.gitNew;
  return { oldP, newP };
}

function sectionToEdit(s: Section, strict: boolean): Edit {
  const { oldP, newP } = sectionPaths(s);
  const kind: 'create' | 'delete' | 'move' | 'change' =
    oldP === null || s.isNew ? 'create' : newP === null || s.isDel ? 'delete' : oldP !== newP ? 'move' : 'change';
  return (tree) => {
    if (kind === 'create') {
      const np = newP!;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const lines: string[] = [];
      let finalBreak = true;
      for (const h of s.hunks) {
        for (const nl of h.n) if (nl.ctx === -1) lines.push(nl.text);
      }
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k]!.hasPlus) {
          finalBreak = !s.hunks[k]!.lastPlusBackslash;
          break;
        }
      }
      tree.now.set(np, lines.length === 0 ? '' : lines.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    const op = oldP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (kind === 'delete') {
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (kind === 'move') {
      const np = newP!;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    const fs = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      if (h.o.length === 0) {
        let pos = h.a + d;
        if (pos < 0) pos = 0;
        if (pos > fs.lines.length) pos = fs.lines.length;
        const atEnd = pos === fs.lines.length;
        const ins = h.n.map((nl) => nl.text);
        fs.lines.splice(pos, 0, ...ins);
        if (atEnd) fs.final = !h.backslashAfterLast;
        d += h.n.length;
        continue;
      }
      const found = findTiered(fs.lines, h.o, strict, 0);
      if (found === null) throw new Fail('no-match', op);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + h.o.length === fs.lines.length;
      const rep = buildNewLines(fs.lines, h.o, h.n, best, found.tier);
      fs.lines.splice(best, h.o.length, ...rep);
      if (atEnd) fs.final = !h.backslashAfterLast;
      d += h.n.length - h.o.length;
    }
    const out = serializeFile(fs);
    if (kind === 'move') {
      const np = newP!;
      tree.now.set(op, null);
      tree.now.set(np, out);
      recordMove(op, np);
    } else {
      tree.now.set(op, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const N = lines.length;
  let section: Section | null = null;
  let hunk: string[] | null = null;
  let hunkA = 0;
  let seenHunk = false;
  const flushHunk = (): void => {
    if (hunk === null || section === null) return;
    section.hunks.push(buildHunk(hunkA, hunk));
    hunk = null;
  };
  const flushSection = (): void => {
    flushHunk();
    if (section !== null) {
      edits.push(sectionToEdit(section, strict));
      section = null;
      seenHunk = false;
    }
  };
  const newSection = (gitOld: string | null, gitNew: string | null): void => {
    flushSection();
    section = { gitOld, gitNew, hasPair: false, pairOld: null, pairNew: null, renFrom: null, renTo: null, isNew: false, isDel: false, hunks: [] };
    seenHunk = false;
  };
  let i = 0;
  while (i < N) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        flushHunk();
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.push(line);
        i++;
        continue;
      } else {
        flushHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section !== null && !seenHunk && !section.hasPair) {
        section.hasPair = true;
        section.pairOld = parsePatchPath(line);
        section.pairNew = parsePatchPath(lines[i + 1]!);
      } else {
        newSection(null, null);
        section!.hasPair = true;
        section!.pairOld = parsePatchPath(line);
        section!.pairNew = parsePatchPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || section === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = [];
      hunkA = parseInt(m[1]!, 10);
      seenHunk = true;
      i++;
      continue;
    }
    if (section === null) {
      i++;
      continue;
    }
    if (!seenHunk) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (section.renFrom === null) section.renFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (section.renTo === null) section.renTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        section.isNew = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        section.isDel = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flushSection();
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fs = parseFile(before);
    const found = findTiered(fs.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nlines: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildNewLines(fs.lines, oldLines, nlines, pos, found.tier);
    fs.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, serializeFile(fs));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const N = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < N) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevReplaceEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let j = searchLine + 1;
    let eq = -1;
    while (j < N) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      j++;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = eq + 1;
    let rep = -1;
    while (k < N) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      k++;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

function findChunkOcc(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length === 0) continue;
    // SPEC section 8: the tier is the first tier at which O occurs at all (section 5);
    // an end-of-file chunk then takes only an occurrence at that tier ending at the
    // file's last line, and fails when there is none there.
    if (eof) {
      const good = occ.filter((p) => p + o.length === lines.length);
      if (good.length > 0) return { pos: good[0]!, tier: t };
      return null;
    }
    return { pos: occ[0]!, tier: t };
  }
  return null;
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fs = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(fs.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = chunkON(ch.body);
      if (o.length === 0) {
        const ins = n.map((x) => x.text);
        const pos = ch.eof ? fs.lines.length : cursor;
        fs.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const found = findChunkOcc(fs.lines, o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const rep = buildNewLines(fs.lines, o, n, found.pos, found.tier);
      fs.lines.splice(found.pos, o.length, ...rep);
      cursor = found.pos + rep.length;
    }
    const out = serializeFile(fs);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const N = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = N - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${N + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      i++;
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          raw.push(l);
          i++;
          continue;
        }
        if (l === '') {
          raw.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const content = raw.map((r) => (r === '' ? '' : r.slice(1)));
      edits.push(v4aAddEdit(p, content));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < end && blank(lines[i]!)) i++;
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      let hasMove = false;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        hasMove = true;
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let startedAnyChunk = false;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          startedAnyChunk = true;
          i++;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (cur === null && startedAnyChunk && l.trim() === '') {
          // SPEC section 8: blank lines at the end of a section (before the
          // next section or *** End Patch) are not part of it, so a blank
          // line after an end-of-file chunk that only precedes the end of
          // the section is skipped, not a parse error.
          let k = i;
          while (k < end && lines[k]!.trim() === '') k++;
          if (k >= end || isSectionStart(lines[k]!)) {
            i = k;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (startedAnyChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, body: [], eof: false };
            startedAnyChunk = true;
          }
          cur.body.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (chunks.length > 0) {
        const lastCh = chunks[chunks.length - 1]!;
        if (!lastCh.eof) {
          while (lastCh.body.length > 0 && lastCh.body[lastCh.body.length - 1]!.trim() === '') lastCh.body.pop();
        }
      }
      if (chunks.length === 0 && !hasMove) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  moves.length = 0;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const covered = new Set<string>();
  const entries: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && nowNew !== undefined) {
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
