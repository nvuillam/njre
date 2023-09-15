/* global describe, it */

const njre = require('..')

describe('Install', () => {
  it('should install JRE with default options without throwing an error', () => {
    return njre.install()
  }).timeout(100000)

  it('should install JDK with custom options without throwing an error', () => {
    return njre.install(11, { os: 'aix', arch: 'ppc64', openjdk_impl: 'hotspot', type: 'jdk' })
  }).timeout(100000)

  it('should install JDK with custom release without throwing an error', () => {
    return njre.install(null, { release: 'jdk-21+34-ea-beta' })
  }).timeout(100000)
})
