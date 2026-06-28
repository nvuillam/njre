import js from '@eslint/js'
import globals from 'globals'
import jsonc from 'eslint-plugin-jsonc'

export default [
  // Ignore patterns (node_modules only; lib/ is source and must be linted)
  {
    ignores: ['node_modules/']
  },

  // JavaScript files: equivalent to legacy `eslint:recommended` + env node/commonjs/es2021
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {}
  },

  // JSON / JSONC linting (legacy: plugin:jsonc/recommended-with-jsonc, jsonc parser)
  ...jsonc.configs['flat/recommended-with-jsonc'].map((config) => ({
    ...config,
    files: ['**/*.json', '**/*.jsonc']
  })),

  // JSON5 linting (legacy: plugin:jsonc/recommended-with-json5, jsonc parser)
  ...jsonc.configs['flat/recommended-with-json5'].map((config) => ({
    ...config,
    files: ['**/*.json5']
  }))
]
