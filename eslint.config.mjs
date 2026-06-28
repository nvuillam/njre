export default [
  // Ignore patterns (node_modules only; lib/ is source)
  {
    ignores: ['node_modules/']
  },

  // JavaScript files: minimal self-contained config (no external imports, so it
  // resolves under MegaLinter's bundled ESLint where ESM ignores NODE_PATH)
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly'
      }
    },
    rules: {}
  }
]
