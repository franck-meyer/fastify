'use strict'

const { createHash } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')

const [rootArg, baselineArg, candidateArg] = process.argv.slice(2)
const root = resolve(rootArg)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const dependencies = JSON.parse(readFileSync(join(__dirname, 'package.json')))
const roles = { baseline: resolve(baselineArg), candidate: resolve(candidateArg) }
const packed = {}
mkdirSync(root, { recursive: true })
for (const [role, source] of Object.entries(roles)) {
  const directory = join(root, role)
  mkdirSync(directory, { recursive: true })
  const packages = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
    cwd: source, encoding: 'utf8'
  }))
  packed[role] = packages[0]
  const data = { ...dependencies, dependencies: { ...dependencies.dependencies, fastify: `file:./${packages[0].filename}` } }
  writeFileSync(join(directory, 'package.json'), JSON.stringify(data, null, 2) + '\n')
}
execFileSync(npm, ['install', '--ignore-scripts'], { cwd: join(root, 'candidate'), stdio: 'inherit' })
const lock = JSON.parse(readFileSync(join(root, 'candidate', 'package-lock.json')))
const baselineTar = readFileSync(join(root, 'baseline', packed.baseline.filename))
lock.packages['node_modules/fastify'].integrity = 'sha512-' + createHash('sha512').update(baselineTar).digest('base64')
lock.packages['node_modules/fastify'].resolved = `file:${packed.baseline.filename}`
lock.packages[''].dependencies.fastify = `file:./${packed.baseline.filename}`
writeFileSync(join(root, 'baseline', 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
execFileSync(npm, ['ci', '--ignore-scripts'], { cwd: join(root, 'baseline'), stdio: 'inherit' })
writeFileSync(join(root, 'packages.json'), JSON.stringify(packed, null, 2) + '\n')
console.log('Installed both Fastify tarballs with matching plugin and transitive dependency versions.')
