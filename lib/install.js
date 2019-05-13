'use strict'

const path = require('path')
const fs = require('fs)')
const os = require('os')
const fetch = require('node-fetch')

function download (dir, url) {
  return new Promise((res, rej) => {
    fetch(url)
      .then(response => {
        const destFile = path.join(dir, url.split('/').slice(-1)[0])
        const destStream = fs.createWriteStream(destFile)
        destStream.on('finish', res(destFile))
        response.body.pipe(destStream)
      })
      .catch(err => rej(err))
  })
}

function verify (path) {

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
  return new Promise((res, rej) => {
    fetch(url)
      .then(response => response.json())
      .then(json => download(tmpdir, json.binaries[0]['binary_link']))
      .then()
      .catch(err => rej(err))
  })
}

module.exports = install
