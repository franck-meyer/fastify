'use strict'

const { createRequire } = require('node:module')
const { join } = require('node:path')
const { Writable } = require('node:stream')
const { setImmediate: immediate } = require('node:timers/promises')

// Resolve Fastify and every plugin from the isolated installed application.
// Both installations use the same plugin versions and different Fastify tarballs.
module.exports = async function build (directory, options) {
  const load = createRequire(join(directory, 'package.json'))
  const state = {
    requests: 0,
    handlers: 0,
    responses: 0,
    duplicates: 0,
    uploads: 0,
    rootAborts: 0,
    routeAborts: 0,
    websocketMessages: 0,
    websockets: 0,
    warnings: 0,
    logBytes: 0,
    errorLogs: 0,
    cleanupErrors: 0
  }
  const uploads = new Map()
  const sockets = new Set()
  const app = load('fastify')({
    logger: {
      level: 'info',
      stream: new Writable({
        write (chunk, encoding, callback) {
          state.logBytes += chunk.length
          const record = JSON.parse(chunk)
          if (record.level >= 50) state.errorLogs++
          callback()
        }
      })
    }
  })
  app.server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const onWarning = warning => {
    if (warning.code === 'FSTDEP023') state.warnings++
    app.log.warn({ code: warning.code }, warning.message)
  }
  process.on('warning', onWarning)
  app.addHook('onClose', async () => process.removeListener('warning', onWarning))
  app.decorateRequest('validationEnter', null)
  app.addHook('onRequest', function (request, reply, done) {
    state.requests++
    const seen = new Set()
    request.validationEnter = name => {
      if (seen.has(name)) state.duplicates++
      seen.add(name)
    }
    request.validationEnter('root')
    const id = request.headers['x-validation-abort']
    if (id) {
      uploads.set(id, { request })
      options.notify({ event: 'upload-started', id })
    }
    done()
  })
  app.addHook('onResponse', async request => {
    request.validationEnter('response')
    state.responses++
  })
  app.addHook('onRequestAbort', async function (request) {
    await immediate()
    const id = request.headers['x-validation-abort']
    if (!uploads.delete(id)) state.cleanupErrors++
    state.rootAborts++
    options.notify({ event: 'abort-cleaned', id })
  })
  app.addHook('onRoute', route => {
    if (!route.config?.generatedHook) return
    route.onRequest = options.legacy
      ? async function (request, reply, done) { request.validationEnter('generated') }
      : async function (request, reply) { request.validationEnter('generated') }
  })
  await app.register(load('@fastify/cookie'), { secret: 'local-fixture-cookie-secret-with-32-characters' })
  await app.register(load('@fastify/cors'), { origin: 'https://fixture.example' })
  await app.register(load('@fastify/jwt'), { secret: 'local-fixture-jwt-secret-with-32-characters' })
  await app.register(load('@fastify/swagger'), {
    openapi: { info: { title: 'Hook validation fixture', version: '1.0.0' } }
  })
  await app.register(load('@fastify/swagger-ui'), { routePrefix: '/documentation' })
  await app.register(load('@fastify/multipart'))
  await app.register(load('@fastify/websocket'))

  app.get('/session', async (request, reply) => {
    reply.setCookie('sid', 'sample-session', { signed: true, httpOnly: true })
    return { token: app.jwt.sign({ sub: 'sample-user' }) }
  })
  await app.register(async api => {
    const authenticate = options.legacy
      ? async function (request, reply, done) {
        request.validationEnter('authenticate')
        await request.jwtVerify()
      }
      : async function (request, reply) {
        request.validationEnter('authenticate')
        await request.jwtVerify()
      }
    api.get('/items/:id', {
      config: { generatedHook: true },
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      preHandler: authenticate
    }, async request => {
      request.validationEnter('handler')
      state.handlers++
      return {
        id: request.params.id,
        user: request.user.sub,
        cookie: Boolean(request.cookies.sid && request.unsignCookie(request.cookies.sid).valid)
      }
    })
    const transform = async function (request, reply, payload) {
      request.validationEnter('serialize')
      return { ...payload, transformed: true }
    }
    api.post('/items', {
      preHandler: authenticate,
      schema: { body: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      preSerialization: options.legacy
        ? async function (request, reply, payload, done) { return transform(request, reply, payload) }
        : transform,
      onSend: options.legacy
        ? async function (request, reply, payload, done) { request.validationEnter('send'); return payload }
        : async function (request, reply, payload) { request.validationEnter('send'); return payload }
    }, async (request, reply) => {
      request.validationEnter('handler')
      state.handlers++
      reply.code(201)
      return { id: request.body.id }
    })
    api.get('/callback', {
      preHandler: [(request, reply, done) => { request.validationEnter('callback'); done() }]
    }, async () => ({ callback: true }))
  }, { prefix: '/v1' })
  await app.register(load('@fastify/autoload'), {
    dir: join(__dirname, 'fixtures'),
    options: { prefix: '/auto', legacy: options.legacy }
  })
  if (options.conditional) {
    await app.register(async feature => {
      feature.get('/enabled', { config: { generatedHook: true } }, async () => ({ enabled: true }))
    }, { prefix: '/feature' })
  }
  app.post('/upload/file', async request => {
    const part = await request.file()
    const data = await part.toBuffer()
    state.uploads++
    return { bytes: data.length, filename: part.filename }
  })
  const routeAbort = options.omitAbortRequest
    ? async function () { await immediate(); state.routeAborts++ }
    : async function (request) { await immediate(); state.routeAborts++ }
  app.post('/upload/raw', { onRequestAbort: [routeAbort] }, async () => ({ uploaded: true }))
  app.get('/events', { websocket: true }, socket => {
    state.websockets++
    socket.on('message', message => {
      state.websocketMessages++
      socket.send(message)
    })
    socket.once('close', () => { state.websockets-- })
  })

  return {
    app,
    metrics: () => ({
      ...state,
      activeUploads: uploads.size,
      sockets: sockets.size,
      memory: process.memoryUsage(),
      resources: process.getActiveResourcesInfo()
    })
  }
}
