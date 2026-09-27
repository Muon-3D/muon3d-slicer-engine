// C++ source handling for the settings catalogue generator: comments and `#if 0` regions blanked
// out with every line kept in place (so offsets still give Orca's line numbers), function bodies
// cut out by name, and a body split into statements (simple ones, if/else, loops and blocks) for
// the Tab.cpp parser (tabParser.ts) to match one by one.
//
// Node-free and pure, so the tests can feed it small fixtures.
import { stripCppComments } from './rulesSource.ts';

/** A statement or shape the generator does not understand, at `file:line`. */
export class CppParseError extends Error {
  readonly file: string;
  readonly line: number;
  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.file = file;
    this.line = line;
  }
}

/** A source file ready for parsing: LF line ends, comments and `#if 0` code blanked, same lines. */
export interface CppFile {
  /** Path relative to the Orca root, for messages (e.g. "src/slic3r/GUI/Tab.cpp"). */
  path: string;
  text: string;
}

/** 1-based line of `offset` in `text`. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/**
 * Comments removed (line breaks kept), `#if 0 … #else … #endif` resolved to its `#else` part and
 * `#if 1` to its first part, with the directive lines blanked. Other preprocessor conditionals
 * are left in place: a statement list that meets one fails (see parseStatements).
 */
export function prepareCpp(path: string, raw: string): CppFile {
  const lines = stripCppComments(raw.replace(/\r\n?/g, '\n')).split('\n');
  const stack: Array<{ known: boolean; skip: boolean }> = [];
  const out = lines.map((line) => {
    const t = line.trim();
    const skipping = stack.some((s) => s.skip);
    const open = /^#\s*if\s+([01])\s*$/.exec(t);
    if (open) {
      stack.push({ known: true, skip: open[1] === '0' });
      return '';
    }
    if (/^#\s*(if|ifdef|ifndef)\b/.test(t)) {
      stack.push({ known: false, skip: false });
      return skipping ? '' : line;
    }
    const top = stack.at(-1);
    if (/^#\s*(else|elif)\b/.test(t) && top) {
      if (!top.known) return skipping ? '' : line;
      top.skip = !top.skip;
      return '';
    }
    if (/^#\s*endif\b/.test(t) && top) {
      stack.pop();
      return top.known || skipping ? '' : line;
    }
    return skipping ? '' : line;
  });
  return { path, text: out.join('\n') };
}

/** Index just past the end of the string or character literal that starts at `i`. */
function skipLiteral(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** A `'` that is a C++14 digit separator (1'000), not a character literal. */
const isDigitSeparator = (src: string, i: number) => /[0-9A-Fa-f]/.test(src[i - 1] ?? '') && /[0-9A-Fa-f]/.test(src[i + 1] ?? '');

/** Index just past the bracket that closes the one at `open`; literals are skipped. */
export function matchBracket(file: CppFile, open: number): number {
  const src = file.text;
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || (c === "'" && !isDigitSeparator(src, i))) {
      i = skipLiteral(src, i) - 1;
    } else if (c in pairs) {
      stack.push(pairs[c]);
    } else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) throw new CppParseError(file.path, lineOf(src, i), `unbalanced "${c}"`);
      if (stack.length === 0) return i + 1;
    }
  }
  throw new CppParseError(file.path, lineOf(src, open), `"${src[open]}" is never closed`);
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A function's body (between its braces) and where it starts. */
export interface FunctionBody {
  /** Qualified name, e.g. "TabPrint::build". */
  name: string;
  /** Offset of the character after the opening brace. */
  start: number;
  /** Offset of the closing brace. */
  end: number;
  /** The whole definition, from the name to the closing brace (for fingerprints). */
  definition: string;
}

/**
 * The one definition of `Class::function` in `file`. Fails when there is none or more than one
 * (an overload would make the layout ambiguous).
 */
export function functionBody(file: CppFile, name: string): FunctionBody {
  const src = file.text;
  const found: FunctionBody[] = [];
  const re = new RegExp(`(?<![\\w:.>])${escapeRe(name)}\\s*\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const afterParams = matchBracket(file, m.index + m[0].length - 1);
    const tail = /^\s*(?:const\s*)?\{/.exec(src.slice(afterParams));
    // A definition starts a line with its return type; a call sits inside an expression.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (!tail || !/^[\w:<>*&\s]*$/.test(src.slice(lineStart, m.index))) continue;
    const open = afterParams + tail[0].length - 1;
    const close = matchBracket(file, open) - 1;
    found.push({ name, start: open + 1, end: close, definition: src.slice(m.index, close + 1) });
    re.lastIndex = close;
  }
  if (found.length !== 1) {
    throw new CppParseError(file.path, 1, found.length ? `${name} is defined ${found.length} times` : `${name} is not defined`);
  }
  return found[0];
}

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

export type Stmt =
  | { kind: 'simple'; at: number; text: string }
  | { kind: 'if'; at: number; text: string; cond: string; then: Stmt[]; otherwise: Stmt[] }
  | { kind: 'loop'; at: number; text: string; head: string; body: Stmt[] }
  | { kind: 'block'; at: number; text: string; body: Stmt[] };

const skipSpace = (src: string, i: number, end: number) => {
  while (i < end && /\s/.test(src[i])) i++;
  return i;
};

/** Index of the `;` that ends the simple statement starting at `from` (brackets and literals skipped). */
function statementEnd(file: CppFile, from: number, end: number): number {
  const src = file.text;
  for (let i = from; i < end; i++) {
    const c = src[i];
    if (c === '"' || (c === "'" && !isDigitSeparator(src, i))) i = skipLiteral(src, i) - 1;
    else if (c === '(' || c === '{' || c === '[') i = matchBracket(file, i) - 1;
    else if (c === ';') return i;
    else if (c === '}' || c === ')' || c === ']') break;
  }
  throw new CppParseError(file.path, lineOf(src, from), 'statement without an ending ";"');
}

/** One statement at `from`: returns it and the offset after it. */
function parseOne(file: CppFile, from: number, end: number): [Stmt, number] {
  const src = file.text;
  const at = skipSpace(src, from, end);
  if (src[at] === '#') throw new CppParseError(file.path, lineOf(src, at), `preprocessor directive "${src.slice(at, src.indexOf('\n', at))}" is not supported here`);
  if (src[at] === '{') {
    const close = matchBracket(file, at);
    return [{ kind: 'block', at, text: src.slice(at, close), body: parseStatements(file, at + 1, close - 1) }, close];
  }
  const control = /^(if|for|while|switch)\s*\(/.exec(src.slice(at, at + 12));
  if (control) {
    const open = at + control[0].length - 1;
    const close = matchBracket(file, open);
    const head = src.slice(open + 1, close - 1);
    const [first, afterFirst] = parseOne(file, close, end);
    const body = first.kind === 'block' ? first.body : [first];
    if (control[1] !== 'if') {
      return [{ kind: 'loop', at, text: src.slice(at, afterFirst), head, body }, afterFirst];
    }
    const next = skipSpace(src, afterFirst, end);
    if (/^else\b/.test(src.slice(next, next + 5))) {
      const [other, afterOther] = parseOne(file, next + 4, end);
      const otherwise = other.kind === 'block' ? other.body : [other];
      return [{ kind: 'if', at, text: src.slice(at, afterOther), cond: head, then: body, otherwise }, afterOther];
    }
    return [{ kind: 'if', at, text: src.slice(at, afterFirst), cond: head, then: body, otherwise: [] }, afterFirst];
  }
  if (/^(else|do|try|case|default)\b/.test(src.slice(at, at + 8))) {
    throw new CppParseError(file.path, lineOf(src, at), `"${/^\w+/.exec(src.slice(at))![0]}" is not supported here`);
  }
  const semi = statementEnd(file, at, end);
  return [{ kind: 'simple', at, text: src.slice(at, semi) }, semi + 1];
}

/** The statements between `from` and `end` (a function or block body). */
export function parseStatements(file: CppFile, from: number, end: number): Stmt[] {
  const out: Stmt[] = [];
  for (let i = skipSpace(file.text, from, end); i < end; i = skipSpace(file.text, i, end)) {
    if (file.text[i] === ';') {
      i++;
      continue;
    }
    const [stmt, next] = parseOne(file, i, end);
    out.push(stmt);
    i = next;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Statement text
// ---------------------------------------------------------------------------------------------

/**
 * `text` with every lambda (`[captures](params) mutable -> T { body }`, parameters optional)
 * replaced by the word LAMBDA, so code inside callbacks is never read as layout. A `[` right after
 * a name, `)` or `]` is a subscript and stays.
 */
export function replaceLambdas(text: string): string {
  const file: CppFile = { path: '', text };
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || (c === "'" && !isDigitSeparator(text, i))) {
      i = skipLiteral(text, i) - 1;
      continue;
    }
    if (c !== '[') continue;
    const before = text.slice(0, i).trimEnd().at(-1) ?? '';
    if (/[\w)\]]/.test(before)) continue;
    let j = skipSpace(text, matchBracket(file, i), text.length);
    if (text[j] === '(') j = skipSpace(text, matchBracket(file, j), text.length);
    const qualifiers = /^(?:mutable\s*)?(?:->\s*[\w:<>]+\s*)?/.exec(text.slice(j))![0];
    j += qualifiers.length;
    if (text[j] !== '{') continue;
    const close = matchBracket(file, j);
    out += `${text.slice(last, i)}LAMBDA`;
    last = close;
    i = close - 1;
  }
  return out + text.slice(last);
}

/**
 * Canonical spacing for matching: literals kept as written, whitespace dropped except a single
 * space between two word characters (`auto page=add_options_page(L("Quality"),"icon")`).
 */
export function squash(text: string): string {
  let out = '';
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && /\w/.test(out.at(-1) ?? '') && /\w/.test(c)) out += ' ';
    pendingSpace = false;
    if (c === '"' || (c === "'" && !isDigitSeparator(text, i))) {
      const j = skipLiteral(text, i);
      out += text.slice(i, j);
      i = j - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** One or more adjacent string literals, each optionally wide (L"…"). */
export const STRINGS = String.raw`(?:L?"(?:[^"\\]|\\.)*")+`;
/** A translatable text: L("…") or a plain literal. */
export const TEXT = String.raw`(?:L\(${STRINGS}\)|${STRINGS})`;
export const IDENT = String.raw`[A-Za-z_]\w*`;

/** The value of STRINGS / TEXT source (adjacent literals joined, C escapes resolved). */
export function literalValue(source: string): string {
  let out = '';
  for (const m of source.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    out += m[1].replace(/\\(.)/g, (_, ch: string) => ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[ch] ?? ch);
  }
  return out;
}

/** Every string literal in `text`, resolved. */
export function literalsIn(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => literalValue(`"${m[1]}"`));
}
