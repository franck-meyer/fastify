'use strict'

const { test } = require('node:test')
const Fastify = require('../')
const { lifecycleHooks, supportedHooks } = require('../lib/hooks')

// Characterize the existing contract, including arities beyond the callback slot.
const rejectedArities = {
  onTimeout: [3],
  onRequest: [3],
  preParsing: [4],
  preValidation: [3],
  preSerialization: [4],
  preHandler: [3],
  onSend: [4],
  onResponse: [3],
  onError: [4],
  onRequestAbort: [2, 3, 4, 5],
  onRoute: [3],
  onRegister: [3],
  onReady: [1, 2, 3, 4, 5],
  onListen: [1, 2, 3, 4, 5],
  preClose: [3],
  onClose: [3]
}
const asyncHooks = [
  async () => {},
  async (a) => {},
  async (a, b) => {},
  async (a, b, c) => {},
  async (a, b, c, d) => {},
  async (a, b, c, d, e) => {}
]
const asyncError = {
  code: 'FST_ERR_HOOK_INVALID_ASYNC_HANDLER',
  message: 'Async function has too many arguments. Async hooks should not use the \'done\' argument.'
}

test('hook name lists retain their contents and order', t => {
  t.assert.deepStrictEqual(supportedHooks, Object.keys(rejectedArities))
  t.assert.deepStrictEqual(lifecycleHooks, [
    'onTimeout', 'onRequest', 'preParsing', 'preValidation', 'preSerialization',
    'preHandler', 'onSend', 'onResponse', 'onError', 'onRequestAbort'
  ])
})

for (const [name, rejected] of Object.entries(rejectedArities)) {
  test(`addHook retains async arity validation for ${name}`, t => {
    for (const [arity, fn] of asyncHooks.entries()) {
      // Registration only: some accepted signatures cannot complete at runtime.
      const app = Fastify()
      if (rejected.includes(arity)) {
        t.assert.throws(() => app.addHook(name, fn), asyncError, `arity ${arity}`)
      } else {
        t.assert.strictEqual(app.addHook(name, fn), app, `arity ${arity}`)
      }
    }
  })
}

for (const name of lifecycleHooks) {
  test(`route ${name} warns for single hooks and rejects invalid arrays`, t => {
    const warning = t.mock.method(process, 'emitWarning', () => {})
    for (const [arity, fn] of asyncHooks.entries()) {
      for (const asArray of [false, true]) {
        const app = Fastify()
        const addRoute = () => app.post('/', { [name]: asArray ? [fn] : fn }, async () => 'ok')
        const message = `${asArray ? 'array' : 'single'} arity ${arity}`
        const invalid = rejectedArities[name].includes(arity)
        warning.mock.resetCalls()
        if (invalid && asArray) {
          t.assert.throws(addRoute, asyncError, message)
          t.assert.strictEqual(app.hasRoute({ method: 'POST', url: '/' }), false)
        } else {
          t.assert.doesNotThrow(addRoute, message)
        }
        t.assert.strictEqual(warning.mock.callCount(), invalid && !asArray ? 1 : 0, message)
        if (invalid && !asArray) {
          const [text, type, code] = warning.mock.calls[0].arguments
          t.assert.strictEqual(type, 'FastifyWarning')
          t.assert.strictEqual(code, 'FSTDEP023')
          t.assert.ok(text.includes(`${name} hook for POST / has ${arity} declared parameters`))
        }
      }
    }
  })
}

test('single onSend retains legacy GET acceptance and generated HEAD array rejection', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  for (const exposeHeadRoutes of [false, true]) {
    for (const exposeHeadRoute of [undefined, false, true]) {
      const app = Fastify({ exposeHeadRoutes })
      t.after(() => app.close())
      warning.mock.resetCalls()
      const addRoute = () => app.get('/', {
        exposeHeadRoute,
        onSend: async (request, reply, payload, done) => payload + '!'
      }, async () => 'ok')
      if (exposeHeadRoute ?? exposeHeadRoutes) {
        t.assert.throws(addRoute, asyncError)
      } else {
        t.assert.doesNotThrow(addRoute)
      }
      t.assert.strictEqual(app.hasRoute({ method: 'GET', url: '/' }), true)
      t.assert.strictEqual(app.hasRoute({ method: 'HEAD', url: '/' }), false)
      t.assert.strictEqual(warning.mock.callCount(), 1)
      const response = await app.inject('/')
      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.payload, 'ok!')
      const head = await app.inject({ method: 'HEAD', url: '/' })
      t.assert.strictEqual(head.statusCode, 404)
      t.assert.strictEqual(warning.mock.callCount(), 1, 'requests do not emit warnings')
    }
  }
})

test('an existing HEAD route preserves acceptance of a single onSend hook', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  const app = Fastify()
  t.after(() => app.close())
  app.head('/', async (request, reply) => reply.code(204).send())
  app.get('/', { onSend: asyncHooks[4] }, async () => 'ok')
  t.assert.strictEqual(warning.mock.callCount(), 1)
  t.assert.strictEqual(app.hasRoute({ method: 'GET', url: '/' }), true)
  t.assert.strictEqual(app.hasRoute({ method: 'HEAD', url: '/' }), true)

  const get = await app.inject('/')
  t.assert.strictEqual(get.statusCode, 200)
  t.assert.strictEqual(get.payload, 'ok')
  const response = await app.inject({ method: 'HEAD', url: '/' })
  t.assert.strictEqual(response.statusCode, 204)
})

test('route hook validation preserves omitted hooks, empty arrays, and invalid array entries', async t => {
  const app = Fastify()
  t.after(() => app.close())
  app.post('/undefined', { onRequest: undefined }, async () => 'ok')
  app.post('/empty', { onRequest: [] }, async () => 'ok')

  for (const value of [null, false, 42, 'hook', {}, [undefined], [null], [[]], new Array(1)]) {
    t.assert.throws(() => app.post('/invalid', { onRequest: value }, async () => 'ok'), {
      code: 'FST_ERR_HOOK_INVALID_HANDLER'
    })
    t.assert.strictEqual(app.hasRoute({ method: 'POST', url: '/invalid' }), false)
  }
  for (const url of ['/undefined', '/empty']) {
    const response = await app.inject({ method: 'POST', url })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.payload, 'ok')
  }
})

test('route arrays preserve handler error precedence and element order', t => {
  for (const [hooks, code] of [
    [[null, asyncHooks[3]], 'FST_ERR_HOOK_INVALID_HANDLER'],
    [[asyncHooks[3], null], 'FST_ERR_HOOK_INVALID_ASYNC_HANDLER'],
    [[asyncHooks[0], asyncHooks[3]], 'FST_ERR_HOOK_INVALID_ASYNC_HANDLER']
  ]) {
    const app = Fastify()
    t.assert.throws(() => app.post('/', { onRequest: hooks }, async () => 'ok'), { code })
    t.assert.strictEqual(app.hasRoute({ method: 'POST', url: '/' }), false)
  }
})

test('onRoute additions and replacements are validated in their final form', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  for (const asArray of [false, true]) {
    const app = Fastify()
    t.after(() => app.close())
    const wrap = fn => asArray ? [fn] : fn
    app.addHook('onRoute', opts => {
      opts.onRequest = wrap(opts.url === '/invalid' ? asyncHooks[3] : asyncHooks[0])
    })
    warning.mock.resetCalls()
    if (asArray) {
      t.assert.throws(() => app.post('/invalid', async () => 'ok'), asyncError)
      t.assert.strictEqual(warning.mock.callCount(), 0)
    } else {
      app.post('/invalid', async () => 'ok')
      t.assert.strictEqual(warning.mock.callCount(), 1)
    }
    warning.mock.resetCalls()
    app.post('/valid', { onRequest: wrap(asyncHooks[3]) }, async () => 'ok')
    t.assert.strictEqual(warning.mock.callCount(), 0)
    const response = await app.inject({ method: 'POST', url: '/valid' })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.payload, 'ok')
    if (!asArray) {
      t.assert.strictEqual((await app.inject({ method: 'POST', url: '/invalid' })).statusCode, 200)
    }
  }
})

test('single route hooks in encapsulated plugins warn without rejecting boot', async t => {
  const warning = t.mock.method(process, 'emitWarning', () => {})
  for (const [name, fn] of [['onRequest', asyncHooks[3]], ['onRequestAbort', asyncHooks[0]]]) {
    const app = Fastify()
    t.after(() => app.close())
    app.register(async function (child) {
      child.post('/', { [name]: fn }, async () => 'ok')
    }, { prefix: '/plugin' })
    warning.mock.resetCalls()
    await app.ready()
    t.assert.strictEqual(warning.mock.callCount(), name === 'onRequest' ? 1 : 0)
    if (name === 'onRequest') {
      t.assert.match(warning.mock.calls[0].arguments[0], /onRequest hook for POST \/plugin/)
    }
    for (const url of ['/plugin', '/plugin/']) {
      const response = await app.inject({ method: 'POST', url })
      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.payload, 'ok')
    }
    t.assert.strictEqual(warning.mock.callCount(), name === 'onRequest' ? 1 : 0)
  }
})

test('validation retains the caller hook form and accepts frozen arrays', async t => {
  for (const asArray of [false, true]) {
    const app = Fastify()
    t.after(() => app.close())
    const fn = async () => {}
    const hook = asArray ? Object.freeze([fn]) : fn
    app.addHook('onRoute', opts => t.assert.strictEqual(opts.onRequest, hook))
    app.post('/', { onRequest: hook }, async () => 'ok')
    const response = await app.inject({ method: 'POST', url: '/' })
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.payload, 'ok')
  }
})

test('async rest and default parameters use the existing declared-arity rules', async t => {
  const hooks = [async (...args) => {}, async (request, reply, done = undefined) => {}]
  for (const fn of hooks) {
    for (const asArray of [false, true]) {
      const app = Fastify()
      t.after(() => app.close())
      app.post('/', { onRequest: asArray ? [fn] : fn }, async () => 'ok')
      const response = await app.inject({ method: 'POST', url: '/' })
      t.assert.strictEqual(response.statusCode, 200)
    }
  }
})

test('async validation precedes deferred name validation without coercing hook names', async t => {
  const names = ['unknown', '__proto__', 'constructor', 'toString', null, 42, Symbol('hook'), {
    toString () { throw new Error('Hook names must not be coerced') }
  }]

  for (const name of names) {
    const app = Fastify()
    t.assert.throws(() => app.addHook(name, asyncHooks[3]), asyncError)
    t.assert.strictEqual(app.addHook(name, asyncHooks[0]), app)
    await t.assert.rejects(app.ready(), {
      code: typeof name === 'string' ? 'FST_ERR_HOOK_NOT_SUPPORTED' : 'FST_ERR_HOOK_INVALID_TYPE'
    })
  }
})

test('handler type errors retain their timing and precedence', async t => {
  const app = Fastify()
  t.assert.throws(() => app.addHook('onRequest', null), { code: 'FST_ERR_HOOK_INVALID_HANDLER' })
  t.assert.throws(() => app.addHook('onReady', 42), { code: 'FST_ERR_HOOK_INVALID_HANDLER' })
  t.assert.strictEqual(app.addHook('onRequest', 42), app)
  await t.assert.rejects(app.ready(), { code: 'FST_ERR_HOOK_INVALID_HANDLER' })

  for (const hook of [42, [42]]) {
    const routeApp = Fastify()
    t.assert.throws(() => routeApp.get('/', { onRequest: hook }, async () => 'ok'), {
      code: 'FST_ERR_HOOK_INVALID_HANDLER'
    })
  }
})

for (const asArray of [false, true]) {
  test(`regular functions returning promises retain callback-shaped signatures (array: ${asArray})`, async t => {
    const app = Fastify()
    t.after(() => app.close())
    const calls = []
    const wrap = fn => asArray ? [fn] : fn

    app.addHook('onRequest', function (request, reply, done) {
      calls.push('instance')
      return Promise.resolve()
    })
    app.get('/', {
      onRequest: wrap(function (request, reply, done) {
        calls.push('route')
        return Promise.resolve()
      }),
      onSend: wrap(function (request, reply, payload, done) {
        return Promise.resolve(payload + '!')
      })
    }, async () => 'ok')

    const response = await app.inject('/')
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.payload, 'ok!')
    t.assert.deepStrictEqual(calls, ['instance', 'route'])
  })
}
