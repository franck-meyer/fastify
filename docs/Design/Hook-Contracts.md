# Centralizing built-in hook contracts

Status: foundation and registration-policy migration implemented, with
consistency checks and constructor evaluation complete. Route hook validation
now has an unreleased warning transition; stricter single-hook enforcement is
deferred to a separate major-release decision.

## Problem and evidence

Fastify's hook contract is distributed across independent lists and branches.
Adding a hook requires coordinating its name, storage, inheritance, signature
validation, route context, execution, documentation, and TypeScript definitions.
There is no common description of the registration policy. As more hooks and
registration paths appear, a change can update one path while missing another.

Before this refactor, the implementation illustrated the problem:

- [lib/hooks.js](../../lib/hooks.js) declares hook names, initializes arrays,
  copies inherited arrays, and implements several runners.
- [fastify.js](../../fastify.js) validates async signatures in `addHook`, then
  chooses immediate registration, deferred propagation, or Avvio's `onClose`.
- [lib/route.js](../../lib/route.js) repeats async signature rules for arrays of
  route hooks. A single route hook only receives the handler-type check at
  that site. Generated HEAD routes convert `onSend` to an array, so even a
  single `onSend` can reach the async check through that path.
- [lib/plugin-override.js](../../lib/plugin-override.js) uses `buildHooks` to
  create an encapsulated child's hook storage.
- Route and [404](../../lib/four-oh-four.js) setup compose instance and route
  hooks and bind them to the owning instance before requests execute.
- [lib/handle-request.js](../../lib/handle-request.js),
  [lib/reply.js](../../lib/reply.js), and routing call specialized runners at
  their respective lifecycle stages.

Those runners have meaningful differences: `preParsing` replaces the request
stream and stops after an early reply; `onSend` and `preSerialization` propagate
a payload; `onResponse` can execute after the reply is sent; `onRequestAbort`
has no reply argument. Application hooks also have distinct traversal, timeout,
and error handling. A common registration contract need not erase these
execution semantics.

## Alternatives

| Approach | Benefit | Cost or risk |
| --- | --- | --- |
| Keep separate lists and add cross-checks | Smallest immediate change | Every new rule still has several owners |
| Introduce a generic registration and execution engine | One extensible mechanism | Changes timing, payload handling, boot integration, and the request hot path together |
| Introduce a private built-in hook catalogue | Shared registration policy with incremental adoption | Explicit execution and storage construction still need coordination |

The recommendation is the private catalogue. User-defined lifecycle stages,
hook priorities, cancellation, and new public APIs are outside this proposal.
They would require separate designs and evidence of demand.

## Design

`lib/hook-definitions.js` is independent of the runners. Each built-in hook
has a name, category (`lifecycle` or `application`), storage policy (`inherited`,
`local`, or `external`), registration policy, and an async-arity predicate.
Definitions are private and immutable. Internal consumers receive derived name
lists, an async-signature validator, and a registration-policy lookup through
`lib/hooks.js`. Existing exports are retained.

Preserve the current name-list ordering. It is an enumeration order, not a
declaration of lifecycle execution order. The catalogue does not dispatch hooks.

Storage policy describes child construction, not registration timing:

- Lifecycle hooks, `onRoute`, and `onRegister` copy their parent arrays.
- `onReady`, `onListen`, and `preClose` start with empty arrays in children.
- `onClose` is externally stored by Avvio and has no `Hooks` array.

In particular, `preClose` can still propagate through deferred `addHook`
registration even though child construction does not copy its array. These two
operations must not be conflated.

`buildHooks` copies only the catalogue's inherited hooks. The explicit `Hooks`
constructor and route `Context` layout retain their property insertion order.
Tests check storage and initialized contexts against the catalogue. A future
constructor refactor can be evaluated independently.

Registration policy selects the existing `addHook` branches:

| Policy | Hooks | Registration behavior |
| --- | --- | --- |
| `immediate` | `onRoute`, `onReady`, `onListen` | Add to this instance synchronously; do not propagate to existing children |
| `deferred` | All lifecycle hooks, `onRegister`, `preClose` | Schedule with `after`, then add to this instance and recursively to existing descendants |
| `avvio` | `onClose` | Bind to the registering instance and delegate to Avvio's close registration |

These policies describe registration operations, not execution order.
`getHookRegistration` returns `deferred` for unsupported and non-string names.
It neither coerces nor validates them: existing deferred name validation must
still run, after the immediate null-handler and async-arity checks. The
listening-state guard stays ahead of all argument validation. Deferred
registration still forwards a pending boot error unless adding the hook itself
throws, in which case the registration error takes precedence.

The `deferred` policy includes propagation. If a future hook needs deferred
registration without propagation, introduce that distinct policy and its
boot-order tests; never infer propagation from `storage`.

The shared validator is used by `addHook` and route arrays. Route validation
treats a single function as a one-element list locally, without rewriting the
user's options or changing hook identity. Both forms receive handler-type
validation after `onRoute` callbacks. Arrays retain strict async checks; single
hooks use the same catalogue arity predicates to emit `FSTDEP023`, preserving
their previous acceptance. An omitted or `undefined` hook remains optional;
`undefined` inside an array is an invalid handler.

The warning helper inspects constructor and length data properties, including
those of bound functions, without invoking accessors or proxy traps. This
avoids introducing metadata-getter failures on the previously unchecked path.
Existing strict paths keep their historical detection and error precedence.
Warnings include hook, method, prefixed URL, and arity; there is no global
route cache or request-time warning work. Automatic HEAD routes are diagnosed
independently because `onRoute` can give them different hooks. The second
slash variant of a prefixed route does not repeat the same diagnostics.

Runners, callback/promise handling, boot registration, route binding, and 404
composition retain their existing behavior. The separate `setNotFoundHandler`
option-validation path is outside this change.

## Compatibility contract

- Preserve existing hook names, exports, list order, and error codes/messages.
  Keep validation order and synchronous versus deferred failures for existing
  checks; newly diagnosed single route hooks continue to register and run.
- Preserve arity checks except for the deliberate abort relaxation:
  payload/error hooks reject native async functions with four parameters;
  ordinary hooks reject three; `onReady` and
  `onListen` require zero; `onRequestAbort` accepts zero or one. These checks
  are not general maximum-arity rules.
- Preserve strict async detection by constructor name, including acceptance of
  regular functions that return promises. Warning-only diagnostics skip
  accessor/proxy metadata rather than executing user code to inspect it.
- Keep the ordinary async-arity fallback for unknown or non-string hook names,
  so early async errors retain precedence over deferred name errors. Catalogue
  lookup must not coerce names or match inherited object properties.
- Single-function route hooks warn using the shared arity rules. Arrays remain
  strict, including generated HEAD `onSend` arrays. Existing HEAD-dependent
  failures and partial GET insertion are preserved during the transition.
- Preserve callback order, early replies, error paths, payload replacement,
  plugin encapsulation, and Avvio's close ordering.
- Add no public exports or changes to TypeScript declarations. Applications
  with warning-producing signatures should follow the
  [migration guide](../Guides/Migration-Guide-Route-Hook-Validation.md).

## Migration risks and validation

The highest risks are stricter validation hidden inside a refactor, incorrect
application-hook inheritance, and moving an error from boot to registration.
Characterization tests must exercise both public registration forms, unusual
async arities, unknown names, and independent child/sibling arrays. Existing
hook, route, readiness, shutdown, and request tests remain the execution oracle.

Keep catalogue lookup in registration and boot code. No request-time lookup or
runner abstraction is introduced. This avoids adding per-request work, but is
not a claim of measured performance improvement. Future storage or runner
changes need startup and request benchmarks as well as semantic tests.

The foundation and registration-policy migration need no application changes.
The warning transition has a separate release decision and migration guide.
It is proposed for a minor release, subject to ecosystem checks. Warnings are
observable: custom listeners may throw, and applications with many affected
routes can produce substantial startup output. `FSTDEP023` uses the existing
`FastifyWarning` category so `--throw-deprecation` does not introduce an
unexpected startup failure. The migration guide provides an explicit CI gate.

## Implementation stages

1. Implemented: catalogue, derived lists, inherited-hook copying, shared async
   validator, and compatibility tests.
2. Implemented: immediate/deferred/Avvio registration policy and migration of
   `addHook`, covered by boot-order and shutdown tests. Specialized execution
   still uses direct dispatch.
3. Consistency checks implemented: catalogue names agree with storage, public
   TypeScript name unions and route options, and reference documentation.
   Registered route and 404 contexts contain every lifecycle hook, either as a
   bound array or `null`. Constructor evaluation is complete: the
   [benchmark study](Hook-Initialization.md) preserves explicit initialization
   after comparing an ordered catalogue-driven candidate. Layout checks cover
   the constructor and the fully initialized route/404 context.
4. Implemented: warning transition for single hooks using the shared rules,
   plus zero/one-parameter async abort hooks in every registration form.
   Registration, real client abort, HEAD, plugin boot, and warning-policy tests
   cover the compatibility boundaries.
5. Pending: supported Node/OS and external core-plugin CI, followed by a
   prerelease application trial. Strict single-hook enforcement requires a
   separate major-release decision after that warning period.

To add a built-in hook, define its storage and registration policies in the
catalogue, add its explicit storage/context and execution integration, update
types and public documentation, and cover its execution and encapsulation.
The catalogue is the source of registration policy, not a promise that one
entry alone creates a new lifecycle stage.

## Decision on route validation consistency

Use the same arity predicates while retaining different enforcement during
the transition. For example, single `onRequest: async (request, reply, done) =>
{}` on a POST route warns and continues running; the array form still fails.
GET/HEAD behavior remains compatible with the prior release.

The migration guide includes before/after examples, an opt-in CI check, and
release-note text. Remove unused `done` parameters from async hooks, or use
regular callback functions when invoking `done`. An unused request argument
can be omitted from async `onRequestAbort` hooks without warnings. This relaxed
rule should be retained if stricter single-hook validation is later adopted.

Future enforcement can reuse the existing catalogue predicates and strict
validator. It must revisit metadata inspection, error timing, and transactional
GET/HEAD registration explicitly. No version-triggered enforcement switch or
new public validation mode is introduced by the warning transition.

The pre-transition repository audit found 18 invalid inline async signatures
in TypeScript fixtures and none in the scanned runtime tests, examples, or
library code. New compatibility tests intentionally include such signatures.
Those fixtures now use valid signatures; callback typing remains covered by
their callback-form counterparts. Public declarations still cannot distinguish
native async functions from regular functions returning promises.

The audit covers inline hook properties in this repository, not arbitrary
application code, imported functions, or the external plugin ecosystem. Before
publishing, run plugin compatibility testing against the proposed release.

## Validation

Validated on Node.js v25.6.1:

- The initial 61 catalogue compatibility checks passed against the original
  revision `8b9c07b6` before the deliberate route-validation change.
- Warning-transition tests cover single/array signatures, plugin boot,
  GET/HEAD behavior, metadata inspection, native Node warning delivery, and
  real client disconnects with zero-argument abort hooks.
- `npm test` passes ESLint, 2,311 runtime tests (four additional tests skipped),
  and 1,278 type assertions across 16 files.
- `npm run coverage:ci-check-coverage` passes the required 100% line threshold.
- A 252-case registration comparison against the pre-enforcement catalogue
  snapshot found only the intended acceptance changes: zero-argument async
  abort hooks in `addHook` and route arrays. No newly rejected inputs appeared
  in that matrix. This is registration evidence, not an ecosystem audit.
- Markdown lint for the updated design, reference, and migration documentation
  passes, as does `git diff --check`.

Supported Node/OS CI and external plugin compatibility remain release gates;
they have not been run as part of this local verification.

Startup, plugin registration, constructor costs, and request injection were
measured in the [constructor evaluation](Hook-Initialization.md). The
catalogue-driven constructor candidate was not adopted; request runners and
production constructors retain their existing implementation.
