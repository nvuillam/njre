# njre - Development guide

njre downloads a JRE/JDK from the Adoptium API, verifies its SHA-256 checksum and extracts it locally. Public API: a single `install(version, options)` function (see README.md).

## Layout

- `index.js` - public entry point, re-exports `lib/install.js`
- `lib/install.js` - the whole implementation (only `lib/*.js` is published to npm)
- `tests/test.js` - test suite (Node.js built-in `node:test` runner, no test framework dependency)

## Commands

```bash
yarn install          # ALWAYS use yarn, not npm: yarn.lock is the source of truth
yarn test             # node:test suite (downloads real JRE/JDK binaries, needs network, takes a few minutes)
yarn coverage         # same suite with native coverage (--experimental-test-coverage)
yarn lint             # prettier --check
yarn lint:fix         # prettier --write
```

## Implementation notes

- Node.js >= 18, CommonJS. Only 2 runtime dependencies (`tar`, `yauzl` for archive extraction); HTTP is done with the built-in `https`/`http`/`tls` modules - do not add HTTP client dependencies.
- Proxy support (HTTPS_PROXY / HTTP_PROXY / NO_PROXY, checked per request at runtime) is hand-rolled in `lib/install.js`: `getProxyFor()` reads the environment, `connectThroughProxy()` opens an HTTP CONNECT tunnel (with Basic auth from the proxy URL userinfo), and `httpsGet()` runs the TLS request over it. When tunneling, `agent: false` is required for `createConnection` to be honored.
- Download flow: Adoptium API URL → manual redirect(s) to the binary URL → download `<binary>.sha256.txt` then the binary (following redirects, e.g. github.com → release-assets.githubusercontent.com) → checksum verification → move next to `installPath` → extraction into a `jre` folder.
- Debug logs use `util.debuglog("njre")`, enabled with `NODE_DEBUG=njre`.

## Style and CI

- Code style is prettier (enforced by MegaLinter, `JAVASCRIPT_DEFAULT_STYLE: prettier` in `.mega-linter.yml`). Do not use standard/eslint styles.
- CI (`.github/workflows/test.yml`) runs the mocha suite on a matrix of OS (ubuntu/macos/windows) × Node versions.
- Documentation lives in README.md only - there is no generated DOCS.md anymore, keep the README API table in sync with the JSDoc of `install()`.

## Releasing

- `deploy-RELEASE.yml` publishes to npm on GitHub release.
- Bump `version` in package.json following semver (engine or behavior changes are breaking).
