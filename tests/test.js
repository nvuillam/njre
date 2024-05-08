/* global describe, it */

const njre = require("..");

describe("Install", () => {
  it("should install JRE with default options without throwing an error", () => {
    return njre.install();
  }).timeout(100000);

  it("should install JRE with custom options without throwing an error", () => {
    return njre.install(11, {
      os: "aix",
      arch: "ppc64",
      openjdk_impl: "openj9",
    });
  }).timeout(100000);

  it("should install JDK with custom release without throwing an error", () => {
    return njre.install(null, { release: "jdk-21+34-ea-beta" });
  }).timeout(100000);

  it("should install JRE 14 from AdoptOpenJdk without throwing an error", () => {
    return njre.install(14, { os: "linux" });
  }).timeout(100000);

  it("should install JDK 17 without throwing an error", () => {
    return njre.install(17, { type: "jdk" });
  }).timeout(100000);

  it("should install JRE 20 from Eclipse Foundation without throwing an error", () => {
    return njre.install(20, { vendor: "eclipse" });
  }).timeout(100000);

  it("should install JRE 21 from Eclipse Foundation without throwing an error", () => {
    return njre.install(21, { vendor: "eclipse" });
  }).timeout(100000);
});
