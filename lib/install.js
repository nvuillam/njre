'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const fetch = require('node-fetch')
const yauzl = require('yauzl')
const tar = require('tar')

function createDir (dir) {
  return new Promise((resolve, reject) => {
    fs.access(dir, err => {
      if (err && err.code === 'ENOENT') {
        fs.mkdir(dir, err => {
          if (err) reject(err)
          resolve()
        })
      } else if (!err) resolve()
      else reject(err)
    })
  })
}

function download (dir, url) {
  return new Promise((resolve, reject) => {
    createDir(dir)
      .then(() => fetch(url))
      .then(response => {
        const destFile = path.join(dir, path.basename(url))
        const destStream = fs.createWriteStream(destFile)
        response.body.pipe(destStream).on('finish', () => resolve(destFile))
      })
      .catch(err => reject(err))
  })
}

function downloadAll (dir, url) {
  return download(dir, url + '.sha256.txt').then(() => download(dir, url))
}

function genChecksum (file) {
  return new Promise((resolve, reject) => {
    fs.readFile(file, (err, data) => {
      if (err) reject(err)

      resolve(
        crypto
          .createHash('sha256')
          .update(data)
          .digest('hex')
      )
    })
  })
}

function verify (file) {
  return new Promise((resolve, reject) => {
    fs.readFile(file + '.sha256.txt', 'utf-8', (err, data) => {
      if (err) reject(err)

      genChecksum(file).then(checksum => {
        checksum === data.split('  ')[0]
          ? resolve(file)
          : reject(new Error('File and checksum don\'t match'))
      })
    })
  })
}

function move (file) {
  return new Promise((resolve, reject) => {
    const newFile = path.join(path.dirname(require.main.filename), file.split(path.sep).slice(-1)[0])

    fs.copyFile(file, newFile, err => {
      if (err) reject(err)

      fs.unlink(file, err => {
        if (err) reject(err)
        resolve(newFile)
      })
    })
  })
}

function extractZip (file, dir) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zipFile) => {
      if (err) reject(err)

      zipFile.readEntry()
      zipFile.on('entry', entry => {
        const entryPath = path.join(dir, entry.fileName)

        if (/\/$/.test(entry.fileName)) {
          fs.mkdir(entryPath, { recursive: true }, err => {
            if (err && err.code !== 'EEXIST') reject(err)

            zipFile.readEntry()
          })
        } else {
          zipFile.openReadStream(entry, (err, readStream) => {
            if (err) reject(err)

            readStream.on('end', () => {
              zipFile.readEntry()
            })
            readStream.pipe(fs.createWriteStream(entryPath))
          })
        }
      })
      zipFile.once('close', () => {
        fs.unlink(file, err => {
          if (err) reject(err)
          resolve(dir)
        })
      })
    })
  })
}

function extractTarGz (file, dir) {
  return tar.x({ file: file, cwd: dir }).then(() => {
    return new Promise((resolve, reject) => {
      fs.unlink(file, err => {
        if (err) reject(err)
        resolve()
      })
    })
  })
}

function extract (file) {
  const dir = path.join(path.dirname(file), 'jre')

  return createDir(dir).then(() => {
    return path.extname(file) === '.zip'
      ? extractZip(file, dir)
      : extractTarGz(file, dir)
  })
}

function install (version = 8, options = {}) {
  const { openjdk_impl = 'hotspot', release = 'latest', type = 'jre' } = options
  options = { ...options, openjdk_impl, release, type }
  let url = 'https://api.adoptopenjdk.net/v2/info/releases/openjdk' + version + '?'

  if (!options.os) {
    switch (process.platform) {
      case 'aix':
        options.os = 'aix'
        break
      case 'darwin':
        options.os = 'mac'
        break
      case 'linux':
        options.os = 'linux'
        break
      case 'sunos':
        options.os = 'solaris'
        break
      case 'win32':
        options.os = 'windows'
        break
      default:
        return Promise.reject(new Error('Unsupported operating system'))
    }
  }
  if (!options.arch) {
    if (/^ppc64|s390x|x32|x64$/g.test(process.arch)) options.arch = process.arch
    else return Promise.reject(new Error('Unsupported architecture'))
  }

  Object.keys(options).forEach(key => { url += key + '=' + options[key] + '&' })

  const tmpdir = path.join(os.tmpdir(), 'njre')

  return fetch(url)
    .then(response => response.json())
    .then(json => downloadAll(tmpdir, json.binaries[0]['binary_link']))
    .then(verify)
    .then(move)
    .then(extract)
}

module.exports = install
