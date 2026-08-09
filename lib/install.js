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
      if (response.statusCode === 200) {
        // The tunnel socket outlives the CONNECT request that created it: a
        // late error (e.g. a reset arriving after the tunneled response
        // completed) must not crash the process as an unhandled 'error'.
        socket.on("error", () => {});
        resolve(socket);
      } else {
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
 * Performs a GET on an http(s) url, going through the proxy configured in the
 * environment if any, and resolves to the response (http.IncomingMessage).
 * Redirects are NOT followed: callers read the location header themselves.
 **/
async function httpGet(url) {
  const target = new URL(url);
  const secure = target.protocol !== "http:";
  const port = target.port || (secure ? 443 : 80);
  const options = { timeout: REQUEST_TIMEOUT_MS };

  const proxy = getProxyFor(url);
  if (proxy) {
    debug("Using proxy %s for %s", proxy.host, url);
    const socket = await connectThroughProxy(proxy, target.hostname, port);
    // Node only honors createConnection when no agent option is present at
    // all: both an Agent instance and `agent: false` create their own direct
    // connection and would silently bypass the tunnel.
    options.createConnection = () =>
      secure ? tls.connect({ socket, servername: target.hostname }) : socket;
    // With no agent there is no agent.defaultPort either, so Node would
    // assume port 80 and send `Host: <hostname>:80` for an https url - some
    // servers (github.com) answer that with endless canonical-url redirects.
    options.defaultPort = port;
  }

  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).get(target, options, resolve);
    request.on("timeout", () =>
      request.destroy(new Error(`[njre] Request to ${url} timed out`)),
    );
    request.on("error", reject);
  });
}

/**
 * Discards a response body: attaches an error handler (a connection reset on
 * an abandoned body would otherwise crash the process with an unhandled
 * 'error' event) and drains the remaining data.
 **/
function drain(response) {
  response.on("error", () => {});
  response.resume();
}

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
]);

/**
 * Large downloads can be cut short by transient network conditions (e.g. a
 * throttled CDN connection reset right at the end of the transfer): retry
 * them a couple of times before giving up.
 **/
async function download(dir, url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await downloadAttempt(dir, url);
    } catch (err) {
      const transient =
        TRANSIENT_ERROR_CODES.has(err.code) ||
        / with HTTP 5\d\d /.test(err.message);
      if (!transient) throw err;
      debug(
        "Transient failure (attempt %d/3) for %s: %s",
        attempt,
        url,
        err.message,
      );
      lastError = err;
    }
  }
  throw lastError;
}

async function downloadAttempt(dir, url) {
  await fsp.mkdir(dir, { recursive: true });

  // Follow redirects manually (e.g. github.com release assets redirect to
  // release-assets.githubusercontent.com), but keep the original url as file
  // name.
  let currentUrl = url;
  let response = await httpGet(currentUrl);
  for (
    let redirects = 0;
    response.statusCode >= 300 &&
    response.statusCode < 400 &&
    response.headers.location &&
    redirects < 10;
    redirects++
  ) {
    drain(response);
    currentUrl = new URL(response.headers.location, currentUrl).href;
    response = await httpGet(currentUrl);
  }
  if (response.statusCode !== 200) {
    drain(response);
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

async function genChecksum(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
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
      if (err) return reject(err);

      zipFile.readEntry();
      zipFile.on("error", reject);
      zipFile.on("entry", (entry) => {
        const entryPath = path.join(dir, entry.fileName);

        if (/\/$/.test(entry.fileName)) {
          fs.mkdir(entryPath, { recursive: true }, (err) => {
            if (err && err.code !== "EEXIST") return reject(err);

            zipFile.readEntry();
          });
        } else {
          zipFile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);

            const writeStream = fs.createWriteStream(entryPath);
            readStream.on("error", reject);
            writeStream.on("error", reject);
            // Move on to the next entry only once the file is fully flushed and
            // closed on disk: the end of the read stream does not mean the
            // pending writes are done, and the archive would then be considered
            // extracted while the last files are still empty or truncated.
            writeStream.on("close", () => {
              zipFile.readEntry();
            });
            readStream.pipe(writeStream);
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

const API_HOSTS = new Set(["api.adoptium.net", "api.adoptopenjdk.net"]);

/**
 * Follows the API redirect chain (which may hop between API hosts, e.g. from
 * api.adoptopenjdk.net to api.adoptium.net, before pointing to the binary)
 * and resolves to the first non-API url: the binary download url. Resolves
 * to null when the API answers 404 (no binary for that combination).
 **/
async function resolveBinaryUrl(apiUrl) {
  let url = apiUrl;
  for (let redirects = 0; redirects < 10; redirects++) {
    const response = await httpGet(url);
    drain(response);
    const { statusCode } = response;
    const location = response.headers.location;
    if (statusCode >= 300 && statusCode < 400 && location) {
      url = new URL(location, url).href;
      if (!API_HOSTS.has(new URL(url).hostname)) return url;
    } else if (statusCode === 404) {
      return null;
    } else {
      throw new Error(`[njre] Unexpected HTTP ${statusCode} from ${url}`);
    }
  }
  throw new Error(`[njre] Too many redirects from ${apiUrl}`);
}

/**
 * Installs a JRE copy for the app
 * @param {number} [version = 8] - Java major version (e.g. `8`/`11`/`17`/`21`). On macOS the minimum is `11`.
 * @param {object} [options] - Installation Options
 * @param {string} [options.os] - Operating System (defaults to current) (`windows`/`mac`/`linux`/`solaris`/`aix`)
 * @param {string} [options.arch] - Architecture (defaults to current) (`x64`/`x32`/`ppc64`/`s390x`/`ppc64le`/`aarch64`/`sparcv9`)
 * @param {string} [options.openjdk_impl = hotspot] - OpenJDK Implementation (`hotspot`)
 * @param {string} [options.release = latest] - Exact release name (e.g. `jdk-21+34-ea-beta`), or `latest` for the latest GA build of `version`
 * @param {string} [options.type = jre] - Binary Type (`jre`/`jdk`)
 * @param {string} [options.heap_size = normal] - Heap Size (`normal`/`large`)
 * @param {string} [options.vendor = eclipse] - JRE/JDK vendor (`eclipse`/`adoptopenjdk`). Both resolve to api.adoptium.net (Eclipse Temurin); the deprecated api.adoptopenjdk.net host is no longer used.
 * @param {string} [options.installPath] - File or directory path whose parent directory receives the `jre` folder (defaults to the main module path, or process.cwd()). The parent directory must exist.
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
 * njre.install(21, { type: 'jdk', installPath: '/opt/my-app' })
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

  // Java 8 is not published for macOS by the API: fall back to Java 11 there.
  // This depends on the TARGET os (options.os, defaulted above from the current
  // platform), not on the host running njre: installing a Linux JRE 8 from a
  // Mac must still give Java 8.
  if (options.os === "mac") {
    if (version === 8) {
      version = 11;
    }
    // Block if user tries impossible combination
    if (options.release === "8") {
      throw new Error("Java 8 is not available in darwin platform (Mac)");
    }
  }

  const versionPath =
    options.release === "latest"
      ? "latest/" + version + "/ga"
      : "version/" + options.release;

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
  const binaryUrl = await resolveBinaryUrl(url);
  if (!binaryUrl) {
    throw new Error(`[njre] No binary found for ${url}`);
  }
  const file = await downloadAll(tmpdir, binaryUrl);
  await verify(file);
  const movedFile = await move(file, installPath);
  return extract(movedFile);
}

module.exports = install;
