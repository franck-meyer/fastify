'use strict'

const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const ts = require('typescript')
const Fastify = require('../..')
const { lifecycleHooks, supportedHooks } = require('../../lib/hooks')
const { kRouteContext } = require('../../lib/symbols')

test('hook categories agree with the public TypeScript name unions', t => {
  const source = readFileSync(resolve(__dirname, '../../types/hooks.d.ts'), 'utf8')
  const ast = ts.createSourceFile('hooks.d.ts', source, ts.ScriptTarget.Latest, true)

  for (const [typeName, expected] of [
    ['LifecycleHook', lifecycleHooks],
    ['ApplicationHook', supportedHooks.filter(name => !lifecycleHooks.includes(name))]
  ]) {
    const declaration = ast.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === typeName)
    t.assert.ok(declaration, typeName)
    t.assert.ok(ts.isUnionTypeNode(declaration.type), typeName)
    const names = declaration.type.types.map(node => {
      t.assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal), typeName)
      return node.literal.text
    })
    // A union may spell a member more than once; compare its semantic set.
    t.assert.deepStrictEqual([...new Set(names)].sort(), [...expected].sort(), typeName)
  }
})

test('every lifecycle hook has a public route option', t => {
  const source = readFileSync(resolve(__dirname, '../../types/route.d.ts'), 'utf8')
  const ast = ts.createSourceFile('route.d.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find(node => ts.isInterfaceDeclaration(node) &&
    node.name.text === 'RouteShorthandOptions')
  t.assert.ok(declaration)
  const names = declaration.members.map(node => node.name?.getText(ast))
  for (const name of lifecycleHooks) {
    t.assert.ok(names.includes(name), name)
  }
})

test('hook categories agree with the reference documentation', t => {
  const source = readFileSync(resolve(__dirname, '../../docs/Reference/Hooks.md'), 'utf8').replace(/\r\n/g, '\n')
  for (const [sectionName, expected] of [
    ['Request/Reply Hooks', lifecycleHooks],
    ['Application Hooks', supportedHooks.filter(name => !lifecycleHooks.includes(name))]
  ]) {
    const section = source.split(`## ${sectionName}\n`)[1]?.split('\n## ')[0]
    t.assert.ok(section, sectionName)
    const names = [...section.matchAll(/^### (\w+)\r?$/gm)].map(match => match[1])
    t.assert.deepStrictEqual(names.sort(), [...expected].sort(), sectionName)
  }
})

for (const withHooks of [false, true]) {
  test(`route and 404 contexts initialize every lifecycle hook (with hooks: ${withHooks})`, async t => {
    const app = Fastify()
    t.after(() => app.close())
    if (withHooks) {
      for (const name of lifecycleHooks) {
        app.addHook(name, function (...args) { args.at(-1)() })
      }
    }
    function inspect (request, reply) {
      const context = request[kRouteContext]
      t.assert.deepStrictEqual(Object.keys(context).slice(-4), [
        'handlerTimeout', 'server', 'preParsing', 'preValidation'
      ])
      for (const name of lifecycleHooks) {
        t.assert.ok(Object.hasOwn(context, name), name)
        if (withHooks) {
          t.assert.strictEqual(context[name].length, 1, name)
          t.assert.strictEqual(typeof context[name][0], 'function', name)
        } else {
          t.assert.strictEqual(context[name], null, name)
        }
      }
      reply.send('ok')
    }
    app.post('/', inspect)
    app.setNotFoundHandler(inspect)
    for (const url of ['/', '/missing']) {
      const response = await app.inject({ method: 'POST', url })
      t.assert.strictEqual(response.statusCode, 200)
      t.assert.strictEqual(response.payload, 'ok')
    }
  })
}
