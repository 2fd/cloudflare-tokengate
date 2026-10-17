// Reads the prop names of a component from the @tokengate/ui source, so the docs props tables can
// be checked against the interfaces they describe. A small reader for the shapes this package
// uses (interfaces with extends, type aliases with &, | and Omit<>, inline object types), not a
// TypeScript parser: an unknown shape fails the test loudly instead of passing silently.
/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '../../../packages/ui/src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

const SOURCE = files(SRC)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
  // comments carry braces and colons that are not code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The text between the bracket at `open` and its match. */
function block(text: string, open: number): string {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '<': '>' };
  const close = pairs[text[open] as string] as string;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === text[open]) depth++;
    else if (ch === close && !(close === '>' && text[i - 1] === '=')) {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced ${text[open]} at ${open}`);
}

interface Member {
  name: string;
  /** Typed `never` or `undefined`: a union placeholder, not a prop to document. */
  placeholder: boolean;
}

/** Members declared at the top level of an object type body. */
function members(body: string): Member[] {
  const out: Member[] = [];
  let depth = 0;
  let start = 0;
  const flush = (end: number) => {
    const part = body.slice(start, end).trim();
    const m = /^(?:readonly\s+)?['"]?([A-Za-z_$][\w$-]*)['"]?\??:\s*([\s\S]*)$/.exec(part);
    if (m)
      out.push({
        name: m[1] as string,
        placeholder: /^(never|undefined)\s*$/.test(m[2] as string),
      });
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[' || (ch === '<' && body[i + 1] !== '=')) depth++;
    else if (ch === '}' || ch === ')' || ch === ']' || (ch === '>' && body[i - 1] !== '=')) depth--;
    else if ((ch === ';' || ch === '\n') && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(body.length);
  return out;
}

const cache = new Map<string, Member[]>();

/** Keys of a type expression: names, `&`, `|`, parentheses, `Omit<…>`, object literals. */
function typeKeys(expr: string): Member[] {
  const out: Member[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i] as string;
    if (ch === '{') {
      const body = block(expr, i);
      out.push(...members(body));
      i += body.length + 2;
    } else if (ch === '(') {
      const inner = block(expr, i);
      out.push(...typeKeys(inner));
      i += inner.length + 2;
    } else if (/[A-Za-z_]/.test(ch)) {
      const name = /^[\w.]+/.exec(expr.slice(i))?.[0] as string;
      i += name.length;
      if (name === 'Omit' || name === 'Pick' || name === 'Partial' || name === 'Readonly') {
        const args = block(expr, i);
        i += args.length + 2;
        const comma = args.lastIndexOf(',');
        const base = name === 'Omit' || name === 'Pick' ? args.slice(0, comma) : args;
        const listed = new Set([...args.slice(comma + 1).matchAll(/'([^']+)'/g)].map((m) => m[1]));
        const keys = typeKeys(base);
        out.push(
          ...(name === 'Omit'
            ? keys.filter((k) => !listed.has(k.name))
            : name === 'Pick'
              ? keys.filter((k) => listed.has(k.name))
              : keys),
        );
      } else if (/^[A-Z]/.test(name)) {
        out.push(...namedKeys(name));
      }
    } else {
      i++;
    }
  }
  return out;
}

/** Keys of a named interface or type alias of the package (`never` placeholders included). */
export function namedKeys(name: string): Member[] {
  const hit = cache.get(name);
  if (hit) return hit;
  if (name === 'Child' || name === 'HiddenFields') return [];
  const iface = new RegExp(
    `(?:export )?interface ${name}\\b(?:<[^>]*>)?\\s*(?:extends ([^{]+))?\\{`,
  ).exec(SOURCE);
  let keys: Member[];
  if (iface) {
    const body = block(SOURCE, iface.index + iface[0].length - 1);
    keys = [...(iface[1] ? typeKeys(iface[1]) : []), ...members(body)];
  } else {
    const alias = new RegExp(`(?:export )?type ${name}\\b(?:<[^>]*>)?\\s*=`).exec(SOURCE);
    if (!alias) throw new Error(`no interface or type named ${name} in @tokengate/ui`);
    const rest = SOURCE.slice(alias.index + alias[0].length);
    const end = /;\s*\n(?=(?:export |interface |type |function |const |\/\*\*|$))/.exec(rest);
    keys = typeKeys(end ? rest.slice(0, end.index) : rest);
  }
  cache.set(name, keys);
  return keys;
}

/**
 * The props of exported component `name`: the keys of its parameter type, without the union
 * placeholders. Throws for a component whose parameter it cannot read.
 */
export function componentProps(name: string): string[] {
  const fn = new RegExp(`export function ${name}\\(`).exec(SOURCE);
  if (!fn) throw new Error(`no exported function ${name}`);
  const params = block(SOURCE, fn.index + fn[0].length - 1);
  let keys: Member[];
  if (params.trim() === '') keys = [];
  else {
    const colon = (() => {
      // the colon after the parameter (a name or a destructuring pattern)
      let depth = 0;
      for (let i = 0; i < params.length; i++) {
        const ch = params[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === ':' && depth === 0) return i;
      }
      return -1;
    })();
    if (colon < 0) throw new Error(`${name}: untyped parameter`);
    keys = typeKeys(params.slice(colon + 1));
  }
  const names = new Map<string, boolean>();
  for (const key of keys) names.set(key.name, (names.get(key.name) ?? true) && key.placeholder);
  return [...names].filter(([, placeholder]) => !placeholder).map(([key]) => key);
}
