// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all ten sections of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing
// write. The kit starter did sections 1 to 4, 9 and 10; sections 5 to 8 and the R (move) output lines below are
// written in this build session from SPEC.md.
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
  /** [old, new] pairs of move edits that ran without failing, for the R output lines (SPEC section 2). */
  readonly moves: Array<[string, string]> = [];
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

// ---------------------------------------------------------------------------
// Section 3 helpers: a file as lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Section 5: three-tier line matching.
// ---------------------------------------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(fileLine: string, oldLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oldLine;
  if (tier === 1) return trimEndWs(fileLine) === trimEndWs(oldLine);
  return trimWs(fileLine) === trimWs(oldLine);
}

/** Positions i at or after `from` where O matches the file's lines, at one tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const start = Math.max(0, from);
  for (let i = start; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const positions = occurrences(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: `text` is the patch's line; `ctx` is its index in O when it is a context line, else -1. */
interface NewLine {
  text: string;
  ctx: number;
}

/**
 * Render N after a match at `pos`: a context line is the file's own matched line, never the patch's; at tier 2
 * every other non-blank line of N that starts with P (the leading spaces/tabs of O's first line) has that P
 * replaced by F (the leading spaces/tabs of the file's first matched line). At tiers 0 and 1 N is as written.
 */
function renderN(n: NewLine[], tier: number, file: string[], pos: number, o: string[]): string[] {
  if (tier !== 2) return n.map((x) => (x.ctx >= 0 ? file[pos + x.ctx]! : x.text));
  const f = leadWs(file[pos]!);
  const p = leadWs(o[0]!);
  return n.map((x) => {
    if (x.ctx >= 0) return file[pos + x.ctx]!;
    const t = x.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface UBodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  /** A `\` line follows this body line (as in `\ No newline at end of file`). */
  noeol: boolean;
}

interface UHunk {
  /** The A of `@@ -A[,B] +C[,D] @@` (B and D are not used). */
  a: number;
  body: UBodyLine[];
}

interface USection {
  /** Null when the path is /dev/null (no file). */
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** The path after `--- ` or `+++ `: the text after the four characters, up to the first tab, trimmed. */
function diffPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

/** Strip one leading `a/` or `b/` from a diff path; `/dev/null` becomes null. */
function stripDiffPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  const n = lines.length;
  let cur: USection | null = null;
  /** 'outside' between sections, 'header' inside a section before its first hunk, 'hunks' after a hunk. */
  let state: 'outside' | 'header' | 'hunks' = 'outside';
  let pairSeen = false;
  let i = 0;
  const newSection = (oldPath: string | null, newPath: string | null): void => {
    cur = { oldPath, newPath, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    state = 'header';
    pairSeen = false;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    // A `--- ` line followed by a `+++ ` line starts a new section, unless it is part of the
    // current section's header (handled below).
    if (state !== 'header' && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      newSection(stripDiffPrefix(diffPath(line)), stripDiffPrefix(diffPath(lines[i + 1]!)));
      pairSeen = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (state === 'outside' || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      state = 'hunks';
      i += 1;
      // The body: lines starting with ` `, `-`, `+` or `\`, or empty; a `\` line marks the body line before it.
      // It ends at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the first other line.
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          hunk.body.push({ kind: ' ', text: '', noeol: false });
          i += 1;
        } else if (b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          hunk.body.push({ kind: b[0] as ' ' | '-' | '+', text: b.slice(1), noeol: false });
          i += 1;
        } else if (b[0] === '\\') {
          const prev = hunk.body[hunk.body.length - 1];
          if (prev !== undefined) prev.noeol = true;
          i += 1;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '' && !last.noeol) hunk.body.pop();
        else break;
      }
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          // The `---`/`+++` pair names this section's paths.
          cur.oldPath = stripDiffPrefix(diffPath(line));
          cur.newPath = stripDiffPrefix(diffPath(lines[i + 1]!));
          pairSeen = true;
          i += 2;
        } else {
          // A `--- ` line in a header must be followed by a `+++ ` line.
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!pairSeen) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!pairSeen) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      // `+++ ` on its own, `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other header line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i += 1;
  }
  return sections;
}

/** Split a hunk body into its old lines O and its new lines N (context lines carry their index in O). */
function hunkON(body: UBodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** The `\` flag of the hunk's last context or `+` line, if it has one. */
function hunkNoEol(body: UBodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '+') return b.noeol;
  }
  return false;
}

/**
 * Apply one hunk to a file doc, returning the new drift d. `path` is named on a no-match failure.
 * The doc's `final` flag is changed only when the hunk touches the end of the file.
 */
function applyHunk(doc: Doc, hunk: UHunk, strict: boolean, d: number, path: string): number {
  const { o, n } = hunkON(hunk.body);
  const noeol = hunkNoEol(hunk.body);
  if (o.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, doc.lines.length));
    const atEnd = at === doc.lines.length;
    const rendered = n.map((x) => x.text);
    doc.lines.splice(at, 0, ...rendered);
    if (atEnd && rendered.length > 0) doc.final = !noeol;
    return d + rendered.length;
  }
  const found = findTier(doc.lines, o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.positions[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      pos = p;
      best = dist;
    }
  }
  const atEnd = pos + o.length === doc.lines.length;
  const rendered = renderN(n, found.tier, doc.lines, pos, o);
  doc.lines.splice(pos, o.length, ...rendered);
  if (atEnd) doc.final = !noeol;
  return d + rendered.length - o.length;
}

function unifiedEdit(section: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = section.oldPath;
    const newP = section.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = section.isCreate || oldP === null;
    const isDelete = section.isDelete || newP === null;
    if (isCreate && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastNoeol = false;
      for (const hunk of section.hunks) {
        for (const b of hunk.body) {
          if (b.kind === '+') {
            plus.push(b.text);
            lastNoeol = b.noeol;
          }
        }
      }
      const text = plus.length === 0 ? '' : `${plus.join('\n')}${lastNoeol ? '' : '\n'}`;
      tree.now.set(newP, text);
      return;
    }
    if (isDelete && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = splitFile(before);
      let d = 0;
      for (const hunk of section.hunks) d = applyHunk(doc, hunk, strict, d, oldP);
      tree.now.set(newP, joinFile(doc.lines, doc.br, doc.final));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (oldP !== null) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const doc = splitFile(before);
      let d = 0;
      for (const hunk of section.hunks) d = applyHunk(doc, hunk, strict, d, oldP);
      tree.now.set(oldP, joinFile(doc.lines, doc.br, doc.final));
      return;
    }
    // Both paths /dev/null: nothing to change.
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  /** Index of the previous block's `>>>>>>> REPLACE` line, -1 before the first block. */
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before the SEARCH line, after the previous block's
    // REPLACE line, that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdit(block: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(block.path)) throw new Fail('unsafe', block.path);
    if (block.oldLines.length === 0) {
      if (tree.get(block.path) !== null) throw new Fail('exists', block.path);
      const text = block.newLines.length === 0 ? '' : `${block.newLines.join('\n')}\n`;
      tree.now.set(block.path, text);
      return;
    }
    const before = tree.get(block.path);
    if (before === null) throw new Fail('missing', block.path);
    const doc = splitFile(before);
    const found = findTier(doc.lines, block.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', block.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', block.path);
    const pos = found.positions[0]!;
    const n: NewLine[] = block.newLines.map((t) => ({ text: t, ctx: -1 }));
    const rendered = renderN(n, found.tier, doc.lines, pos, block.oldLines);
    doc.lines.splice(pos, block.oldLines.length, ...rendered);
    tree.now.set(block.path, joinFile(doc.lines, doc.br, doc.final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => searchReplaceEdit(b, strict));
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VBodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

interface VChunk {
  /** Null when the `@@` line has no anchor text. */
  anchor: string | null;
  eof: boolean;
  body: VBodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File: the file's lines. */
  lines: string[];
  /** Update File: the chunks. */
  chunks: VChunk[];
  /** 1-based line of the section header (for the no-chunk parse error). */
  lineNo: number;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    // The section's raw lines run to the next section start or `*** End Patch`.
    const raw: number[] = [];
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) {
      raw.push(j);
      j += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const idx of raw) {
        const l = lines[idx]!;
        if (l === '') fileLines.push('');
        else if (l[0] === '+') fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      sections.push({ kind, path, moveTo: null, lines: fileLines, chunks: [], lineNo: headerLine });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]! + 1}`);
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], lineNo: headerLine });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && lines[raw[0]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[raw[0]!]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k += 1) {
        const idx = raw[k]!;
        const l = lines[idx]!;
        if (l.startsWith('@@')) {
          pushCur();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          pushCur();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${idx + 1}`);
        }
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, lines: [], chunks, lineNo: headerLine });
    }
    i = j;
  }
  return sections;
}

/** The first line at or after the cursor equal to the anchor, at the first tier with one, else -1. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    for (let k = cursor; k < lines.length; k += 1) {
      if (lineEq(lines[k]!, anchor, tier)) return k;
    }
  }
  return -1;
}

function v4aEdit(section: VSection, strict: boolean): Edit {
  if (section.kind === 'add') {
    return (tree) => {
      if (!safe(section.path)) throw new Fail('unsafe', section.path);
      if (tree.get(section.path) !== null) throw new Fail('exists', section.path);
      const text = section.lines.length === 0 ? '' : `${section.lines.join('\n')}\n`;
      tree.now.set(section.path, text);
    };
  }
  if (section.kind === 'delete') {
    return (tree) => {
      if (!safe(section.path)) throw new Fail('unsafe', section.path);
      if (tree.get(section.path) === null) throw new Fail('missing', section.path);
      tree.now.set(section.path, null);
    };
  }
  return (tree) => {
    if (!safe(section.path)) throw new Fail('unsafe', section.path);
    if (section.moveTo !== null && !safe(section.moveTo)) throw new Fail('unsafe', section.moveTo);
    const before = tree.get(section.path);
    if (before === null) throw new Fail('missing', section.path);
    if (section.moveTo !== null && tree.get(section.moveTo) !== null) throw new Fail('exists', section.moveTo);
    const doc = splitFile(before);
    let cursor = 0;
    for (const chunk of section.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(doc.lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', section.path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: NewLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: o.length - 1 });
        } else if (b.kind === '-') {
          o.push(b.text);
        } else {
          n.push({ text: b.text, ctx: -1 });
        }
      }
      if (o.length === 0) {
        const at = chunk.eof ? doc.lines.length : cursor;
        const rendered = n.map((x) => x.text);
        doc.lines.splice(at, 0, ...rendered);
        cursor = at + rendered.length;
      } else {
        // The first occurrence of O at or after the cursor, at the first tier with one; an
        // end-of-file chunk takes only an occurrence that ends at the file's last line.
        let found: { tier: number; pos: number } | null = null;
        const max = strict ? 0 : 2;
        for (let tier = 0; tier <= max && found === null; tier += 1) {
          if (chunk.eof) {
            const pos = doc.lines.length - o.length;
            if (pos >= cursor && pos >= 0) {
              let ok = true;
              for (let j = 0; j < o.length; j += 1) {
                if (!lineEq(doc.lines[pos + j]!, o[j]!, tier)) {
                  ok = false;
                  break;
                }
              }
              if (ok) found = { tier, pos };
            }
          } else {
            const positions = occurrences(doc.lines, o, tier, cursor);
            if (positions.length > 0) found = { tier, pos: positions[0]! };
          }
        }
        if (found === null) throw new Fail('no-match', section.path);
        const rendered = renderN(n, found.tier, doc.lines, found.pos, o);
        doc.lines.splice(found.pos, o.length, ...rendered);
        cursor = found.pos + rendered.length;
      }
    }
    const text = joinFile(doc.lines, doc.br, doc.final);
    if (section.moveTo !== null) {
      tree.now.set(section.moveTo, text);
      tree.now.set(section.path, null);
      tree.moves.push([section.path, section.moveTo]);
    } else {
      tree.now.set(section.path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((s) => v4aEdit(s, strict));
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  // Write every change (unless --check), then report them: A/D/M rows, with a successful move
  // reported as one R line instead of its D and A lines, the rows sorted by path (by <new> for R).
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of changed) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
