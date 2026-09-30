'use strict'

module.exports = async function tenant (app, options) {
  app.register(async child => {
    child.get('/nested', {
      config: { generatedHook: true },
      preHandler: options.legacy
        ? async function (request, reply, done) { request.validationEnter('tenant') }
        : async function (request, reply) { request.validationEnter('tenant') }
    }, async () => ({ tenant: 'sample' }))
  })
}
