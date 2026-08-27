// Declarations for imports the bundler understands and TypeScript does not.
// Without these, `tsc --noEmit` reports three permanent errors and the gate
// becomes noise nobody reads — which is the same as not having it.

// Side-effect CSS imports: bun inlines these into the bundle. There is no value
// to import, so the module is empty on purpose.
declare module "*.css";

// monaco's ESM json contribution really does export `jsonDefaults` at runtime —
// its shipped .d.ts just does not say so, which is the same mismatch the import
// site in ConfigDrawer.tsx already carries a comment about.
declare module "monaco-editor/esm/vs/language/json/monaco.contribution.js" {
  export const jsonDefaults: {
    setDiagnosticsOptions(options: Record<string, unknown>): void;
  };
}
