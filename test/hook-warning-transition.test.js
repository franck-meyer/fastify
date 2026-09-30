'use strict'

const { test } = require('node:test')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { request } = require('node:http')
const Fastify = require('../')

const execFileAsync = promisify(execFile)

test('warnings identify every route and hook, including generated HEAD hooks', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  const app = Fastify()
  t.after(() => app.close())
  const calls = []
  const onRequest = async (request, reply, done) => { calls.push(request.method) }
  app.get('/first', { onRequest }, async () => 'ok')
  app.post('/second', {
    onRequest,
    preHandler: async (request, reply, done) => {}
  }, async () => 'ok')

  const warnings = warning.mock.calls.map(call => call.arguments[0])
  t.assert.strictEqual(warnings.length, 4)
  for (const fragment of [
    'onRequest hook for GET /first',
    'onRequest hook for HEAD /first',
    'onRequest hook for POST /second',
    'preHandler hook for POST /second'
  ]) {
    t.assert.ok(warnings.some(message => message.includes(fragment)))
  }
  for (const [method, url] of [['GET', '/first'], ['HEAD', '/first'], ['POST', '/second']]) {
    const response = await app.inject({ method, url })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.payload, method === 'HEAD' ? '' : 'ok')
  }
  t.assert.deepStrictEqual(calls, ['GET', 'HEAD', 'POST'])
  t.assert.strictEqual(warning.mock.callCount(), 4, 'no request-time warnings')
})

test('onRoute hooks that change only generated HEAD routes still produce diagnostics', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  const app = Fastify()
  t.after(() => app.close())
  app.addHook('onRoute', opts => {
    if (opts.method === 'HEAD') opts.preHandler = async (request, reply, done) => {}
  })
  app.get('/', async () => 'ok')
  t.assert.strictEqual(warning.mock.callCount(), 1)
  t.assert.match(warning.mock.calls[0].arguments[0], /preHandler hook for HEAD \//)
  t.assert.strictEqual((await app.inject({ method: 'HEAD', url: '/' })).statusCode, 200)
})

test('diagnostics do not execute custom single-hook metadata getters', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  const app = Fastify()
  t.after(() => app.close())
  let lengthReads = 0
  const hook = async (request, reply, done) => {}
  Object.defineProperty(hook, 'constructor', {
    get () { throw new Error('must not read constructor') }
  })
  const lengthHook = async (request, reply, done) => {}
  Object.defineProperty(lengthHook, 'length', {
    get () { lengthReads++; return 3 }
  })
  app.post('/', { onRequest: hook }, async () => 'ok')
  app.post('/length', { onRequest: lengthHook }, async () => 'ok')
  t.assert.strictEqual(lengthReads, 0, 'registration does not inspect the getter')
  t.assert.strictEqual(warning.mock.callCount(), 0)
  for (const url of ['/', '/length']) {
    const response = await app.inject({ method: 'POST', url })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.payload, 'ok')
  }
})

test('diagnostics skip proxy traps and tolerate missing constructor metadata', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  const app = Fastify()
  t.after(() => app.close())
  let reads = 0
  const hook = new Proxy(async (request, reply, done) => {}, {
    get (target, key, receiver) { reads++; return Reflect.get(target, key, receiver) }
  })
  const withoutConstructor = async (request, reply, done) => {}
  Object.defineProperty(withoutConstructor, 'constructor', { value: null })
  app.post('/proxy', { onRequest: hook }, async () => 'ok')
  app.post('/missing', { onRequest: withoutConstructor }, async () => 'ok')
  t.assert.strictEqual(reads, 0)
  t.assert.strictEqual(warning.mock.callCount(), 0)
  for (const url of ['/proxy', '/missing']) {
    t.assert.strictEqual((await app.inject({ method: 'POST', url })).statusCode, 200)
  }
})

test('bound async hooks warn while promise-returning callbacks remain silent', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  const app = Fastify()
  t.after(() => app.close())
  const context = {}
  async function hook (request, reply, done) { t.assert.strictEqual(this, context) }
  app.post('/bound', { onRequest: hook.bind(context) }, async () => 'ok')
  app.post('/promise', { onRequest: (request, reply, done) => Promise.resolve() }, async () => 'ok')
  for (const url of ['/bound', '/promise']) {
    t.assert.strictEqual((await app.inject({ method: 'POST', url })).statusCode, 200)
  }
  t.assert.strictEqual(warning.mock.callCount(), 1)
  t.assert.match(warning.mock.calls[0].arguments[0], /onRequest hook for POST \/bound/)
})

test('warning transition is non-fatal under Node flags and supports an explicit CI gate', async t => {
  for (const flags of [[], ['--throw-deprecation'], ['--no-warnings']]) {
    const source = `
      const assert = require('node:assert/strict')
      const app = require(${JSON.stringify(require.resolve('../'))})()
      let warnings = 0
      process.on('warning', warning => {
        assert.equal(warning.code, 'FSTDEP023')
        assert.equal(warning.name, 'FastifyWarning')
        warnings++
      })
      app.post('/', { preHandler: async (request, reply, done) => {} }, async () => 'ok')
      app.inject({ method: 'POST', url: '/' }).then(async response => {
        assert.equal(response.statusCode, 200)
        assert.equal(response.payload, 'ok')
        await app.close()
        setImmediate(() => { assert.equal(warnings, 1); console.log('completed') })
      }).catch(error => { console.error(error); process.exitCode = 1 })
    `
    const result = await execFileAsync(process.execPath, [...flags, '-e', source])
    t.assert.match(result.stdout, /completed/)
    if (flags.includes('--no-warnings')) t.assert.strictEqual(result.stderr, '')
    else t.assert.match(result.stderr, /\[FSTDEP023\] FastifyWarning/)
  }

  const source = `
    process.on('warning', warning => {
      if (warning.code === 'FSTDEP023') process.exitCode = 1
    })
    const app = require(${JSON.stringify(require.resolve('../'))})()
    app.post('/', { preHandler: async (request, reply, done) => {} }, async () => 'ok')
    app.ready().then(() => app.close())
  `
  await t.assert.rejects(execFileAsync(process.execPath, ['-e', source]), { code: 1 })
})

for (const asArray of [false, true]) {
  test(`zero-argument abort hooks execute in order on client disconnect (array: ${asArray})`, { timeout: 10000 }, async t => {
    const warning = t.mock.method(process, 'emitWarning', () => {})
    const app = Fastify()
    t.after(() => app.close())
    const calls = []
    let requestStarted
    const started = new Promise(resolve => { requestStarted = resolve })
    let hooksFinished
    const finished = new Promise(resolve => { hooksFinished = resolve })
    app.addHook('onRequest', (request, reply, done) => { requestStarted(); done() })
    app.addHook('onRequestAbort', async function () {
      await Promise.resolve()
      calls.push('root')
    })
    let childInstance
    app.register(async child => {
      childInstance = child
      child.addHook('onRequestAbort', async function (request) {
        calls.push(['child', this === child, request.raw.aborted])
      })
      const hook = async function () {
        await Promise.resolve()
        calls.push(['route', this === childInstance])
        hooksFinished()
      }
      child.post('/upload', { onRequestAbort: asArray ? [hook] : hook }, async () => 'ok')
    })
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const client = request(`${address}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': '100' }
    })
    t.after(() => client.destroy())
    client.on('error', error => t.assert.strictEqual(error.code, 'ECONNRESET'))
    client.write('partial')
    await started
    client.destroy()
    await finished
    t.assert.deepStrictEqual(calls, ['root', ['child', true, true], ['route', true]])
    t.assert.strictEqual(warning.mock.callCount(), 0)
  })
}
