// `import text from './x.css'` is the file contents as a string. Apps bundle CSS with a wrangler
// `Text` module rule (`"rules": [{ "type": "Text", "globs": ["**/*.css"] }]`), and `wrangler types`
// then declares `*.css` for them; this file declares it for this package's own typecheck. Vitest
// gets the same string from vite-css-text.ts. Workers cannot read files at runtime, so this is
// how the stylesheet reaches the Worker.
declare module '*.css' {
  const value: string;
  export default value;
}
