// Syntax tones for the JSX of the docs examples, rendered on the server: a small lexer that wraps
// tag names, attributes, strings, keys, keywords and comments in `span.dx-*` (styles/docs.css).
// It knows the JSX the examples are written in, not all of TypeScript: an unknown token stays
// plain text, so a miss costs a tone, never a character.
import type { Child } from 'hono/jsx';

type Tone = 'tag' | 'attr' | 'str' | 'key' | 'kw' | 'com' | 'punc';

/** js: an expression (top level or inside braces); tag: between `<Name` and `>`; text: children. */
type Mode = { kind: 'js' } | { kind: 'tag'; closing: boolean } | { kind: 'text' };

const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'new',
  'typeof',
  'as',
  'import',
  'export',
  'from',
  'true',
  'false',
  'null',
  'undefined',
  'if',
  'else',
]);

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/y;
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/y;
const NUMBER = /\d[\d_.]*/y;
const IDENT = /[A-Za-z_$][\w$]*/y;
const TAG_NAME = /[A-Za-z][\w.:-]*/y;
const ATTR_NAME = /[A-Za-z_][\w:-]*/y;
const SPACE = /\s+/y;
const KEY_AHEAD = /\s*:(?!:)/y;

function at(re: RegExp, src: string, i: number): string | null {
  re.lastIndex = i;
  return re.exec(src)?.[0] ?? null;
}

/** The code as text and tone spans, for a `CodeBlock`. */
export function highlightJsx(src: string): Child[] {
  const out: Child[] = [];
  let plain = '';
  const emit = (text: string, tone?: Tone) => {
    if (!tone) {
      plain += text;
      return;
    }
    if (plain) out.push(plain);
    plain = '';
    out.push(<span class={`dx-${tone}`}>{text}</span>);
  };

  const stack: Mode[] = [{ kind: 'js' }];
  const top = () => stack[stack.length - 1]!;
  // In an expression, `<` opens a tag unless it follows a value (`a < b`).
  let afterValue = false;
  let i = 0;

  while (i < src.length) {
    const mode = top();
    const ch = src[i]!;

    if (mode.kind === 'text') {
      if (ch === '{') {
        emit(ch, 'punc');
        stack.push({ kind: 'js' });
        afterValue = false;
        i++;
      } else if (src.startsWith('</>', i)) {
        emit('</>', 'punc');
        stack.pop();
        afterValue = true;
        i += 3;
      } else if (src.startsWith('</', i)) {
        emit('</', 'punc');
        stack[stack.length - 1] = { kind: 'tag', closing: true };
        i += 2;
        const name = at(TAG_NAME, src, i);
        if (name) {
          emit(name, 'tag');
          i += name.length;
        }
      } else if (src.startsWith('<>', i)) {
        emit('<>', 'punc');
        stack.push({ kind: 'text' });
        i += 2;
      } else if (ch === '<' && at(TAG_NAME, src, i + 1)) {
        i = openTag(src, i, emit, stack);
      } else {
        emit(ch);
        i++;
      }
      continue;
    }

    const space = at(SPACE, src, i);
    if (space) {
      emit(space);
      i += space.length;
      continue;
    }
    const comment = at(COMMENT, src, i);
    if (comment) {
      emit(comment, 'com');
      i += comment.length;
      continue;
    }
    const str = at(STRING, src, i);
    if (str) {
      emit(str, 'str');
      i += str.length;
      afterValue = true;
      continue;
    }

    if (mode.kind === 'tag') {
      if (src.startsWith('/>', i)) {
        emit('/>', 'punc');
        stack.pop();
        afterValue = true;
        i += 2;
      } else if (ch === '>') {
        emit(ch, 'punc');
        if (mode.closing) {
          stack.pop();
          afterValue = true;
        } else {
          stack[stack.length - 1] = { kind: 'text' };
        }
        i++;
      } else if (ch === '{') {
        emit(ch, 'punc');
        stack.push({ kind: 'js' });
        afterValue = false;
        i++;
      } else if (ch === '=') {
        emit(ch, 'punc');
        i++;
      } else {
        const attr = at(ATTR_NAME, src, i);
        emit(attr ?? ch, attr ? 'attr' : undefined);
        i += attr ? attr.length : 1;
      }
      continue;
    }

    // mode.kind === 'js'
    if (ch === '{' || ch === '(' || ch === '[') {
      if (ch === '{') stack.push({ kind: 'js' });
      emit(ch, ch === '{' ? 'punc' : undefined);
      afterValue = false;
      i++;
    } else if (ch === '}') {
      emit(ch, 'punc');
      if (stack.length > 1) stack.pop();
      afterValue = true;
      i++;
    } else if (ch === ')' || ch === ']') {
      emit(ch);
      afterValue = true;
      i++;
    } else if (src.startsWith('<>', i) && !afterValue) {
      emit('<>', 'punc');
      stack.push({ kind: 'text' });
      i += 2;
    } else if (ch === '<' && !afterValue && at(TAG_NAME, src, i + 1)) {
      i = openTag(src, i, emit, stack);
    } else {
      const ident = at(IDENT, src, i);
      const num = ident ? null : at(NUMBER, src, i);
      if (ident) {
        const tone = KEYWORDS.has(ident)
          ? 'kw'
          : at(KEY_AHEAD, src, i + ident.length)
            ? 'key'
            : undefined;
        emit(ident, tone);
        i += ident.length;
        afterValue = !KEYWORDS.has(ident) || /^(true|false|null|undefined)$/.test(ident);
      } else if (num) {
        emit(num, 'kw');
        i += num.length;
        afterValue = true;
      } else {
        emit(ch);
        afterValue = false;
        i++;
      }
    }
  }

  if (plain) out.push(plain);
  return out;
}

/** `<Name`: the bracket and the tag name; the attributes that follow are read in tag mode. */
function openTag(
  src: string,
  i: number,
  emit: (text: string, tone?: Tone) => void,
  stack: Mode[],
): number {
  const name = at(TAG_NAME, src, i + 1)!;
  emit('<', 'punc');
  emit(name, 'tag');
  stack.push({ kind: 'tag', closing: false });
  return i + 1 + name.length;
}
