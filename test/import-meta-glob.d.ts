// Vite `import.meta.glob` (eager, `?raw`): file contents by path; used by tests that scan sources.
interface ImportMeta {
  glob<T = unknown>(
    patterns: string | string[],
    options: { query?: string; import?: string; eager: true },
  ): Record<string, T>;
}
