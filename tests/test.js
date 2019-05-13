const njre = require('..')

describe('Install', () => {
  it('should install JRE with default options without throwing an error', () => {
    return njre.install()
  }).timeout(100000)

  it('should install JRE with custom options without throwing an error', () => {
    return njre.install(11, { os: 'aix', arch: 'ppc64', openjdk_impl: 'openj9' })
  }).timeout(100000)
})
