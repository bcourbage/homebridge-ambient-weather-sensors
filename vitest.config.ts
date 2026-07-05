import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live under `tests/` in a mirror of `src/` so it's obvious
    // which src module each test file exercises. Deliberately keeping
    // tests OUT of src/ so nothing gets accidentally shipped in the
    // npm tarball (belt-and-suspenders — the package.json `files`
    // allowlist would exclude them anyway).
    include: ['tests/**/*.test.ts'],
    // The plugin doesn't touch the filesystem or the network from any
    // pure-function or wrapper-class code paths, so happy-path tests
    // don't need a DOM. `node` is faster than `happy-dom`/`jsdom`.
    environment: 'node',
    // Match Homebridge's runtime globals close enough — the plugin
    // uses `fetch` (Node 22 native), `setTimeout`/`clearInterval`,
    // and `Date.now()`. All available in the node env by default.
    globals: false,
    // Show test names as they execute — cheap signal when debugging
    // a specific failure locally.
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      // Report coverage for src/ regardless of whether a test file
      // imports the module. Uncovered files show as 0% in the report,
      // which is the honest signal (rather than "hidden because no
      // test file touched them").
      include: ['src/**/*.ts'],
      // Type-only files carry no runtime behavior. Excluding them
      // keeps the coverage % meaningful.
      exclude: ['src/types.ts', 'src/index.ts', 'src/settings.ts'],
      reporter: ['text', 'html', 'lcov'],
      // No threshold enforcement in the first cut. Add later once
      // we know the natural coverage level.
    },
  },
});
