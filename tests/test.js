/* global describe, it, before, after, afterEach */

"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const njre = require("..");

const TIMEOUT = 240000;

// Directories created by the tests, removed at the end of the suite
const createdDirs = [];

function tmpInstallPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `njre-test-${name}-`));
  createdDirs.push(dir);
  // install() extracts into path.dirname(installPath)/jre
  return path.join(dir, "app.js");
}

function findFile(dir, names) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return entryPath;
    if (entry.isDirectory()) {
      const found = findFile(entryPath, names);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Installs and asserts the result actually looks like a Java distribution:
 * a java executable is present, and the `release` metadata file reports the
 * expected major version.
 **/
async function installAndCheck(name, version, options, expectedVersion) {
  const dir = await njre.install(version, {
    ...options,
    installPath: tmpInstallPath(name),
  });

  const javaBin = findFile(dir, ["java", "java.exe"]);
  assert.ok(javaBin, `no java binary found in ${dir}`);

  if (expectedVersion) {
    const releaseFile = findFile(dir, ["release"]);
    assert.ok(releaseFile, `no release metadata file found in ${dir}`);
    const javaVersion = fs
      .readFileSync(releaseFile, "utf-8")
      .match(/JAVA_VERSION="([^"]+)"/)[1];
    const expectedPrefix = expectedVersion === 8 ? "1.8" : `${expectedVersion}`;
    assert.ok(
      javaVersion.startsWith(expectedPrefix),
      `expected Java ${expectedVersion}, got ${javaVersion}`,
    );
  }
  return dir;
}

after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort (files may be locked on Windows)
    }
  }
});

describe("Install configurations", () => {
  it("should install JRE with default options", () => {
    return njre.install();
  }).timeout(TIMEOUT);

  it("should install JRE 8 on linux/x64 (tar.gz)", () => {
    return installAndCheck("linux8", 8, { os: "linux", arch: "x64" }, 8);
  }).timeout(TIMEOUT);

  it("should install JRE 11 on linux/x64", () => {
    return installAndCheck("linux11", 11, { os: "linux", arch: "x64" }, 11);
  }).timeout(TIMEOUT);

  it("should install JRE 21 on linux/aarch64", () => {
    return installAndCheck(
      "linuxarm",
      21,
      { os: "linux", arch: "aarch64" },
      21,
    );
  }).timeout(TIMEOUT);

  it("should install JRE 17 on windows/x64 (zip)", () => {
    return installAndCheck("win17", 17, { os: "windows", arch: "x64" }, 17);
  }).timeout(TIMEOUT);

  it("should install JRE 17 on mac/x64", () => {
    return installAndCheck("mac17", 17, { os: "mac", arch: "x64" }, 17);
  }).timeout(TIMEOUT);

  it("should install JRE 21 on mac/aarch64", () => {
    return installAndCheck("macarm", 21, { os: "mac", arch: "aarch64" }, 21);
  }).timeout(TIMEOUT);

  it("should install JRE 17 on aix/ppc64", () => {
    return installAndCheck("aix17", 17, { os: "aix", arch: "ppc64" }, 17);
  }).timeout(TIMEOUT);

  it("should install JDK 17 on current platform", () => {
    return installAndCheck("jdk17", 17, { type: "jdk" }, 17);
  }).timeout(TIMEOUT);

  it("should install JDK with an exact release name", () => {
    return installAndCheck(
      "release21",
      null,
      { release: "jdk-21+34-ea-beta", os: "linux", arch: "x64" },
      21,
    );
  }).timeout(TIMEOUT);
});

describe("Errors", () => {
  it("should reject an unsupported vendor", () => {
    return assert.rejects(
      njre.install(17, { vendor: "unknown-vendor" }),
      /Unsupported vendor/,
    );
  }).timeout(TIMEOUT);

  it("should reject when no binary exists for the version", () => {
    return assert.rejects(njre.install(99), /No binary found/);
  }).timeout(TIMEOUT);

  it("should reject when no binary exists for the os/arch combination", () => {
    return assert.rejects(
      njre.install(17, { os: "solaris", arch: "aarch64" }),
      /No binary found/,
    );
  }).timeout(TIMEOUT);
});

describe("Proxy", () => {
  const PROXY_USER = "user";
  const PROXY_PASSWORD = "p@ss word";
  const savedEnv = {};
  const openSockets = new Set();
  let proxy;
  let proxyPort;
  let tunnels;

  before((done) => {
    for (const key of [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "NO_PROXY",
      "no_proxy",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    // Minimal local HTTP CONNECT proxy requiring Basic auth
    const expectedAuth =
      "Basic " +
      Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString("base64");
    proxy = http.createServer();
    proxy.on("connection", (socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      if (req.headers["proxy-authorization"] !== expectedAuth) {
        clientSocket.end(
          "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n",
        );
        return;
      }
      tunnels++;
      const [host, port] = req.url.split(":");
      const serverSocket = net.connect(Number(port) || 443, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });
      openSockets.add(serverSocket);
      serverSocket.on("close", () => openSockets.delete(serverSocket));
      serverSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => serverSocket.destroy());
    });
    proxy.listen(0, "127.0.0.1", () => {
      proxyPort = proxy.address().port;
      done();
    });
  });

  after((done) => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Destroy lingering tunnel sockets so the server can actually close
    for (const socket of openSockets) socket.destroy();
    proxy.close(done);
  });

  afterEach(() => {
    for (const key of ["HTTPS_PROXY", "NO_PROXY"]) delete process.env[key];
  });

  it("should install through an authenticated proxy set by HTTPS_PROXY", async () => {
    tunnels = 0;
    const credentials = `${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASSWORD)}`;
    process.env.HTTPS_PROXY = `http://${credentials}@127.0.0.1:${proxyPort}`;
    await installAndCheck("proxy", 17, {}, 17);
    assert.ok(tunnels > 0, "no request went through the proxy");
  }).timeout(TIMEOUT);

  it("should fail with wrong proxy credentials", () => {
    process.env.HTTPS_PROXY = `http://user:wrong@127.0.0.1:${proxyPort}`;
    return assert.rejects(
      njre.install(17, { installPath: tmpInstallPath("proxybadauth") }),
      /Proxy CONNECT failed with HTTP 407/,
    );
  }).timeout(TIMEOUT);

  it("should fail fast with an unreachable proxy", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    return assert.rejects(
      njre.install(17, { installPath: tmpInstallPath("proxydead") }),
      /ECONNREFUSED/,
    );
  }).timeout(TIMEOUT);

  it("should bypass the proxy for hosts listed in NO_PROXY", async () => {
    tunnels = 0;
    const credentials = `${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASSWORD)}`;
    process.env.HTTPS_PROXY = `http://${credentials}@127.0.0.1:${proxyPort}`;
    process.env.NO_PROXY = "*";
    await installAndCheck("noproxy", 17, {}, 17);
    assert.strictEqual(
      tunnels,
      0,
      "a request went through the proxy despite NO_PROXY=*",
    );
  }).timeout(TIMEOUT);
});
