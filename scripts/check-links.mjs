// Checks every relative link and #anchor in the repository's Markdown files (GitHub heading slug
// rules, <a id> anchors, duplicate headings). Usage: node scripts/check-links.mjs [repo-root]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const skip = new Set(['node_modules', '.git', '.wrangler', 'coverage', 'dist']);
function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
const stripFences = (t) => {
  const lines = t.split('\n');
  let inF = false,
    fence = '';
  return lines
    .map((l) => {
      const m = l.match(/^\s*(```+|~~~+)/);
      if (m) {
        if (!inF) {
          inF = true;
          fence = m[1][0];
          return '';
        }
        if (m[1][0] === fence) {
          inF = false;
          return '';
        }
      }
      return inF ? '' : l;
    })
    .join('\n');
};
const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
const anchorCache = new Map();
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const t = stripFences(readFileSync(file, 'utf8'));
  const set = new Set();
  const seen = new Map();
  for (const l of t.split('\n')) {
    const m = l.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m) {
      const s = slug(m[1]);
      const n = seen.get(s) ?? 0;
      set.add(n ? `${s}-${n}` : s);
      seen.set(s, n + 1);
    }
    for (const a of l.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(a[1]);
  }
  anchorCache.set(file, set);
  return set;
}
let bad = 0,
  total = 0;
const files = walk(root);
for (const f of files) {
  const t = stripFences(readFileSync(f, 'utf8')).replace(/`[^`\n]*`/g, '');
  const links = [...t.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]);
  for (const ref of t.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) links.push(ref[1]);
  for (const l of links) {
    if (/^(https?:|mailto:|tel:)/.test(l)) continue;
    total++;
    const [p, h] = l.split('#');
    const target = p ? resolve(dirname(f), decodeURIComponent(p)) : f;
    const rf = relative(root, f);
    if (!existsSync(target)) {
      console.log(`BROKEN  ${rf}: ${l} (missing file)`);
      bad++;
      continue;
    }
    if (h !== undefined && target.endsWith('.md') && statSync(target).isFile()) {
      if (/^L\d+/.test(h)) continue;
      if (!anchors(target).has(h)) {
        console.log(`BROKEN  ${rf}: ${l} (missing anchor)`);
        bad++;
      }
    }
  }
}
console.log(`checked ${total} relative links in ${files.length} files; ${bad} broken`);
process.exit(bad ? 1 : 0);
