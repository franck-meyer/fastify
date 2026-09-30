'use strict'

const { test } = require('node:test')
const { kRouteContext } = require('../../lib/symbols')
const Context = require('../../lib/context')

const Fastify = require('../..')

test('context initialization preserves hook placement and boot-only slots', t => {
  const app = Fastify()
  t.after(() => app.close())
  const context = new Context({ server: app, config: {}, handler: () => {} })
  const initializedHooks = [
    'onRequest', 'onSend', 'onError', 'onTimeout', 'preHandler', 'onResponse',
    'preSerialization', 'onRequestAbort'
  ]

  t.assert.deepStrictEqual(Object.keys(context).slice(0, 14), [
    'schema', 'handler', 'Reply', 'Request', 'contentTypeParser',
    ...initializedHooks, 'config'
  ])
  for (const hook of initializedHooks) {
    t.assert.deepStrictEqual(Object.getOwnPropertyDescriptor(context, hook), {
      value: null, writable: true, enumerable: true, configurable: true
    })
  }
  t.assert.strictEqual(Object.hasOwn(context, 'preParsing'), false)
  t.assert.strictEqual(Object.hasOwn(context, 'preValidation'), false)
})

test('context', async context => {
  context.plan(1)

  await context.test('Should not contain undefined as key prop', async t => {
    t.plan(4)
    const app = Fastify()

    app.get('/', (req, reply) => {
      t.assert.ok(req[kRouteContext] instanceof Context)
      t.assert.ok(reply[kRouteContext] instanceof Context)
      t.assert.ok(!('undefined' in reply[kRouteContext]))
      t.assert.ok(!('undefined' in req[kRouteContext]))

      reply.send('hello world!')
    })

    try {
      await app.inject('/')
    } catch (e) {
      t.assert.fail(e)
    }
  })
})
