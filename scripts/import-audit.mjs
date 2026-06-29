// Import-completeness static audit. Run with `bun scripts/import-audit.mjs`.
//
// WHY THIS EXISTS
// The CI smokes (route-smoke / detail-smoke) `bun build` every module into ONE
// scope, so a module that references a shared binding (e.g. `TICKETS`) WITHOUT
// importing it still resolves — the bare name finds the bundle's top-level var.
// Production is native ESM, where that same bare reference throws
// `ReferenceError`. So the smokes provably cannot catch a missing import; this
// audit does. It is the scripted form of the mandatory pre-PR gate described in
// CLAUDE.md ("verify import-completeness with a static audit").
//
// SCOPE (deliberate)
// We watch the shared, importable bindings exported by core/state.js and
// core/data.js — the documented cross-module coupling that silently resolves in
// a bundle. A module that *reads* one of those names but does not have it in
// scope (imported, declared, a parameter, or `typeof`-guarded) is flagged. We do
// NOT verify cross-feature-module function imports (a possible future extension).
// The window-bridge utilities (escHtml, isAdmin, …) are out of scope: they are
// app.js-local, reached as `window.escHtml(…)` (a property access this ignores).
//
// DESIGN — high precision over completeness
// This gate runs on EVERY PR repo-wide, so a false positive (blocking an
// unrelated PR) is far worse than a false negative (missing one edge case — a
// class that had ZERO coverage before this script existed). The lexer and the
// `available` set are therefore tuned to never false-positive on legitimate
// code, accepting that a few exotic shapes (e.g. a watched name used only inside
// a keyword-preceded regex body, or a parameter named after a watched export)
// may go unflagged. Concretely:
//  - Comments are stripped (string/template/regex-aware) BEFORE import/decl
//    parsing, so a commented-out or comment-adjacent import can't corrupt scope.
//  - The read lexer keeps template `${…}` interiors, skips strings/comments/regex
//    bodies, distinguishes `...spread` (a read) from `.property` (not a read),
//    and skips object-literal keys (`{ NAME: … }`).
//  - `available` is built generously (imports, declarations, destructuring,
//    catch + function/arrow params, `typeof` operands). Over-inclusion only ever
//    SUPPRESSES a flag — it can cause a false negative, never a false positive.
//  - Acceptance gate: on a clean tree this MUST report zero violations.

import { readFileSync } from 'node:fs';

// ── DOM/localStorage stubs so core/state.js + core/data.js import without a DOM
//    (state.js touches localStorage at module-init). Mirrors
//    scripts/bridge-collision-check.mjs. ───────────────────────────────────────
globalThis.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
  body: { classList: { add() {}, remove() {} } },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() {
    return { style: {}, classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {}, addEventListener() {}, setAttribute() {} };
  },
};
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// ── Watched names: the named exports of state.js + data.js (derived live, not
//    hardcoded, so the audit tracks future additions automatically). ───────────
const watched = new Set();
for (const mod of ['../web/js/core/state.js', '../web/js/core/data.js']) {
  const ns = await import(mod);
  for (const key of Object.keys(ns)) {
    if (key !== 'default') watched.add(key);
  }
}

// ── File list (tracked .js under web/js). `git ls-files` per CLAUDE.md, not a
//    glob. cwd is the repo root (CI runs `bun scripts/import-audit.mjs`). ───────
let ls;
try {
  ls = Bun.spawnSync(['git', 'ls-files', 'web/js']);
} catch (e) {
  console.error(`FAILED to run git (is it on PATH? run from the repo root): ${e.message}`);
  process.exit(1);
}
const files = ls.stdout.toString().split('\n')
  .map((s) => s.trim())
  .filter((s) => s.endsWith('.js'))
  // state.js/data.js DEFINE the watched names — they reference them without
  // importing by definition; never audit them.
  .filter((s) => s !== 'web/js/core/state.js' && s !== 'web/js/core/data.js');

if (ls.exitCode !== 0 || files.length === 0) {
  console.error(`FAILED to list web/js modules (git exit ${ls.exitCode}, ${files.length} files). Run from the repo root.`);
  process.exit(1);
}

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;
// `/` begins a regex (vs division) when the previous significant char is one of
// these punctuators, OR the previous word is one of the keywords below. Without
// this a real regex body would be scanned as code (and a watched word inside it
// falsely flagged).
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', null]);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// Single lexer pass. Returns:
//  - reads: { name, line } for identifier value-reads in CODE regions, excluding
//    `.property` access, object-literal keys, and (handled via `available`) the
//    operand of typeof. `...spread` reads ARE included.
//  - code: the source with COMMENTS blanked (strings/templates/regex kept), used
//    for robust import/declaration parsing free of comment interference.
function lex(src) {
  const reads = [];
  let code = '';
  const n = src.length;
  let i = 0, line = 1;
  let prevSig = null;    // last significant punctuator/marker in code
  let prevWord = null;   // last identifier/keyword token in code
  let propAccess = false; // true iff a single `.` (not `...`) precedes the next id
  const stack = [{ type: 'code', brace: 0 }];
  const top = () => stack[stack.length - 1];
  const nextSig = (p) => { while (p < n && /\s/.test(src[p])) p++; return p < n ? src[p] : null; };

  while (i < n) {
    const ctx = top();
    const c = src[i];

    if (ctx.type === 'tpl') {
      code += c;
      if (c === '\n') { line++; i++; continue; }
      if (c === '\\') { code += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') { stack.pop(); prevSig = '`'; prevWord = null; propAccess = false; i++; continue; }
      if (c === '$' && src[i + 1] === '{') { code += '{'; stack.push({ type: 'code', brace: 0 }); prevSig = '{'; prevWord = null; propAccess = false; i += 2; continue; }
      i++; continue; // static template text
    }

    // ── code context ──
    if (c === '\n') { code += c; line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { code += c; i++; continue; }

    // line comment — blank it (preserve newline), leave prevSig/prevWord intact
    if (c === '/' && src[i + 1] === '/') {
      i += 2; code += '  ';
      while (i < n && src[i] !== '\n') { code += ' '; i++; }
      continue;
    }
    // block comment — blank it (preserve newlines), leave prevSig/prevWord intact
    if (c === '/' && src[i + 1] === '*') {
      i += 2; code += '  ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { code += '\n'; line++; } else code += ' '; i++; }
      code += '  '; i += 2; continue;
    }
    // regex literal — punctuator OR keyword before it
    if (c === '/' && (REGEX_PREV.has(prevSig) || REGEX_KEYWORDS.has(prevWord))) {
      code += c; i++; let inClass = false;
      while (i < n) {
        const r = src[i]; code += r;
        if (r === '\\') { code += src[i + 1] ?? ''; i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { i++; break; }
        else if (r === '\n') line++;
        i++;
      }
      while (i < n && ID_CHAR.test(src[i])) { code += src[i]; i++; } // flags
      prevSig = '/'; prevWord = null; propAccess = false; continue;
    }
    // string literals — kept verbatim in `code` so import paths survive
    if (c === '"' || c === "'") {
      const q = c; code += c; i++;
      while (i < n) { const s = src[i]; code += s; if (s === '\\') { code += src[i + 1] ?? ''; i += 2; continue; } if (s === '\n') line++; if (s === q) { i++; break; } i++; }
      prevSig = q; prevWord = null; propAccess = false; continue;
    }
    // template literal start
    if (c === '`') { code += c; stack.push({ type: 'tpl' }); prevWord = null; propAccess = false; i++; continue; }

    // spread `...` (next id is a READ) vs property access `.`
    if (c === '.') {
      if (src[i + 1] === '.' && src[i + 2] === '.') { code += '...'; prevSig = '.'; prevWord = null; propAccess = false; i += 3; continue; }
      code += '.'; prevSig = '.'; propAccess = true; i++; continue; // single dot → property access
    }

    // braces — track for `${…}` frame exit
    if (c === '{') { code += c; ctx.brace++; prevSig = '{'; prevWord = null; propAccess = false; i++; continue; }
    if (c === '}') {
      code += c;
      if (ctx.brace === 0 && stack.length > 1) { stack.pop(); prevSig = '}'; prevWord = null; propAccess = false; i++; continue; }
      if (ctx.brace > 0) ctx.brace--;
      prevSig = '}'; prevWord = null; propAccess = false; i++; continue;
    }

    // identifier
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_CHAR.test(src[j])) j++;
      const name = src.slice(i, j);
      code += name;
      const dotted = propAccess;
      const objKey = (prevSig === '{' || prevSig === ',') && nextSig(j) === ':';
      if (!dotted && !objKey) reads.push({ name, line });
      prevWord = name; prevSig = 'a'; propAccess = false; i = j; continue;
    }

    code += c; prevSig = c; prevWord = null; propAccess = false; i++;
  }
  return { reads, code };
}

// Names that are BOUND or GUARDED in a module — anything here cannot throw a
// ReferenceError, so a watched name in this set is never flagged. Runs on the
// comment-stripped `code`. Deliberately generous: over-inclusion only ever
// SUPPRESSES a flag (a false negative at worst, never a false positive that
// would wrongly block a PR).
function availableNames(code) {
  const names = new Set();
  const add = (s) => { const t = (s || '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t); };
  const addAll = (chunk) => { for (const m of chunk.matchAll(/[A-Za-z_$][\w$]*/g)) add(m[0]); };

  // Named imports, with optional default prefix: import Foo, { A, B as C } from …
  for (const m of code.matchAll(/import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1].split(',')) { const seg = part.split(/\s+as\s+/); add(seg[seg.length - 1]); }
  }
  // Default / namespace imports: import X from … / import * as X from …
  for (const m of code.matchAll(/import\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"]/g)) add(m[1]);
  // const/let/var/function/class NAME
  for (const m of code.matchAll(/\b(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // catch (NAME)
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // Destructuring heads: const|let|var { … }= or [ … ]= — capture every id inside.
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([{[][\s\S]*?[}\]])\s*=/g)) addAll(m[1]);
  // Parameters: function name(params) and arrow (params) =>
  for (const m of code.matchAll(/function\*?\s*[A-Za-z_$]?[\w$]*\s*\(([^)]*)\)/g)) addAll(m[1]);
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) addAll(m[1]);
  // typeof X — `typeof X` never throws; treat X as available file-wide so the
  // common `typeof X !== 'undefined' ? X : fallback` guard isn't flagged.
  for (const m of code.matchAll(/\btypeof\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);

  return names;
}

const violations = []; // { file, name, line }
let readError = false;

for (const file of files) {
  let src;
  try { src = readFileSync(file, 'utf8'); }
  catch (e) { console.error(`FAILED to read ${file}: ${e.message}`); readError = true; continue; }
  src = src.replace(/\r\n/g, '\n');

  const { reads, code } = lex(src);
  const available = availableNames(code);
  const flaggedHere = new Map(); // name -> first line

  for (const { name, line } of reads) {
    if (!watched.has(name)) continue;
    if (available.has(name)) continue;
    if (!flaggedHere.has(name)) flaggedHere.set(name, line);
  }
  for (const [name, line] of flaggedHere) violations.push({ file, name, line });
}

if (violations.length > 0) {
  console.log(`FOUND ${violations.length} unimported reference(s) to shared state/data bindings:\n`);
  for (const v of violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${v.file}:${v.line}  references '${v.name}' but never imports it`);
  }
  console.log(`\nFix: add the missing named import (from core/state.js or core/data.js), or remove the reference.`);
  process.exit(1);
} else if (readError) {
  console.error('FAILED — one or more modules could not be read (see above).');
  process.exit(1);
} else {
  console.log(`OK — import-completeness: no unimported state/data references across ${files.length} modules (${watched.size} watched names).`);
}
