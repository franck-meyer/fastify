'use strict'

const assert = require('node:assert/strict')
const { fork, spawn } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const { writeFile } = require('node:fs/promises')
const { request } = require('node:http')
const { createRequire } = require('node:module')
const { join, resolve } = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')

const [directoryArg, role, outputArg, durationArg = '20', roundsArg = '3'] = process.argv.slice(2)
const directory = resolve(directoryArg)
const output = resolve(outputArg)
const load = createRequire(join(directory, 'package.json'))
const autocannon = load('autocannon')
const WebSocket = load('ws')
const duration = Number(durationArg)
const rounds = Number(roundsArg)
const result = { role, node: process.version, platform: process.platform, smoke: [], warnings: [], load: [] }

function waitFor (events, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.removeListener(event, listener); reject(new Error(`Timeout: ${event}`)) }, 15000)
    function listener (message) {
      if (!predicate(message)) return
      clearTimeout(timer)
      events.removeListener(event, listener)
      resolve(message)
    }
    events.on(event, listener)
  })
}

async function start (profile) {
  const events = new EventEmitter()
  events.setMaxListeners(100)
  const child = fork(join(__dirname, 'server.js'), [directory, JSON.stringify(profile)], {
    execArgv: ['--expose-gc'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536) })
  child.stdout.resume()
  child.on('message', message => events.emit(message.event, message))
  const exit = once(child, 'exit')
  const ready = await Promise.race([
    waitFor(events, 'ready'),
    exit.then(([code]) => { throw new Error(`Server exited (${code}): ${stderr}`) })
  ])
  let sequence = 0
  return {
    address: ready.address,
    events,
    async metrics () {
      const id = sequence++
      const response = waitFor(events, 'metrics', message => message.id === id)
      child.send({ command: 'metrics', id })
      return (await response).metrics
    },
    async close () {
      const closed = waitFor(events, 'closed')
      child.send({ command: 'close' })
      const timer = setTimeout(() => child.kill(), 10000)
      try {
        const message = await closed
        const [code] = await exit
        assert.equal(code, 0, stderr)
        assert.equal(message.metrics.sockets, 0)
        assert.equal(message.metrics.websockets, 0)
        assert.equal(message.metrics.activeUploads, 0)
        return message.metrics
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill()
      }
    }
  }
}

async function http (server, path, options = {}) {
  const response = await fetch(server.address + path, {
    ...options,
    headers: { connection: 'close', origin: 'https://fixture.example', ...options.headers }
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text, json: text && JSON.parse(text) }
}

async function session (server) {
  const response = await http(server, '/session')
  assert.equal(response.status, 200)
  return {
    authorization: `Bearer ${response.json.token}`,
    cookie: response.headers.get('set-cookie').split(';')[0]
  }
}

async function abortWave (server, count, prefix) {
  for (let offset = 0; offset < count; offset += 10) {
    await Promise.all(Array.from({ length: Math.min(10, count - offset) }, async (_, index) => {
      const id = `${prefix}-${offset + index}`
      const started = waitFor(server.events, 'upload-started', message => message.id === id)
      const cleaned = waitFor(server.events, 'abort-cleaned', message => message.id === id)
      const client = request(server.address + '/upload/raw', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '1048576', 'x-validation-abort': id }
      })
      const errors = []
      client.on('error', error => { if (error.code !== 'ECONNRESET') errors.push(error) })
      client.write('{"data":"partial')
      await started
      client.destroy()
      await cleaned
      assert.deepEqual(errors, [])
    }))
  }
  await sleep(50)
  const metrics = await server.metrics()
  assert.equal(metrics.activeUploads, 0)
  assert.equal(metrics.rootAborts, metrics.routeAborts)
  assert.equal(metrics.cleanupErrors, 0)
}

async function websocketWave (server, connections = 5, messages = 10) {
  await Promise.all(Array.from({ length: connections }, async (_, id) => {
    const socket = new WebSocket(server.address.replace('http:', 'ws:') + '/events')
    await once(socket, 'open')
    for (let index = 0; index < messages; index++) {
      const received = once(socket, 'message')
      socket.send(`${id}:${index}`)
      assert.equal((await received)[0].toString(), `${id}:${index}`)
    }
    const closed = once(socket, 'close')
    socket.close()
    await closed
  }))
}

async function smoke (profile) {
  const server = await start(profile)
  const record = { profile }
  result.smoke.push(record)
  try {
    const headers = await session(server)
    const get = await http(server, '/v1/items/smoke', { headers })
    assert.equal(get.status, 200)
    assert.deepEqual(get.json, { id: 'smoke', user: 'sample-user', cookie: true })
    assert.equal(get.headers.get('access-control-allow-origin'), 'https://fixture.example')
    const head = await http(server, '/v1/items/smoke', { method: 'HEAD', headers })
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(get.text)))
    assert.equal((await http(server, '/v1/items/smoke')).status, 401)
    const post = await http(server, '/v1/items', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"id":"created"}'
    })
    assert.equal(post.status, 201)
    assert.deepEqual(post.json, { id: 'created', transformed: true })
    assert.equal((await http(server, '/v1/items', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}'
    })).status, 400)
    assert.deepEqual((await http(server, '/v1/callback')).json, { callback: true })
    assert.deepEqual((await http(server, '/auto/nested')).json, { tenant: 'sample' })
    assert.equal((await http(server, '/feature/enabled')).status, profile.conditional ? 200 : 404)
    const docs = await http(server, '/documentation/json')
    assert.equal(docs.status, 200)
    assert.ok(docs.json.paths['/v1/items/{id}'].get)
    const form = new FormData()
    form.append('file', new Blob(['sample-upload']), 'sample.txt')
    const upload = await http(server, '/upload/file', { method: 'POST', body: form })
    assert.equal(upload.status, 200)
    assert.deepEqual(upload.json, { bytes: 13, filename: 'sample.txt' })
    const before = await server.metrics()
    await Promise.all([abortWave(server, 20, 'smoke'), websocketWave(server)])
    const after = await server.metrics()
    assert.equal(after.rootAborts, 20)
    assert.equal(after.routeAborts, 20)
    assert.equal(after.websocketMessages, 50)
    assert.equal(after.duplicates, 0)
    assert.equal(after.warnings, before.warnings)
    assert.equal(after.errorLogs, 0)
    if (role === 'candidate' && profile.legacy) assert.ok(after.warnings > 0)
    else assert.equal(after.warnings, 0)
    record.metrics = after
  } finally {
    const closed = await server.close()
    record.closedResources = closed.resources
  }
}

function traffic (server, headers, seconds) {
  return new Promise((resolve, reject) => {
    autocannon({
      url: server.address,
      connections: 25,
      duration: seconds,
      headers: { ...headers, origin: 'https://fixture.example' },
      requests: [
        { method: 'GET', path: '/v1/items/load' },
        { method: 'POST', path: '/v1/items', headers: { 'content-type': 'application/json' }, body: '{"id":"load"}' }
      ]
    }, (error, stats) => error ? reject(error) : resolve(stats))
  })
}

async function loadTest () {
  const server = await start({ legacy: true, conditional: true, omitAbortRequest: role === 'candidate' })
  try {
    const headers = await session(server)
    await traffic(server, headers, 3)
    result.beforeLoad = await server.metrics()
    for (let round = 0; round < rounds; round++) {
      const [stats] = await Promise.all([
        traffic(server, headers, duration),
        abortWave(server, 100, `load-${round}`),
        websocketWave(server, 10, 50)
      ])
      const metrics = await server.metrics()
      assert.equal(stats.errors, 0)
      assert.equal(stats.timeouts, 0)
      assert.equal(stats.non2xx, 0)
      assert.equal(metrics.duplicates, 0)
      assert.equal(metrics.errorLogs, 0)
      assert.equal(metrics.rootAborts, (round + 1) * 100)
      assert.equal(metrics.routeAborts, (round + 1) * 100)
      assert.equal(metrics.activeUploads, 0)
      assert.equal(metrics.websockets, 0)
      assert.equal(metrics.warnings, result.beforeLoad.warnings)
      result.load.push({
        round,
        duration: stats.duration,
        requests: stats.requests.total,
        requestsPerSecond: stats.requests.average,
        latency: { average: stats.latency.average, p99: stats.latency.p99, max: stats.latency.max },
        errors: stats.errors,
        timeouts: stats.timeouts,
        non2xx: stats.non2xx,
        metrics
      })
      console.error(`${role}: load round ${round + 1}/${rounds}, ${stats.requests.total} requests, zero errors`)
    }
  } finally {
    result.afterClose = await server.close()
  }
}

async function warningCase (count, style, policy, flags = []) {
  const child = spawn(process.execPath, [...flags, join(__dirname, 'warnings.js'), directory, String(count), style, policy], {
    env: { ...process.env, NODE_NO_WARNINGS: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const [code] = await once(child, 'close')
  const warns = role === 'candidate' && style === 'legacy'
  const fatal = warns && ['throw-all', 'ci'].includes(policy)
  assert.equal(code, fatal ? 1 : 0, stderr.slice(-1000))
  const metrics = stdout.trim() ? JSON.parse(stdout.trim()) : null
  if (metrics) {
    assert.equal(metrics.warningsAtBoot, warns ? count * 2 : 0)
    assert.equal(metrics.warningsAfterRequests, metrics.warningsAtBoot)
  }
  if (warns && policy === 'throw-all') assert.match(stderr, /FSTDEP023/)
  result.warnings.push({ count, style, policy, flags, exitCode: code, stderrBytes: Buffer.byteLength(stderr), metrics })
}

async function main () {
  for (const profile of [
    { legacy: true, conditional: true, omitAbortRequest: role === 'candidate' },
    { legacy: true, conditional: false, omitAbortRequest: false },
    { legacy: false, conditional: true, omitAbortRequest: role === 'candidate' }
  ]) await smoke(profile)
  for (const policy of ['default', 'log', 'throw-all', 'allow-hook', 'ci']) {
    await warningCase(20, 'legacy', policy)
    await warningCase(20, 'corrected', policy)
  }
  await warningCase(20, 'legacy', 'default', ['--throw-deprecation'])
  for (const count of [500, 2000]) {
    for (let round = 0; round < 3; round++) {
      await warningCase(count, 'legacy', 'log')
      await warningCase(count, 'corrected', 'log')
    }
  }
  await loadTest()
  result.success = true
}

main().catch(error => {
  result.success = false
  result.error = error.stack
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
})
