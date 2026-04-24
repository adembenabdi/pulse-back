// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Enforce the db.scoped() chokepoint — no direct pool access
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='pool'][callee.property.name='query']",
          message:
            'Use db.scoped(userId) or db.shared(userId) instead of calling pool.query() directly.',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'openapi/scripts/**'],
  },
);
