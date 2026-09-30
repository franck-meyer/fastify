'use strict'

const { createRequire } = require('node:module')
const { join } = require('node:path')
const { Writable } = require('node:stream')
const { performance } = require('node:perf_hooks')

async function main () {
  const [directory, count, style, policy] = process.argv.slice(2)
  const load = createRequire(join(directory, 'package.json'))
  const Fastify = load('fastify')
  const start = performance.now()
  let warnings = 0
  let logBytes = 0
  const app = Fastify({
    logger: { stream: new Writable({ write (chunk, encoding, callback) { logBytes += chunk.length; callback() } }) }
  })
  process.on('warning', warning => {
    if (warning.code === 'FSTDEP023') warnings++
    if (policy === 'throw-all') throw warning
    if (policy === 'ci' && warning.code === 'FSTDEP023') process.exitCode = 1
    if (policy === 'allow-hook' && warning.code !== 'FSTDEP023') throw warning
    if (policy === 'log' || policy === 'allow-hook') app.log.warn({ code: warning.code }, warning.message)
  })
  const hook = style === 'legacy'
    ? async function (request, reply, done) {}
    : async function (request, reply) {}
  for (let i = 0; i < Number(count); i++) {
    // Every GET also registers HEAD, so there should be two warnings per GET.
    app.get(`/route-${i}`, { preHandler: hook }, async () => 'ok')
  }
  await app.ready()
  await new Promise(resolve => setImmediate(resolve))
  const bootMs = performance.now() - start
  const warningsAtBoot = warnings
  for (let i = 0; i < 10; i++) {
    const response = await app.inject('/route-0')
    if (response.statusCode !== 200 || response.payload !== 'ok') throw new Error('Request failed')
  }
  await app.close()
  await new Promise(resolve => setImmediate(resolve))
  console.log(JSON.stringify({ bootMs, warningsAtBoot, warningsAfterRequests: warnings, logBytes }))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
