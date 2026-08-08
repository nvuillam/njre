"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { pipeline } = require("stream/promises");
const yauzl = require("yauzl");
const tar = require("tar");
const debug = require("util").debuglog("njre");

// Abort network requests whose socket stays inactive for too long instead of
// hanging forever (e.g. against a dead/deprecated endpoint).
// See fix/adoptium-default-node24-hang.
const REQUEST_TIMEOUT_MS = 60000;

function matchesNoProxy(hostname, noProxy) {
  return noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, ""))
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const suffix = entry.startsWith(".") ? entry : "." + entry;
      return hostname === entry || hostname.endsWith(suffix);
    });
}

/**
 * Resolves the proxy to use for a given URL from the standard HTTPS_PROXY /
 * HTTP_PROXY / NO_PROXY environment variables (upper or lower case), so njre
 * can download binaries from behind a corporate proxy. Returns null when no
 * proxy applies. See nvuillam/njre#30.
 **/
function getProxyFor(url) {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxyUrl) return null;

  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  const hostname = new URL(url).hostname.toLowerCase();
  if (noProxy && matchesNoProxy(hostname, noProxy)) return null;

  return new URL(proxyUrl);
}

/**
 * Opens a tunnel to the target host through an HTTP proxy (CONNECT method),
 * resolving to the raw socket the TLS session can then be established on.
 **/
function connectThroughProxy(proxy, hostname, port) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (proxy.username || proxy.password) {
      const credentials =
        decodeURIComponent(proxy.username) +
        ":" +
        decodeURIComponent(proxy.password);
      headers["Proxy-Authorization"] =
        "Basic " + Buffer.from(credentials).toString("base64");
    }

    const request = (proxy.protocol === "https:" ? https : http).request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: hostname + ":" + port,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    });

    request.on("connect", (response, socket) => {
      if (response.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(
          new Error(
            `[njre] Proxy CONNECT failed with HTTP ${response.statusCode}`,
          ),
        );
      }
    });
    request.on("timeout", () =>
      request.destroy(
        new Error(`[njre] Proxy connection to ${proxy.host} timed out`),
      ),
    );
    request.on("error", reject);
    request.end();
  });
}

/**
 * Performs an https GET, going through the proxy configured in the
 * environment if any, and resolves to the response (http.IncomingMessage).
 * Redirects are NOT followed: callers read the location header themselves.
 **/
async function httpsGet(url) {
  const target = new URL(url);
  const port = target.port || 443;
  const options = { timeout: REQUEST_TIMEOUT_MS };

  const proxy = getProxyFor(url);
  if (proxy) {
    debug("Using proxy %s for %s", proxy.host, url);
    const socket = await connectThroughProxy(proxy, target.hostname, port);
    // agent must be disabled for createConnection to be honored (the default
    // agent would open its own direct connection instead of using the tunnel)
    options.agent = false;
    options.createConnection = () =>
      tls.connect({ socket, servername: target.hostname });
  }

  return new Promise((resolve, reject) => {
    const request = https.get(target, options, resolve);
    request.on("timeout", () =>
      request.destroy(new Error(`[njre] Request to ${url} timed out`)),
    );
    request.on("error", reject);
  });
}

async function download(dir, url) {
  await fsp.mkdir(dir, { recursive: true });

  // Follow redirects manually (e.g. github.com release assets redirect to
  // objects.githubusercontent.com), but keep the original url as file name.
  let response = await httpsGet(url);
  for (
    let redirects = 0;
    response.statusCode >= 300 &&
    response.statusCode < 400 &&
    response.headers.location &&
    redirects < 10;
    redirects++
  ) {
    response.resume();
    response = await httpsGet(new URL(response.headers.location, url).href);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(
      `[njre] Download failed with HTTP ${response.statusCode} for ${url}`,
    );
  }
  const destFile = path.join(dir, path.basename(url));
  await pipeline(response, fs.createWriteStream(destFile));
  return destFile;
}

async function downloadAll(dir, url) {
  await download(dir, url + ".sha256.txt");
  return download(dir, url);
}

async function getRedirectLocation(url) {
  const response = await httpsGet(url);
  response.resume();
  return response.headers.location;
}

async function genChecksum(file) {
  const data = await fsp.readFile(file);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function verify(file) {
  const data = await fsp.readFile(file + ".sha256.txt", "utf-8");
  const checksum = await genChecksum(file);
  if (checksum !== data.split("  ")[0]) {
    throw new Error("[njre] File and checksum don't match");
  }
  return file;
}

async function move(file, installPath) {
  const newFile = path.join(path.dirname(installPath), path.basename(file));

  // Copy + unlink instead of rename: the temp dir and the install dir may be
  // on different filesystems, where rename fails with EXDEV.
  await fsp.copyFile(file, newFile);
  await fsp.unlink(file);
  return newFile;
}

function extractZip(file, dir) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zipFile) => {
      if (err) reject(err);

      zipFile.readEntry();
      zipFile.on("entry", (entry) => {
        const entryPath = path.join(dir, entry.fileName);

        if (/\/$/.test(entry.fileName)) {
          fs.mkdir(entryPath, { recursive: true }, (err) => {
            if (err && err.code !== "EEXIST") reject(err);

            zipFile.readEntry();
          });
        } else {
          zipFile.openReadStream(entry, (err, readStream) => {
            if (err) reject(err);

            readStream.on("end", () => {
              zipFile.readEntry();
            });
            readStream.pipe(fs.createWriteStream(entryPath));
          });
        }
      });
      zipFile.once("close", () => {
        fs.unlink(file, (err) => {
          if (err) reject(err);
          resolve(dir);
        });
      });
    });
  });
}

async function extractTarGz(file, dir) {
  await tar.x({ file: file, cwd: dir });
  await fsp.unlink(file);
  return dir;
}

async function extract(file) {
  const dir = path.join(path.dirname(file), "jre");

  await fsp.mkdir(dir, { recursive: true });
  return path.extname(file) === ".zip"
    ? extractZip(file, dir)
    : extractTarGz(file, dir);
}

/**
 * The API will decide if it needs to redirect from api.adoptopenjdk.net to
 * api.adoptium.net before finally redirecting to the binary. This function
 * handles the initial redirection if needed, otherwise it just returns the
 * location url for the binary.
 **/
async function followToAdoptium(location) {
  if (/api.adoptium.net/g.test(location)) {
    const nextLocation = await getRedirectLocation(location);
    if (!nextLocation) {
      throw new Error(`[njre] No binary found (redirect from ${location})`);
    }
    return nextLocation;
  }
  return location;
}

/**
 * Installs a JRE copy for the app
 * @param {number} [version = 8] - Java Version (`8`/`9`/`10`/`11`/`12`)
 * @param {object} [options] - Installation Options
 * @param {string} [options.os] - Operating System (defaults to current) (`windows`/`mac`/`linux`/`solaris`/`aix`)
 * @param {string} [options.arch] - Architecture (defaults to current) (`x64`/`x32`/`ppc64`/`s390x`/`ppc64le`/`aarch64`/`sparcv9`)
 * @param {string} [options.openjdk_impl = hotspot] - OpenJDK Implementation (`hotspot`/`openj9`)
 * @param {string} [options.release = latest] - Release
 * @param {string} [options.type = jre] - Binary Type (`jre`/`jdk`)
 * @param {string} [options.heap_size] - Heap Size (`normal`/`large`)
 * @param {string} [options.vendor = eclipse] - JRE/JDK vendor (`eclipse`/`adoptopenjdk`). Both resolve to api.adoptium.net (Eclipse Temurin); the deprecated api.adoptopenjdk.net host is no longer used.
 * @param {string} [options.installPath] - Where to install java (default process.cwd())
 * @return Promise<string> - Resolves to the installation directory or rejects an error
 *
 * Proxy support: if the `HTTPS_PROXY` (or `HTTP_PROXY`) environment variable is
 * set (upper or lower case), all downloads go through that proxy. Hosts listed
 * in `NO_PROXY` (comma-separated, `*` wildcard supported) bypass it.
 * @example
 * const njre = require('njre')
 *
 * // Use default options
 * njre.install()
 *   .then(dir => {
 *     // Do stuff
 *   })
 *   .catch(err => {
 *     // Handle the error
 *   })
 *
 * // or custom ones
 * njre.install(11, { os: 'aix', arch: 'ppc64', openjdk_impl: 'openj9' })
 *   .then(dir => {
 *     // Do stuff
 *   })
 *   .catch(err => {
 *     // Handle the error
 *   })
 */
async function install(version = 8, options = {}) {
  const {
    openjdk_impl = "hotspot",
    release = "latest",
    type = "jre",
    heap_size = "normal",
    vendor = "eclipse",
    installPath = require?.main?.filename || process.cwd(),
  } = options;

  options = { ...options, openjdk_impl, release, type, heap_size, vendor };

  // Java 8 not supported by Api, set default value to Java 11
  if (os.platform() === "darwin" && version === 8) {
    version = 11;
  }
  // Block if use tries impossible combination
  if (options.release === "8" && os.platform() === "darwin") {
    throw new Error("Java 8 is not available in darwin platform (Mac)");
  }

  // The legacy api.adoptopenjdk.net host is deprecated and now hangs (notably
  // under Node.js 24 on Windows). Everything is served by api.adoptium.net
  // (Eclipse Temurin), whose v3 API expects the `eclipse` vendor path segment.
  // Keep accepting the legacy `adoptopenjdk` value for backward compatibility,
  // but transparently route it to Adoptium.
  let endpoint = null;
  let vendorPath = null;
  if (options.vendor === "eclipse" || options.vendor === "adoptopenjdk") {
    endpoint = "api.adoptium.net";
    vendorPath = "eclipse";
  } else {
    throw new Error(
      `[njre] Unsupported vendor ${options.vendor}. Use eclipse (default) or adoptopenjdk`,
    );
  }

  const versionPath =
    options.release === "latest"
      ? "latest/" + version + "/ga"
      : "version/" + options.release;

  if (!options.os) {
    switch (process.platform) {
      case "aix":
        options.os = "aix";
        break;
      case "darwin":
        options.os = "mac";
        break;
      case "linux":
        options.os = "linux";
        break;
      case "sunos":
        options.os = "solaris";
        break;
      case "win32":
        options.os = "windows";
        break;
      default:
        throw new Error(
          `[njre] Unsupported operating system ${process.platform}`,
        );
    }
  }
  if (!options.arch) {
    if (/^ppc64|s390x|x32|x64$/g.test(process.arch))
      options.arch = process.arch;
    else if (process.arch === "ia32") options.arch = "x32";
    else if (process.arch === "arm64") options.arch = "aarch64";
    else throw new Error(`[njre] Unsupported architecture ${process.arch}`);
  }

  const url =
    "https://" +
    endpoint +
    "/v3/binary/" +
    versionPath +
    "/" +
    options.os +
    "/" +
    options.arch +
    "/" +
    options.type +
    "/" +
    options.openjdk_impl +
    "/" +
    options.heap_size +
    "/" +
    vendorPath;

  const tmpdir = path.join(os.tmpdir(), "njre");

  debug("Java URL: %s", url);
  const location = await getRedirectLocation(url);
  if (!location) {
    throw new Error(`[njre] No binary found for ${url}`);
  }
  const binaryUrl = await followToAdoptium(location);
  const file = await downloadAll(tmpdir, binaryUrl);
  await verify(file);
  const movedFile = await move(file, installPath);
  return extract(movedFile);
}

module.exports = install;
