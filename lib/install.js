'use strict'

const path = require('path')
const fs = require('fs)')
const os = require('os')
const crypto = require('crypto')
const fetch = require('node-fetch')
const yauzl = require('yauzl')
const tar = require('tar')

function createDir (dir) {
  return new Promise((res, rej) => {
    fs.access(dir, err => {
      if (err && error.code === 'ENOENT') {
        fs.mkdir(dir, err => {
          if (err) rej(err)
          res()
        })
      } else if (!err) res()
      else rej(err)
    })
  })
}

function download (dir, url) {
  return new Promise((res, rej) => {
    createDir(dir)
      .then(fetch(url))
      .then(response => {
        const destFile = path.join(dir, path.basename(url)) // Get filename from URL
        const destStream = fs.createWriteStream(destFile)
        destStream.on('finish', res(destFile))
        response.body.pipe(destStream)
      })
      .catch(err => rej(err))
  })
}

function downloadAll (dir, url) {
  return download(dir, url + '.sha256.txt').then(() => download(dir, url))
}

function genChecksum (file) {
  return new Promise((res, rej) => {
    fs.readFile(file, (err, data) => {
      if (err) rej(err)

      res(
        crypto
          .createHash('sha256')
          .update(data)
          .digest('hex')
      )
    })
  })
}

function verify (file) {
  return new Promise((res, rej) => {
    fs.readFile(file + '.sha256.txt', (err, data) => {
      if (err) rej(err)

      genChecksum(file).then(checksum => {
        checksum === data.split('  ')[0]
          ? res(file)
          : rej(new Error('File and checksum don\'t match'))
      })
    })
  })
}

function move (file) {
  return new Promise((res, rej) => {
    const newFile = path.join(path.dirname(require.main.filename), file.split(path.sep).slice(-1)[0])

    fs.rename(file, newFile, err => {
      if (err) rej(err)
      res(newFile)
    })
  })
}

function extractZip (file, dir) {
  return new Promise((res, rej) => {
    yauzl.open(file, { lazyEntries: true }, (err, file) => {
      if (err) rej(err)

      file.readEntry()
      file.on('entry', entry => {
        const entryPath = path.join(dir, entry.fileName)

        if (/\/$/.test(entry.fileName)) {
          fs.mkdir(entryPath, { recursive: true }, err => {
            if (err && err.code !== 'EEXIST') rej(err)

            file.readEntry()
          })
        } else {
          file.openReadStream(entry, (err, readStream) => {
            if (err) rej(err)

            readStream.on('end', () => {
              file.readEntry()
            })
            readStream.pipe(fs.createWriteStream(entryPath))
          })
        }
      })
      file.once('close', () => {
        fs.unlink(file, err => {
          if (err) throw err
        })

        res(dir)
      })
    })
  })
}

function extractTarGz (file, dir) {
  return tar.x({ file: file, cwd: dir }).then(() => new Promise.resolve(dir))
}

function extract (file) {
  const dir = path.join(path.dirname(file), 'jre')

  return createDir(dir).then(() => {
    return path.extname(file) === '.zip'
      ? extractZip(file, dir)
      : extractTarGz(file, dir)
  })
}

function install (version = 8, options = { implementation: 'hotspot', release: 'latest', type: 'jre' }) {
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
  if (!options.architecture && /^ppc64|s390x|x32|x64$/g.test(process.arch)) options.architecture = process.arch
  else return Promise.reject(new Error('Unsupported architecture'))

  Object.keys(options).forEach(key => {url += options[key] + '&'})

  const tmpdir = path.join(os.tmpdir(), 'njre')
  return fetch(url)
    .then(response => response.json())
    .then(json => downloadAll(tmpdir, json.binaries[0]['binary_link']))
    .then(verify)
    .then(move)
    .then(extract)
}

module.exports = install
