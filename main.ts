// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// Reads unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8) and JSON tool calls (section 9), finds the lines an edit names at the
// first of three matching tiers (section 5), and changes every file or none
// (section 10). The command line, output, exit codes, safe paths, format detection,
// JSON edits and the all-or-nothing write are sections 1 to 4, 9 and 10.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

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
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
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
  recordMove(from: string, to: string): void {
    this.moves.push([from, to]);
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

// ---------------------------------------------------------------------------
// Files and matching lines (SPEC.md sections 3 and 5)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;

function tierEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

interface Found {
  tier: number;
  pos: number[];
}

/** `--strict`: match lines exactly (tier 0 only, SPEC.md section 5). */
let STRICT = false;

/** First tier at which O occurs at least once at or after `from`; null when none. */
function findTier(O: string[], lines: string[], from = 0, endAtLast = false): Found | null {
  if (O.length === 0) return null;
  const maxTier = STRICT ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const pos: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      if (endAtLast && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!tierEq(tier, O[j]!, lines[i + j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old (`-`) or new (`+`). */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line followed this body line. */
  backslash?: boolean;
  /** The patch line this came from was blank (empty or only whitespace). */
  srcBlank?: boolean;
}

/** Whether the hunk/chunk's last context or `+` line is followed by a `\` line. */
function endsNoNewline(items: BodyLine[]): boolean | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'old') continue;
    return it.backslash === true;
  }
  return null;
}

/**
 * The N lines that replace O at position `pos` (tier `tier`): a context line is the
 * file's own matched line; at tier 2 every other line of N is re-indented.
 */
function buildNew(items: BodyLine[], fileLines: string[], pos: number, tier: number): string[] {
  const O = items.filter((i) => i.kind !== 'new').map((i) => i.text);
  const F = tier === 2 && O.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const P = tier === 2 && O.length > 0 ? leadingWs(O[0]!) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'old') {
      oIdx++;
      continue;
    }
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]!);
      oIdx++;
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

/**
 * Apply one hunk/chunk's O/N to a file state at the occurrence the format chooses.
 * `choose` picks the position from the found occurrences. `insertAt` is used when
 * O is empty: the 0-based line after which N is inserted. Returns the new state.
 */
function applyChunk(
  f: FileState,
  items: BodyLine[],
  choose: (found: Found) => number,
  insertAt: (oldLen: number) => number,
  path: string,
  eofOnly = false,
): FileState {
  const O = items.filter((i) => i.kind !== 'new').map((i) => i.text);
  const oldLen = f.lines.length;
  if (O.length === 0) {
    const at = Math.min(Math.max(insertAt(oldLen), 0), oldLen);
    const N = buildNew(items, f.lines, 0, 0);
    const lines = [...f.lines.slice(0, at), ...N, ...f.lines.slice(at)];
    let final = f.final;
    if (at === oldLen) {
      const e = endsNoNewline(items);
      if (e !== null) final = !e;
    }
    return { lines, br: f.br, final };
  }
  const found = findTier(O, f.lines, 0, eofOnly);
  if (found === null) throw new Fail('no-match', path);
  const pos = choose(found);
  const N = buildNew(items, f.lines, pos, found.tier);
  const lines = [...f.lines.slice(0, pos), ...N, ...f.lines.slice(pos + O.length)];
  let final = f.final;
  if (pos + O.length === oldLen) {
    const e = endsNoNewline(items);
    if (e !== null) final = !e;
    else if (N.length === 0) final = pos > 0;
  }
  return { lines, br: f.br, final };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  items: BodyLine[];
}

interface Section {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseDiffPath(s: string): string | null {
  const t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasDashPair = false;
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    hasDashPair = false;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = parseDiffPath(line.slice(4));
      const newP = parseDiffPath(lines[i + 1]!.slice(4));
      if (cur !== null && inHeader && !hasDashPair) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        hasDashPair = true;
      } else {
        startSection(oldP, newP);
        hasDashPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const items: BodyLine[] = [];
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          items.push({ kind: b === '' || b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'old' : 'new', text: b === '' ? '' : b.slice(1) });
          i++;
          continue;
        }
        if (b.startsWith('\\')) {
          if (items.length > 0) items[items.length - 1]!.backslash = true;
          i++;
          continue;
        }
        break;
      }
      while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') items.pop();
      cur.hunks.push({ a, items });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        if (!hasDashPair) cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!hasDashPair) cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => unifiedEdit(sec));
}

function unifiedEdit(sec: Section): Edit {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if (sec.isCreate || oldP === null) {
    // Creation: the new path does not exist; the file is the `+` lines of all hunks.
    return (tree) => {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastBackslash = false;
      let hasPlus = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind !== 'new') continue;
          plus.push(it.text);
          hasPlus = true;
          lastBackslash = it.backslash === true;
        }
      }
      tree.now.set(newP, !hasPlus ? '' : plus.join('\n') + (lastBackslash ? '' : '\n'));
    };
  }
  if (sec.isDelete || newP === null) {
    // Deletion: the old path exists; it is deleted, its hunks are not read.
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== newP) {
    // Move: hunks apply to the old file's lines, the result is written at the new path.
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applySectionHunks(cur, sec, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.recordMove(oldP, newP);
    };
  }
  // Change of the one path.
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applySectionHunks(cur, sec, oldP));
  };
}

/** Apply a section's hunks in order to a file's text; the nearest occurrence wins. */
function applySectionHunks(text: string, sec: Section, path: string): string {
  let f = splitFile(text);
  let d = 0;
  for (const h of sec.hunks) {
    const O = h.items.filter((i) => i.kind !== 'new').map((i) => i.text);
    const target = h.a - 1 + d;
    const before = f;
    f = applyChunk(
      f,
      h.items,
      (found) => {
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.pos) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        return best;
      },
      (oldLen) => Math.min(Math.max(target + 1, 0), oldLen),
      path,
    );
    d += f.lines.length - before.lines.length;
  }
  return joinFile(f);
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  const items: BodyLine[] = [
    ...oldLines.map((t): BodyLine => ({ kind: 'old', text: t })),
    ...newLines.map((t): BodyLine => ({ kind: 'new', text: t })),
  ];
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(oldLines, f.lines, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const N = buildNew(items, f.lines, pos, found.tier);
    const lines = [...f.lines.slice(0, pos), ...N, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  items: BodyLine[];
  eof: boolean;
}

function isSectionStart(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add|Delete|Update) File: ?(.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const secStart = i;
    i++;
    if (kind === 'Add') {
      const flines: { text: string; blank: boolean }[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '') {
          flines.push({ text: '', blank: true });
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          flines.push({ text: l.slice(1), blank: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it; a `+` line
      // that is empty is a line of the file, not a blank line.
      while (flines.length > 0 && flines[flines.length - 1]!.blank) flines.pop();
      edits.push(v4aAddEdit(path, flines.map((x) => x.text)));
      continue;
    }
    if (kind === 'Delete') {
      while (i < last) {
        const l = lines[i]!;
        if (blank(l)) {
          i++;
          continue;
        }
        if (isSectionStart(l)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    // Update File
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to:')) {
      moveTo = lines[i]!.slice('*** Move to:'.length).trim();
      i++;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    let started = false;
    const pushChunk = (): void => {
      if (chunk !== null) {
        chunks.push(chunk);
        chunk = null;
      }
    };
    while (i < last) {
      const l = lines[i]!;
      if (isSectionStart(l)) break;
      if (l === '*** End of File') {
        if (chunk === null) chunk = { anchor: null, items: [], eof: false };
        chunk.eof = true;
        pushChunk();
        started = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        pushChunk();
        const a = l.slice(2).trim();
        chunk = { anchor: a === '' ? null : a, items: [], eof: false };
        started = true;
        i++;
        continue;
      }
      if (l.startsWith('*** Move to:')) throw new Exit2(`error: parse ${i + 1}`);
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (chunk === null) {
          if (started) throw new Exit2(`error: parse ${i + 1}`);
          chunk = { anchor: null, items: [], eof: false };
          started = true;
        }
        chunk.items.push({ kind: l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l === '' ? '' : l.slice(1), srcBlank: l.trim() === '' });
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    pushChunk();
    if (chunks.length > 0) {
      // Blank lines at the end of a section are not part of it.
      const lc = chunks[chunks.length - 1]!;
      while (lc.items.length > 0 && lc.items[lc.items.length - 1]!.srcBlank === true) lc.items.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secStart + 1}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks));
  }
  return edits;
}

function v4aAddEdit(path: string, flines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, flines.length === 0 ? '' : `${flines.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], f.lines, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const O = ch.items.filter((x) => x.kind !== 'new').map((x) => x.text);
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const N = buildNew(ch.items, f.lines, 0, 0);
        f = { lines: [...f.lines.slice(0, at), ...N, ...f.lines.slice(at)], br: f.br, final: f.final };
        cursor = at + N.length;
        continue;
      }
      const found = findTier(O, f.lines, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.pos[0]!;
      const N = buildNew(ch.items, f.lines, pos, found.tier);
      f = { lines: [...f.lines.slice(0, pos), ...N, ...f.lines.slice(pos + O.length)], br: f.br, final: f.final };
      cursor = pos + N.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Driver (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

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
  STRICT = strict;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines)
          : kind === 'search-replace'
            ? parseSearchReplace(lines)
            : parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: R lines replace a move's D/A pair and sort by the new path.
  const rows: { key: string; text: string }[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.now.get(from) === null && tree.original(to) === null && tree.now.get(to) !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      movedFrom.add(from);
      movedTo.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
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
  return { code: 0, out };
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
