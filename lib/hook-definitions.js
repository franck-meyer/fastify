'use strict'

const { FST_ERR_HOOK_INVALID_ASYNC_HANDLER } = require('./errors')
const { types: { isProxy } } = require('node:util')
const { FSTDEP023 } = require('./warnings')

// Registration policy only: execution order and runners remain explicit.
// Keep this order compatible with the existing lifecycleHooks/supportedHooks lists.
const hookDefinitions = Object.freeze([
  {
    name: 'onTimeout',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withoutDone
  },
  {
    name: 'onRequest',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withoutDone
  },
  {
    name: 'preParsing',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withPayloadWithoutDone
  },
  {
    name: 'preValidation',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withoutDone
  },
  {
    name: 'preSerialization',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withPayloadWithoutDone
  },
  {
    name: 'preHandler',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withoutDone
  },
  {
    name: 'onSend',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withPayloadWithoutDone
  },
  {
    name: 'onResponse',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withoutDone
  },
  {
    name: 'onError',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withPayloadWithoutDone
  },
  {
    name: 'onRequestAbort',
    category: 'lifecycle',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: requestOnly
  },
  {
    name: 'onRoute',
    category: 'application',
    storage: 'inherited',
    registration: 'immediate',
    isAsyncArityValid: withoutDone
  },
  {
    name: 'onRegister',
    category: 'application',
    storage: 'inherited',
    registration: 'deferred',
    isAsyncArityValid: withoutDone
  },
  {
    name: 'onReady',
    category: 'application',
    storage: 'local',
    registration: 'immediate',
    isAsyncArityValid: noArguments
  },
  {
    name: 'onListen',
    category: 'application',
    storage: 'local',
    registration: 'immediate',
    isAsyncArityValid: noArguments
  },
  {
    name: 'preClose',
    category: 'application',
    storage: 'local',
    registration: 'deferred',
    isAsyncArityValid: withoutDone
  },
  {
    name: 'onClose',
    category: 'application',
    storage: 'external',
    registration: 'avvio',
    isAsyncArityValid: withoutDone
  }
].map(Object.freeze))

const definitionsByName = new Map(hookDefinitions.map(definition => [definition.name, definition]))
const lifecycleHooks = hookDefinitions.filter(definition => definition.category === 'lifecycle')
  .map(definition => definition.name)
const supportedHooks = hookDefinitions.map(definition => definition.name)
const inheritedHooks = Object.freeze(hookDefinitions.filter(definition => definition.storage === 'inherited')
  .map(definition => definition.name))

function withoutDone (arity) {
  return arity !== 3
}

function withPayloadWithoutDone (arity) {
  return arity !== 4
}

function noArguments (arity) {
  return arity === 0
}

function requestOnly (arity) {
  return arity === 0 || arity === 1
}

// Deferred registration propagates to existing descendants independently of storage policy.
function getHookRegistration (name) {
  // Preserve deferred name validation, including for non-string names.
  return definitionsByName.get(name)?.registration || 'deferred'
}

// Callers retain handler-type validation and decide when this check runs.
function validateHookAsync (name, fn) {
  if (fn.constructor.name !== 'AsyncFunction') return

  if (!isHookAsyncArityValid(name, fn.length)) {
    throw new FST_ERR_HOOK_INVALID_ASYNC_HANDLER()
  }
}

function isHookAsyncArityValid (name, arity) {
  const definition = definitionsByName.get(name)
  // Unknown names historically receive the ordinary arity check before name validation.
  const isAsyncArityValid = definition ? definition.isAsyncArityValid : withoutDone
  return isAsyncArityValid(arity)
}

function warnIfInvalidAsyncHook (name, fn, method, url) {
  // Diagnostics for previously accepted single hooks must not invoke custom
  // constructor/length getters or proxy traps. This also handles bound async
  // functions, which util.types.isAsyncFunction does not recognize.
  const constructor = getDataProperty(fn, 'constructor')
  if (getDataProperty(constructor, 'name') !== 'AsyncFunction') return
  const arity = getDataProperty(fn, 'length')
  if (typeof arity === 'number' && !isHookAsyncArityValid(name, arity)) {
    FSTDEP023(name, `${method} ${url}`, String(arity))
  }
}

function getDataProperty (object, name) {
  while (object != null && !isProxy(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    if (descriptor) return descriptor.value
    object = Object.getPrototypeOf(object)
  }
}

module.exports = {
  lifecycleHooks,
  supportedHooks,
  inheritedHooks,
  getHookRegistration,
  validateHookAsync,
  warnIfInvalidAsyncHook
}
