import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'public/icons/**', 'output/**', '.local/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'no-console': 'error' },
  },
  { files: ['public/*.mjs'], languageOptions: { globals: globals.browser } },
  {
    files: ['src/domain/*.mjs', 'src/application/*.mjs'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['*infrastructure*', '*presentation*', 'express', 'mongodb', 'node:*'] },
      ],
    },
  },
];
