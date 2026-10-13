// Vite `?raw` imports (file contents as a string); used by tests that check repo config files.
declare module '*?raw' {
  const content: string;
  export default content;
}
