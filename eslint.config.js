// ESLint flat config (eslint 9.x convention). Replaces the legacy
// .eslintrc that shipped with the upstream plugin template. Targeting
// only src/**/*.ts; dist/, images/, homebridge-ui/, and node_modules/
// are excluded.
//
// Stylistic rules from the original .eslintrc (quotes, indent,
// brace-style, comma-spacing, etc.) intentionally NOT carried over —
// they're best handled by a formatter (Prettier or editor integration)
// rather than by lint. Only high-signal correctness rules remain.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'images/**',
      'homebridge-ui/**',
      'node_modules/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // High-signal correctness rules preserved from the original .eslintrc
      eqeqeq: 'warn',
      curly: ['warn', 'all'],
      'prefer-arrow-callback': 'warn',
      // We have homebridge's structured log methods (this.platform.log.*);
      // direct console.* would bypass them.
      'no-console': 'warn',

      // Don't force every function to declare an explicit return type —
      // TypeScript's inference handles it for the simple cases the codebase
      // tends to have.
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // The legacy parseDevices(json) signature and a couple other places
      // use bare/implicit any. The runtime-shape data from AWN is loose; the
      // upstream code lived with this. Don't fail lint for inherited patterns.
      '@typescript-eslint/no-explicit-any': 'off',
      // platform.ts uses `accessory.getService(AccessoryInformation)!` —
      // non-null assertion is fine here because HAP always provides it.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
