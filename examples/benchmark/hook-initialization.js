'use strict'

// Compare two checkouts without loading their constructors into the same process.
// See docs/Design/Hook-Initialization.md for workloads and interpretation.
const { spawnSync } = require('node:child_process')
const { availableParallelism, cpus, platform, release } = require('node:os')
const { resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { parseArgs } = require('node:util')

const { values } = parseArgs({
  options: {
    baseline: { type: 'string', default: resolve(__dirname, '../..') },
    candidate: { type: 'string' },
    rounds: { type: 'string', default: '9' },
    iterations: { type: 'string', default: '40' },
    allocations: { type: 'string', default: '200000' },
    requests: { type: 'string', default: '2000' },
    worker: { type: 'string' },
    root: { type: 'string' }
  }
})

const settings = {}
for (const key of ['rounds', 'iterations', 'allocations', 'requests']) {
  settings[key] = Number(values[key])
  if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) {
    throw new Error(`--${key} must be a positive integer`)
  }
}

const scenarios = [
  'load-and-ready', 'hooks', 'build-hooks', 'context',
  'ready', 'routes', 'plugins', 'plugin-routes', 'inject'
]

if (values.worker) {
  runWorker().then(result => {
    process.stdout.write(JSON.stringify(result))
  }).catch(err => {
    console.error(err)
    process.exitCode = 1
  })
} else {
  runComparison()
}

function runComparison () {
  const roots = { baseline: resolve(values.baseline) }
  if (values.candidate) roots.candidate = resolve(values.candidate)
  const samples = Object.fromEntries(scenarios.map(name => [name,
    Object.fromEntries(Object.keys(roots).map(label => [label, []]))
  ]))

  for (let round = 0; round < settings.rounds; round++) {
    // Alternate both scenario and checkout order to reduce systematic drift.
    const labels = Object.keys(roots)
    const order = scenarios.slice()
    if (round % 2) { labels.reverse(); order.reverse() }
    for (const name of order) {
      for (const label of labels) {
        const child = spawnSync(process.execPath, [
          '--expose-gc', __filename, '--worker', name, '--root', roots[label],
          '--iterations', String(settings.iterations),
          '--allocations', String(settings.allocations), '--requests', String(settings.requests)
        ], { encoding: 'utf8', timeout: 120000 })
        if (child.error || child.status !== 0) {
          throw child.error || new Error(`${label}/${name}: ${child.stderr}`)
        }
        samples[name][label].push(JSON.parse(child.stdout).msPerOperation)
      }
    }
    console.error(`Completed round ${round + 1}/${settings.rounds}`)
  }

  const results = Object.fromEntries(scenarios.map(name => {
    const result = Object.fromEntries(Object.entries(samples[name]).map(([label, samples]) => [label, {
      medianMs: percentile(samples, 0.5),
      p25Ms: percentile(samples, 0.25),
      p75Ms: percentile(samples, 0.75),
      samplesMs: samples
    }]))
    if (result.candidate) {
      const changes = samples[name].candidate.map((sample, i) => (sample / samples[name].baseline[i] - 1) * 100)
      result.pairedChangePercent = {
        median: percentile(changes, 0.5), min: Math.min(...changes), max: Math.max(...changes)
      }
    }
    return [name, result]
  }))
  process.stdout.write(JSON.stringify({
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model,
      parallelism: availableParallelism()
    },
    settings,
    roots,
    results
  }, null, 2) + '\n')
}

function percentile (samples, fraction) {
  const sorted = samples.slice().sort((a, b) => a - b)
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)
}

async function runWorker () {
  const name = values.worker
  if (!scenarios.includes(name) || !values.root) throw new Error('Invalid worker arguments')
  const loadStart = performance.now()
  const Fastify = require(resolve(values.root, 'fastify.js'))
  if (name === 'load-and-ready') {
    const app = Fastify()
    await app.ready()
    const elapsed = performance.now() - loadStart
    await app.close()
    return { msPerOperation: elapsed }
  }

  if (['hooks', 'build-hooks', 'context'].includes(name)) {
    const { Hooks, buildHooks } = require(resolve(values.root, 'lib/hooks.js'))
    const Context = require(resolve(values.root, 'lib/context.js'))
    const app = Fastify()
    const parent = new Hooks()
    for (const hook of Object.keys(parent)) parent[hook].push(requestHook, requestHook)
    const options = { server: app, handler, config: {} }
    const factory = name === 'hooks'
      ? () => new Hooks()
      : name === 'build-hooks' ? () => buildHooks(parent) : () => new Context(options)
    // Retain a small window of allocations so construction cannot be eliminated.
    const retained = new Array(128)
    for (let i = 0; i < 20000; i++) retained[i % retained.length] = factory()
    global.gc()
    const start = performance.now()
    for (let i = 0; i < settings.allocations; i++) retained[i % retained.length] = factory()
    const elapsed = performance.now() - start
    const retainedProperties = retained.reduce((count, value) => count + Object.keys(value).length, 0)
    if (!retainedProperties) throw new Error('Missing allocation')
    await app.close()
    return { msPerOperation: elapsed / settings.allocations, retainedProperties }
  }

  if (name === 'inject') {
    const app = Fastify()
    configure(app, 'plugin-routes')
    await app.ready()
    async function inject (i) {
      const response = await app.inject({ method: 'POST', url: `/branch-${i % 20}/route-0` })
      if (response.statusCode !== 200 || response.payload !== 'ok') throw new Error('Injection failed')
    }
    for (let i = 0; i < 500; i++) await inject(i)
    global.gc()
    const start = performance.now()
    for (let i = 0; i < settings.requests; i++) await inject(i)
    const elapsed = performance.now() - start
    await app.close()
    return { msPerOperation: elapsed / settings.requests }
  }

  let elapsed = 0
  for (let i = 0; i < 10 + settings.iterations; i++) {
    if (i === 10) global.gc()
    const start = performance.now()
    const app = Fastify()
    configure(app, name)
    await app.ready()
    if (i >= 10) elapsed += performance.now() - start
    // Shutdown is deliberately outside the timed interval.
    await app.close()
  }
  return { msPerOperation: elapsed / settings.iterations }
}

function configure (app, name) {
  if (name === 'ready') return
  if (name === 'routes') {
    for (let i = 0; i < 200; i++) app.post(`/route-${i}`, handler)
    return
  }
  app.addHook('onRequest', requestHook)
  app.addHook('preHandler', requestHook)
  for (let i = 0; i < 20; i++) {
    app.register(plugin, { prefix: `/branch-${i}`, depth: 3 })
  }

  function plugin (instance, opts, done) {
    instance.addHook('onRequest', requestHook)
    if (name === 'plugin-routes') {
      instance.post('/route-0', handler)
      instance.post('/route-1', handler)
    }
    if (opts.depth > 1) instance.register(plugin, { prefix: '/nested', depth: opts.depth - 1 })
    done()
  }
}

function requestHook (request, reply, done) { done() }
function handler () { return 'ok' }
