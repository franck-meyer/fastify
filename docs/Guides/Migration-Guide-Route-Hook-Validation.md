# Route Hook Validation Migration

Status: unreleased warning transition, proposed for a minor release.
This guide describes the implementation in this working tree; it does not
announce a released Fastify version.

## What changes

Single route lifecycle hooks with deprecated native async signatures emit
`FSTDEP023` during registration. They continue to register, boot, and execute
with the existing runner behavior. No automatic conversion to callback style
or new runtime validation occurs.

For example, `preHandler: async (request, reply, done) => {}` on a POST route
remains accepted and now warns. The same function inside an array or passed to
`addHook` still throws `FST_ERR_HOOK_INVALID_ASYNC_HANDLER`, as before.

Async `onRequestAbort` hooks now accept zero or one declared parameter in all
three registration forms. Omitting an unused request parameter is safe and
does not produce a warning. This relaxes the former array and `addHook` rule.

| Hook | Deprecated declared parameter count for native async functions |
| --- | --- |
| `onRequest`, `preValidation`, `preHandler`, `onResponse`, `onTimeout` | Exactly three |
| `preParsing`, `preSerialization`, `onSend`, `onError` | Exactly four |
| `onRequestAbort` | More than one |

These checks use `Function.length`, which stops before the first default or
rest parameter. The ordinary and payload hook checks are not general maximum
parameter limits. Follow the documented signatures instead of using unusual
parameters to bypass diagnostics. Regular functions returning promises retain
their existing treatment.

Diagnostics identify the hook, method, full prefixed URL, and declared arity.
They inspect data properties without invoking custom metadata getters or proxy
traps. Such customized functions may not produce diagnostics; warnings are not
a complete static analysis of callback use.

## Update async hooks

Remove the unused callback parameter from an async hook:

```js
// Before: still accepted as a single hook, now emits FSTDEP023.
fastify.post('/items', {
  preHandler: async (request, reply, done) => {
    await authenticate(request)
  }
}, handler)
```

```js
// After: valid in either form, with no warning.
fastify.post('/items', {
  preHandler: async (request, reply) => {
    await authenticate(request)
  }
}, handler)
```

For payload hooks, keep the payload parameter and remove `done`:

```js
fastify.post('/items', {
  onSend: async (request, reply, payload) => {
    return transform(payload)
  }
}, handler)
```

If the hook calls `done`, use a regular callback function and remove `async`:

```js
fastify.post('/items', {
  preHandler: (request, reply, done) => {
    authenticateWithCallback(request, done)
  }
}, handler)
```

Use one completion mechanism for each hook. Continuing to accept a hook does
not make mixing callbacks and promises safe; existing double-completion risks
remain when both are used.

## Request-abort hooks

Both async forms are supported without warnings:

```js
fastify.addHook('onRequestAbort', async () => {
  await releaseResources()
})

fastify.post('/upload', {
  onRequestAbort: [async (request) => {
    await recordAbortedUpload(request.id)
  }]
}, handler)
```

The callback form remains `(request, done) => { ... }`. Async hooks declaring
two or more parameters still fail in arrays and `addHook`; single route hooks
warn during the transition.

## GET and HEAD routes

Existing HEAD behavior is preserved. Automatic HEAD registration converts
`onSend` into an array. Consequently, an invalid single async `onSend` can
still throw during generated HEAD registration, after the GET route has been
inserted. Correct the signature before starting the server. This transition
does not make failed route registration transactional.

When HEAD exposure is disabled, or an explicit HEAD route already exists,
the same single `onSend` continues to register and now warns. Existing array
errors are not downgraded to warnings.

Diagnostics run after `onRoute` callbacks modify options. Each method and hook
can produce a warning, including generated HEAD hooks. Automatic slash and
no-slash variants share the initial diagnostic. Warnings occur at registration,
never per request, and are not globally suppressed after the first route.

## Check an application or plugin

Run boot and request tests with `node --trace-warnings` to locate registrations,
including hooks supplied by route factories and `onRoute` callbacks.
`FSTDEP023` uses the `FastifyWarning` category, like `FSTDEP022`; it does not
become fatal under `--throw-deprecation`. Use `--trace-warnings`, rather than
`--trace-deprecation`, for its stack trace. Applications with custom warning
listeners that throw may still terminate; review those policies before rollout.

To explicitly fail CI on this warning, install a listener **before loading the
application** in a dedicated boot-check process:

```js
process.on('warning', warning => {
  if (warning.code === 'FSTDEP023') process.exitCode = 1
})

async function check () {
  const app = require('./app')()
  try {
    await app.ready()
  } finally {
    await app.close()
  }
}

check().catch(error => {
  console.error(error)
  process.exitCode = 1
})
```

This is an opt-in CI policy, with no new Fastify factory option. It checks routes
loaded by that process; also exercise conditional plugin registrations and
actual HEAD settings. Warnings use Node's asynchronous warning event, so do
not call `process.exit()` immediately after registration.

TypeScript types cannot distinguish native async functions from regular
functions returning promises. Public declarations are unchanged; type checks
alone do not establish a valid runtime signature. Zero-argument async abort
hooks are already expressible with the existing declarations.

This change covers lifecycle hooks passed to route registration.
`setNotFoundHandler` options use a separate registration path and are outside
this change.

## Release and enforcement plan

Proposed release note:

> Single route lifecycle hooks with deprecated native async signatures now
> emit `FSTDEP023` while retaining existing registration and execution behavior.
> Remove unused `done` parameters, or use a regular callback function when
> calling `done`. Async `onRequestAbort` accepts zero or one parameter in every
> registration form. Existing array and `addHook` errors otherwise remain.

Before publishing, require the supported Node/OS CI matrix and core-plugin
compatibility workflow to pass. Exercise a prerelease against representative
applications, check warning volume and boot success, and inspect custom warning
policies. Repository tests alone cannot establish external ecosystem safety.
If the warning rollout causes regressions, defer its emission while retaining
the independent catalogue refactor; do not silently enable stricter validation.

Enforcement for single hooks remains future work requiring a separate major
release decision, migration notice, and ecosystem results. There is no automatic
version switch or date on which this implementation starts rejecting them.
