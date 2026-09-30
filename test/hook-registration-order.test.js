'use strict'

const { test } = require('node:test')
const Fastify = require('../')
const { lifecycleHooks } = require('../lib/hooks')
const { kHooks } = require('../lib/symbols')

for (const name of lifecycleHooks) {
  test(`${name} registration is deferred and propagates to existing descendants`, async t => {
    const app = Fastify()
    t.after(() => app.close())
    const early = () => {}
    const local = () => {}
    const late = () => {}
    let child
    let nested
    let sibling

    app.addHook(name, early)
    t.assert.deepStrictEqual(app[kHooks][name], [])
    app.register(async function (instance) {
      child = instance
      t.assert.deepStrictEqual(child[kHooks][name], [early])
      child.addHook(name, local)
      t.assert.deepStrictEqual(child[kHooks][name], [early])
      child.register(async function (instance) { nested = instance })
    })
    app.register(async function (instance) { sibling = instance })
    app.addHook(name, late)

    await app.ready()
    t.assert.deepStrictEqual(app[kHooks][name], [early, late])
    t.assert.deepStrictEqual(child[kHooks][name], [early, local, late])
    t.assert.deepStrictEqual(nested[kHooks][name], [early, local, late])
    t.assert.deepStrictEqual(sibling[kHooks][name], [early, late])
  })
}

test('propagated request hooks retain order and bind to the route or 404 owner', async t => {
  const app = Fastify()
  t.after(() => app.close())
  app.decorate('scope', 'root')
  const calls = []

  function hook (label) {
    return function (request, reply, done) {
      t.assert.strictEqual(this, request.server)
      calls.push(`${label}:${this.scope}`)
      done()
    }
  }

  app.addHook('onRequest', hook('early'))
  app.get('/', { onRequest: hook('route') }, async () => 'ok')
  app.register(async function (child) {
    child.decorate('scope', 'child')
    child.addHook('onRequest', hook('local'))
    child.setNotFoundHandler((request, reply) => reply.code(404).send('missing'))
    child.get('/', { onRequest: hook('route') }, async () => 'ok')
    child.register(async function (nested) {
      nested.decorate('scope', 'nested')
      nested.get('/', { onRequest: hook('route') }, async () => 'ok')
    }, { prefix: '/nested' })
  }, { prefix: '/child' })
  app.register(async function (sibling) {
    sibling.decorate('scope', 'sibling')
    sibling.get('/', { onRequest: hook('route') }, async () => 'ok')
  }, { prefix: '/sibling' })
  app.addHook('onRequest', hook('late'))

  for (const [url, scope, labels, status] of [
    ['/', 'root', ['early', 'late', 'route'], 200],
    ['/child/', 'child', ['early', 'local', 'late', 'route'], 200],
    ['/child/nested/', 'nested', ['early', 'local', 'late', 'route'], 200],
    ['/sibling/', 'sibling', ['early', 'late', 'route'], 200],
    ['/child/missing', 'child', ['early', 'local', 'late'], 404],
    ['/sibling/missing', 'root', ['early', 'late'], 404]
  ]) {
    calls.length = 0
    const response = await app.inject(url)
    t.assert.strictEqual(response.statusCode, status)
    t.assert.deepStrictEqual(calls, labels.map(label => `${label}:${scope}`))
  }
})

test('onRoute registration is immediate and only inherited by subsequently created children', async t => {
  const app = Fastify({ exposeHeadRoutes: false })
  t.after(() => app.close())
  const calls = []
  let child
  const early = function (route) { calls.push(['early', this, route.url]) }
  const late = function (route) { calls.push(['late', this, route.url]) }
  app.addHook('onRoute', early)
  t.assert.deepStrictEqual(app[kHooks].onRoute, [early])
  app.get('/', async () => 'ok')
  t.assert.deepStrictEqual(calls, [['early', app, '/']])

  app.register(async function (instance) {
    child = instance
    app.addHook('onRoute', late)
    t.assert.deepStrictEqual(app[kHooks].onRoute, [early, late])
    t.assert.deepStrictEqual(child[kHooks].onRoute, [early])
    child.get('/child', async () => 'ok')
    child.register(async function (nested) {
      nested.get('/nested', async () => 'ok')
      t.assert.deepStrictEqual(calls.at(-1), ['early', nested, '/nested'])
    })
  })
  app.register(async function (sibling) {
    sibling.get('/sibling', async () => 'ok')
    t.assert.deepStrictEqual(calls.slice(-2), [
      ['early', sibling, '/sibling'], ['late', sibling, '/sibling']
    ])
  })
  await app.ready()
  t.assert.deepStrictEqual(calls[1], ['early', child, '/child'])
  t.assert.strictEqual(calls.length, 5)
})

test('onRegister retains deferred registration, parent binding, and child creation order', async t => {
  const app = Fastify()
  t.after(() => app.close())
  const calls = []
  let child
  let nested
  let sibling
  const early = function (instance) { calls.push(['early', this, instance]) }
  const local = function (instance) { calls.push(['local', this, instance]) }
  const late = function (instance) { calls.push(['late', this, instance]) }
  app.addHook('onRegister', early)
  t.assert.deepStrictEqual(app[kHooks].onRegister, [])
  app.register(async function (instance) {
    child = instance
    child.addHook('onRegister', local)
    child.register(async function (instance) { nested = instance })
  })
  app.addHook('onRegister', late)
  app.register(async function (instance) { sibling = instance })

  await app.ready()
  t.assert.deepStrictEqual(calls, [
    ['early', app, child],
    ['early', child, nested], ['local', child, nested],
    ['early', app, sibling], ['late', app, sibling]
  ])
  t.assert.deepStrictEqual(nested[kHooks].onRegister, [early, local, late])
})

for (const name of ['onReady', 'onListen']) {
  test(`${name} registration is immediate, local, and traverses children once`, async t => {
    const app = Fastify()
    t.after(() => app.close())
    const calls = []
    let child
    let nested
    let sibling
    const early = function () { calls.push(['early', this]) }
    const late = function () { calls.push(['late', this]) }
    const local = function () { calls.push(['local', this]) }
    app.addHook(name, early)
    t.assert.deepStrictEqual(app[kHooks][name], [early])
    app.register(async function (instance) {
      child = instance
      t.assert.deepStrictEqual(child[kHooks][name], [])
      app.addHook(name, late)
      child.addHook(name, local)
      t.assert.deepStrictEqual(child[kHooks][name], [local])
      child.register(async function (instance) {
        nested = instance
        t.assert.deepStrictEqual(nested[kHooks][name], [])
        nested.addHook(name, local)
      })
    })
    app.register(async function (instance) {
      sibling = instance
      t.assert.deepStrictEqual(sibling[kHooks][name], [])
      sibling.addHook(name, local)
    })

    if (name === 'onListen') {
      await app.listen({ port: 0, host: '127.0.0.1' })
    } else {
      await app.ready()
    }
    t.assert.deepStrictEqual(calls, [
      ['early', app], ['late', app], ['local', child], ['local', nested], ['local', sibling]
    ])
  })
}

test('preClose propagation and Avvio onClose ownership retain shutdown order', async t => {
  const app = Fastify()
  t.after(() => app.close())
  const calls = []
  let child
  let nested
  let sibling
  const early = function (done) { calls.push(['early', this]); done() }
  const late = async function () { calls.push(['late', this]) }
  const local = async function () { calls.push(['local', this]) }
  const close = function (instance, done) {
    t.assert.strictEqual(this, instance)
    calls.push(['close', this])
    done()
  }
  app.addHook('preClose', early)
  app.addHook('onClose', close)
  app.register(async function (instance) {
    child = instance
    t.assert.deepStrictEqual(child[kHooks].preClose, [])
    child.addHook('preClose', local)
    child.addHook('onClose', close)
    child.register(async function (instance) {
      nested = instance
      t.assert.deepStrictEqual(nested[kHooks].preClose, [])
      nested.addHook('onClose', close)
    })
  })
  app.register(async function (instance) {
    sibling = instance
    sibling.addHook('onClose', close)
  })
  app.addHook('preClose', late)
  await app.ready()
  t.assert.deepStrictEqual(app[kHooks].preClose, [early, late])
  t.assert.deepStrictEqual(child[kHooks].preClose, [local, late])
  t.assert.deepStrictEqual(nested[kHooks].preClose, [late])
  t.assert.deepStrictEqual(sibling[kHooks].preClose, [late])
  t.assert.strictEqual(Object.hasOwn(app[kHooks], 'onClose'), false)

  await app.close()
  t.assert.deepStrictEqual(calls, [
    ['early', app], ['late', app], ['local', child], ['late', child],
    ['late', nested], ['late', sibling],
    ['close', sibling], ['close', nested], ['close', child], ['close', app]
  ])
})

test('registration preserves boot errors and prioritizes hook registration errors', async t => {
  for (const fn of [() => {}, 42]) {
    const app = Fastify()
    const bootError = new Error('plugin failed')
    app.register(function (instance, opts, done) { done(bootError) })
    t.assert.strictEqual(app.addHook('onRequest', fn), app)
    await t.assert.rejects(app.ready(), typeof fn === 'function'
      ? bootError
      : { code: 'FST_ERR_HOOK_INVALID_HANDLER' })
  }
})

test('all registration policies reject addHook after listening before validating its arguments', async t => {
  const app = Fastify()
  t.after(() => app.close())
  await app.listen({ port: 0, host: '127.0.0.1' })
  for (const name of ['onRequest', 'onRoute', 'onReady', 'onListen', 'preClose', 'onClose', 'unknown']) {
    t.assert.throws(() => app.addHook(name, null), { code: 'FST_ERR_INSTANCE_ALREADY_LISTENING' })
  }
})
