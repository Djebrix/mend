// mend: applies an edit an AI model wrote to a tree of text files. SPEC.md (version 1) is the contract:
// four patch formats (unified diff, SEARCH/REPLACE, V4A, JSON tool-call edits), three-tier fuzzy matching,
// --format/--check/--strict, exact stdout lines and exit codes, atomic all-or-nothing writes. Node 22,
// standard library only; run as `node main.ts [options] [PATCH]`. In a trial the grader runs `node main.ts`
// with MAKEFUN_ENV_URL set and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

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

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** One line compared at a tier (SPEC.md section 5): 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchesAt(lines: string[], o: string[], at: number, tier: number): boolean {
  if (at < 0 || at + o.length > lines.length) return false;
  for (let j = 0; j < o.length; j++) {
    if (norm(lines[at + j]!, tier) !== norm(o[j]!, tier)) return false;
  }
  return true;
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    if (matchesAt(lines, o, i, tier)) out.push(i);
  }
  return out;
}

/** First tier (0..maxTier) at which O occurs at or after `from`, with its positions, else null. */
function findTier(lines: string[], o: string[], from: number, maxTier: number): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Replace the k lines at `at` (the matched occurrence of O) by N. A context line of N is written as
 * the file's own matched line; at tier 2 every other line of N is re-indented (SPEC.md section 5).
 * nCtx[k] marks a context line of N, nCtxIdx[k] its index in O.
 */
function applyReplace(file: FileState, at: number, o: string[], n: string[], nCtx: boolean[], nCtxIdx: number[], tier: number): void {
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadingWs(o[0]!);
    f = leadingWs(file.lines[at]!);
  }
  const mapped = n.map((text, k) => {
    if (nCtx[k]) return file.lines[at + nCtxIdx[k]!]!;
    if (tier === 2 && text.trim() !== '' && text.startsWith(p)) return f + text.slice(p.length);
    return text;
  });
  file.lines.splice(at, o.length, ...mapped);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, in order, for the R lines of the output (SPEC.md section 2). */
  readonly moves: { old: string; new: string }[] = [];
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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface HunkData {
  a: number;
  o: string[];
  n: string[];
  nCtx: boolean[];
  nCtxIdx: number[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noNLPlus: boolean;
}

interface SectionBuild {
  diffA: string | null;
  diffB: string | null;
  pairOld: string | null;
  pairNew: string | null;
  pairSeen: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: HunkData[];
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** A leading `a/` or `b/` is removed; `/dev/null` means no file (null). */
function normPath(t: string): string | null {
  let p = t;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function buildHunk(body: string[], a: number): HunkData {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  const nCtxIdx: number[] = [];
  for (const L of body) {
    if (L.startsWith(' ')) {
      const t = L.slice(1);
      o.push(t);
      n.push(t);
      nCtx.push(true);
      nCtxIdx.push(o.length - 1);
    } else if (L.startsWith('-')) {
      o.push(L.slice(1));
    } else if (L.startsWith('+')) {
      n.push(L.slice(1));
      nCtx.push(false);
      nCtxIdx.push(-1);
    } else if (L === '') {
      o.push('');
      n.push('');
      nCtx.push(true);
      nCtxIdx.push(o.length - 1);
    }
    // `\` lines are markers only.
  }
  let noNL = false;
  let noNLPlus = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const L = body[k]!;
    if (L.startsWith(' ') || L.startsWith('+') || L === '') {
      noNL = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    const L = body[k]!;
    if (L.startsWith('+')) {
      noNLPlus = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  return { a, o, n, nCtx, nCtxIdx, noNL, noNLPlus };
}

/** Apply a section's hunks in order to a file's lines (SPEC.md section 6). */
function applyHunks(file: FileState, hunks: HunkData[], strict: boolean, path: string): void {
  const maxTier = strict ? 0 : 2;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const oldLen = file.lines.length;
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > oldLen) pos = oldLen;
      const atEnd = pos === oldLen;
      file.lines.splice(pos, 0, ...h.n);
      if (atEnd) file.final = !h.noNL;
      d += h.n.length;
      continue;
    }
    const found = findTier(file.lines, h.o, 0, maxTier);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length === file.lines.length;
    applyReplace(file, best, h.o, h.n, h.nCtx, h.nCtxIdx, found.tier);
    if (atEnd) file.final = !h.noNL;
    d += h.n.length - h.o.length;
  }
}

function unifiedEdit(sec: SectionBuild, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (sec.pairSeen) {
    oldP = sec.pairOld;
    newP = sec.pairNew;
  } else {
    oldP = sec.renameFrom !== null ? normPath(sec.renameFrom) : sec.diffA === null ? null : sec.diffA === '/dev/null' ? null : sec.diffA;
    newP = sec.renameTo !== null ? normPath(sec.renameTo) : sec.diffB === null ? null : sec.diffB === '/dev/null' ? null : sec.diffB;
  }
  const kind: 'create' | 'delete' | 'move' | 'change' | 'noop' =
    oldP === null && newP === null
      ? 'noop'
      : oldP === null || sec.newFile
        ? 'create'
        : newP === null || sec.deletedFile
          ? 'delete'
          : oldP !== newP
            ? 'move'
            : 'change';
  return (tree) => {
    if (kind === 'noop') return;
    if (kind === 'create') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      for (const h of sec.hunks) {
        for (let k = 0; k < h.n.length; k++) if (!h.nCtx[k]) lines.push(h.n[k]!);
      }
      let noNL = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.n.some((_, k) => !h.nCtx[k])) {
          noNL = h.noNLPlus;
          break;
        }
      }
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (kind === 'move') {
      const np = newP!;
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const file = parseFile(cur);
      applyHunks(file, sec.hunks, strict, op);
      tree.now.set(np, renderFile(file));
      tree.now.set(op, null);
      tree.moves.push({ old: op, new: np });
      return;
    }
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    const file = parseFile(cur);
    applyHunks(file, sec.hunks, strict, op);
    tree.now.set(op, renderFile(file));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  const DIFF_RE = /^diff --git a\/(.*) b\/(.*)$/;
  const sections: SectionBuild[] = [];
  let cur: SectionBuild | null = null;
  const n = lines.length;
  const push = (): void => {
    if (cur) sections.push(cur);
    cur = null;
  };
  const start = (diff?: { a: string; b: string }): SectionBuild => {
    push();
    cur = {
      diffA: diff?.a ?? null,
      diffB: diff?.b ?? null,
      pairOld: null,
      pairNew: null,
      pairSeen: false,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    return cur;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      start({ a: m[1]!, b: m[2]! });
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null) {
        const s = start();
        s.pairOld = normPath(headerPath(line));
        s.pairNew = normPath(headerPath(lines[i + 1]!));
        s.pairSeen = true;
      } else if (cur.hunks.length === 0 && !cur.pairSeen) {
        cur.pairOld = normPath(headerPath(line));
        cur.pairNew = normPath(headerPath(lines[i + 1]!));
        cur.pairSeen = true;
      } else {
        const s = start();
        s.pairOld = normPath(headerPath(line));
        s.pairNew = normPath(headerPath(lines[i + 1]!));
        s.pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const L = lines[j]!;
        // The body ends at a `--- ` line followed by a `+++ ` line (a `--- ` line on its own is
        // an old line: it starts with `-`).
        if (L.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (L === '' || L.startsWith(' ') || L.startsWith('-') || L.startsWith('+') || L.startsWith('\\')) {
          body.push(L);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(body, parseInt(m[1]!, 10)));
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletedFile = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any
      // other header line are ignored.
    }
    // Outside a section, or after a section's hunks: prose, ignored.
    i++;
  }
  push();
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const file = parseFile(cur);
    const found = findTier(file.lines, oldLines, 0, strict ? 0 : 2);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    applyReplace(file, at, oldLines, newLines, newLines.map(() => false), newLines.map(() => -1), found.tier);
    tree.now.set(path, renderFile(file));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= n) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let m = i - 1; m >= prevEnd; m--) {
      const t = lines[m]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  o: string[];
  n: string[];
  nCtx: boolean[];
  nCtxIdx: number[];
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = parseFile(cur);
    const maxTier = strict ? 0 : 2;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(file.lines, [ch.anchor], cursor, maxTier);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? file.lines.length : Math.min(cursor, file.lines.length);
        file.lines.splice(pos, 0, ...ch.n);
        cursor = pos + ch.n.length;
        continue;
      }
      let at: number | null = null;
      let tier = 0;
      if (ch.eof) {
        const start = file.lines.length - ch.o.length;
        if (start < cursor) throw new Fail('no-match', path);
        for (let t = 0; t <= maxTier; t++) {
          if (matchesAt(file.lines, ch.o, start, t)) {
            at = start;
            tier = t;
            break;
          }
        }
        if (at === null) throw new Fail('no-match', path);
      } else {
        const found = findTier(file.lines, ch.o, cursor, maxTier);
        if (found === null) throw new Fail('no-match', path);
        at = found.occ[0]!;
        tier = found.tier;
      }
      applyReplace(file, at, ch.o, ch.n, ch.nCtx, ch.nCtxIdx, tier);
      cursor = at + ch.n.length;
    }
    const out = renderFile(file);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Drop trailing empty context lines from a chunk (blank lines at the end of a section). */
function trimChunkTail(ch: VChunk): void {
  while (ch.o.length > 0) {
    const oi = ch.o.length - 1;
    const ni = ch.n.length - 1;
    if (ni < 0 || !ch.nCtx[ni] || ch.nCtxIdx[ni] !== oi) break;
    if (ch.o[oi] !== '') break;
    ch.o.pop();
    ch.n.pop();
    ch.nCtx.pop();
    ch.nCtxIdx.pop();
  }
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const n = last; // parse between Begin Patch and End Patch
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const isEndPatch = (l: string): boolean => l.trim() === '*** End Patch';
  let i = first + 1;
  while (i < n) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (isEndPatch(line)) break;
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      i++;
      while (i < n) {
        const L = lines[i]!;
        if (blank(L)) {
          fileLines.push('');
          i++;
          continue;
        }
        if (isSectionStart(L) || isEndPatch(L)) break;
        if (L.startsWith('+')) {
          fileLines.push(L.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i++;
      while (i < n) {
        const L = lines[i]!;
        if (blank(L)) {
          i++;
          continue;
        }
        if (isSectionStart(L) || isEndPatch(L)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < n) {
        const L = lines[i]!;
        if (blank(L)) {
          if (!cur) cur = { anchor: null, o: [], n: [], nCtx: [], nCtxIdx: [], eof: false };
          cur.o.push('');
          cur.n.push('');
          cur.nCtx.push(true);
          cur.nCtxIdx.push(cur.o.length - 1);
          i++;
          continue;
        }
        if (L.startsWith(' ') || L.startsWith('-') || L.startsWith('+')) {
          if (!cur) cur = { anchor: null, o: [], n: [], nCtx: [], nCtxIdx: [], eof: false };
          if (L.startsWith(' ')) {
            const t = L.slice(1);
            cur.o.push(t);
            cur.n.push(t);
            cur.nCtx.push(true);
            cur.nCtxIdx.push(cur.o.length - 1);
          } else if (L.startsWith('-')) {
            cur.o.push(L.slice(1));
          } else {
            cur.n.push(L.slice(1));
            cur.nCtx.push(false);
            cur.nCtxIdx.push(-1);
          }
          i++;
          continue;
        }
        if (isSectionStart(L) || isEndPatch(L)) break;
        if (L.trim() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (L.startsWith('*** Move to:')) {
          if (cur !== null || moveTo !== null) throw new Exit2(`error: parse ${i + 1}`);
          moveTo = L.slice('*** Move to:'.length).trim();
          i++;
          continue;
        }
        if (L.startsWith('@@')) {
          closeChunk();
          const anchor = L.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], nCtx: [], nCtxIdx: [], eof: false };
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (chunks.length > 0) trimChunkTail(chunks[chunks.length - 1]!);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)    */
/* ------------------------------------------------------------------ */

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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
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
  // A move is reported as one R line when its old path existed before the patch and is gone after it,
  // and its new path did not exist before it and exists after it; it replaces that pair's D and A lines.
  const rPairs: { old: string; new: string }[] = [];
  const rOlds = new Set<string>();
  const rNews = new Set<string>();
  const seenPairs = new Set<string>();
  for (const m of tree.moves) {
    const key = `${m.old}\0${m.new}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    if (tree.original(m.old) === null || tree.get(m.old) !== null) continue;
    if (tree.original(m.new) !== null || tree.get(m.new) === null) continue;
    rPairs.push({ old: m.old, new: m.new });
    rOlds.add(m.old);
    rNews.add(m.new);
  }
  const items: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOlds.has(p) || rNews.has(p)) continue;
    items.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const r of rPairs) items.push({ key: r.new, line: `R ${r.old} -> ${r.new}` });
  items.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = items.map((x) => x.line);
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
