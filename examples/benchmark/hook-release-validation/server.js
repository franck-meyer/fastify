'use strict'

const build = require('./app')

async function main () {
  const [directory, profile] = process.argv.slice(2)
  const options = JSON.parse(profile)
  const { app, metrics } = await build(directory, {
    ...options,
    notify: message => process.send(message)
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  process.send({ event: 'ready', address })
  process.on('message', async message => {
    if (message.command === 'metrics') {
      if (global.gc) global.gc()
      process.send({ event: 'metrics', id: message.id, metrics: metrics() })
    } else if (message.command === 'close') {
      await app.close()
      // Let socket close notifications settle before recording resource counts.
      setImmediate(() => {
        process.send({ event: 'closed', metrics: metrics() }, () => process.disconnect())
      })
    }
  })
}

main().catch(error => { console.error(error); process.exitCode = 1; process.disconnect() })
