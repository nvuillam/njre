import js from '@eslint/js'
import globals from 'globals'

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
  }
]
