# Application validation for the hook warning transition

These are constructed application fixtures using released Fastify plugins.
They supplement Fastify's unit tests; they are not deployments of a user's
application and do not reproduce its infrastructure or warning policy.

## Reproduce

Use Node 24 and two clean source checkouts: the unchanged base and the candidate.
The scripts are outside the normal unit suite and install into a separate
working directory. They do not require changes to Fastify's dependencies.

```sh
node examples/benchmark/hook-release-validation/prepare.js \
  /tmp/hook-apps /path/to/baseline /path/to/candidate

node examples/benchmark/hook-release-validation/run.js \
  /tmp/hook-apps/baseline baseline /tmp/hook-apps/baseline.json 20 3

node examples/benchmark/hook-release-validation/run.js \
  /tmp/hook-apps/candidate candidate /tmp/hook-apps/candidate.json 20 3
```

The final arguments select seconds per traffic round and the number of rounds.
`prepare.js` packs each Fastify checkout, installs the pinned plugins, and copies
the dependency lock between applications while substituting the Fastify tarball
integrity. All other dependency versions and integrity values remain identical.
Do not use these fixtures as production authentication or upload examples.

## Checks

- Authenticated JSON API: JWT, signed cookies, CORS, schema validation,
  serialization, callback hooks, and automatic HEAD responses.
- Autoloaded nested routes, hooks supplied by `onRoute`, and conditional plugin
  registration with the feature enabled and disabled.
- OpenAPI document generation through Swagger UI's JSON endpoint.
- Multipart uploads, WebSocket echo, and real TCP disconnects during uploads.
- Legacy native async signatures continue running; corrected signatures remain
  silent. Candidate profiles also use zero-argument async abort hooks in arrays.
- Per-request markers detect duplicate hook/handler execution. Abort resources,
  WebSocket connections, and server sockets must be released at shutdown.
- Five warning policies: default Node output, structured logging, throwing on
  every warning, allowing `FSTDEP023` while throwing on other warnings, and
  explicitly failing CI on `FSTDEP023`. Expected failures are asserted.
- A `--throw-deprecation` startup check and repeated 500/2,000-route startup
  measurements. GET and generated HEAD warnings are counted separately.
- Three traffic rounds with 25 HTTP connections, 100 aborted uploads and 500
  WebSocket messages per round. Requests use JWT authentication and serialization
  while a separate process generates traffic.

Results record throughput, latency, errors, warning counts, resource counts,
and heap/RSS samples after explicit GC. These short, single-host measurements
are diagnostic; they do not establish production capacity or prove absence of
long-term memory leaks. Startup figures include real warning formatting and
captured output, but do not model a remote log collector's backpressure.

## CI and Swagger

`workflow.yml` records the validation workflow used in the fork. It pins both
Fastify revisions and the Swagger source revision. In the isolated validation
branch it replaces the existing manually dispatchable `citgm-package.yml`;
the candidate's production CI files are unchanged.

Swagger's `QUERY` test receives the test-only patch at
[`swagger-query-compatibility.patch`](../../../docs/Design/swagger-query-compatibility.patch).
That fixture explicitly registers the method through Fastify's existing
`addHttpMethod('QUERY', { hasBody: true })` API. The test and all of its assertions
remain enabled. The original unmodified upstream plugin run remains a separate
record; passing with this patch does not imply that the upstream test has been
fixed or merged.
