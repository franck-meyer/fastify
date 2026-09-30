# Hook constructor evaluation

## Decision

Retain the explicit `Hooks` and `Context` constructors. The catalogue-driven
loop candidate preserves their observable property layout but increases
construction costs without a clear improvement in application startup or
plugin loading. The existing catalogue remains responsible for registration
and inheritance policy.

This completes the performance baseline and constructor evaluation described
in [Hook Contracts](Hook-Contracts.md). It does not change route validation.
The experimental candidate is preserved as a
[patch](Hook-Initialization-candidate.patch), not adopted as production code.

## Compared implementations

The baseline is the registration-catalogue implementation with its explicit
constructors, including the preceding behavior-preserving refactors. It is
not the original repository revision before catalogue adoption. These
measurements predate the subsequent route-hook warning transition;
they compare constructor initialization strategies only.

The candidate adds `storageOrder` and `contextOrder` to each private catalogue
entry. At module load, it derives and freezes ordered property-name arrays.
The constructors then assign fresh arrays or `null` using those lists.
Both variants use the same dependencies. Only `lib/hook-definitions.js`,
`lib/hooks.js`, and `lib/context.js` differ in the experiment.

Preserving layout matters because the catalogue's enumeration order differs
from constructor order. In addition, `preParsing` and `preValidation` do not
exist on a newly constructed context: route and 404 initialization append
them during boot. The candidate preserves that timing, property insertion
order, property descriptors, and independent hook arrays.

Tests cover the initial context hook block and the final route/404 property
order, alongside registration, inheritance, binding, shutdown, and error
behavior. The candidate passes these checks. A local V8 diagnostic also found
fast properties and consistent maps between repeated instances within each
variant. This does not establish identical hidden classes between variants
or across Node.js releases.

## Method

The [benchmark](../../examples/benchmark/hook-initialization.js) runs each
workload and variant in a fresh Node.js process. It alternates variant and
workload order between rounds. There are no simultaneous benchmark workers.
Results include all samples, medians, interquartile ranges, and paired
percentage changes; a positive change means more time per operation.

The confirmation run uses nine rounds on Node.js v25.6.1, V8
14.1.146.11-node.19, macOS Darwin 25.3.0, arm64, on an Apple M2. Both variants
share one installed dependency tree. No tests or lint tasks run concurrently
with that confirmation pass.

| Workload | Timed operation | Warm-up and sample size per process |
| --- | --- | --- |
| `load-and-ready` | Load Fastify, construct an empty instance, and await `ready()` | One fresh load; Node process launch is excluded |
| `hooks` | Construct `Hooks` | 20,000 warm-ups, then 200,000 allocations |
| `build-hooks` | Clone populated parent hook storage | 20,000 warm-ups, then 200,000 allocations |
| `context` | Construct `Context` with a prepared server/options object | 20,000 warm-ups, then 200,000 allocations |
| `ready` | Construct and boot an empty instance | 10 warm-ups, then 40 instances |
| `routes` | Construct, register 200 POST routes, and boot | 10 warm-ups, then 40 instances |
| `plugins` | Construct and boot 60 plugins: 20 branches, three levels each, with inherited and local request hooks | 10 warm-ups, then 40 instances |
| `plugin-routes` | The same plugin tree, with two POST routes per plugin | 10 warm-ups, then 40 instances |
| `inject` | Inject a POST request, rotating across 20 plugin routes | 500 warm-ups, then 2,000 sequential requests |

Shutdown is outside timed intervals. Warm workloads force GC before their
measured batch; subsequent allocation and GC costs remain included. The
constructor workloads retain 128 objects at a time and consume their property
counts after measurement to keep allocation results observable.

Plugin registration includes boot because plugin bodies and deferred hook
registration execute there. Measuring only calls to `register()` would omit
most of the work under study. Injection is a request-path regression check;
it does not measure network throughput or production tail latency.

An initial exploratory run agreed on the constructor penalties. Its first
round overlapped a short compatibility-test run, so only the isolated
confirmation run is retained as the reported measurement.

## Results

The raw confirmation samples are in
[Hook-Initialization-results.json](Hook-Initialization-results.json).

These are medians across the nine processes for each workload and variant.
The change column compares those medians; paired changes and all individual
samples are retained separately in the JSON report.

| Workload | Explicit constructors | Catalogue loops | Change in median time |
| --- | --- | --- | --- |
| `load-and-ready` | 52.838 ms | 52.745 ms | -0.2% |
| `hooks` | 40.6 ns | 256.1 ns | +530.2% |
| `build-hooks` | 373.6 ns | 594.1 ns | +59.0% |
| `context` | 80.1 ns | 216.3 ns | +170.0% |
| `ready` | 0.266 ms | 0.270 ms | +1.5% |
| `routes` | 2.841 ms | 2.878 ms | +1.3% |
| `plugins` | 2.654 ms | 2.696 ms | +1.6% |
| `plugin-routes` | 5.059 ms | 4.949 ms | -2.2% |
| `inject` | 19.6 µs | 19.5 µs | -0.7% |

The constructor penalty is consistent across every paired round: `Hooks`
takes roughly 6.3 times as long and `Context` roughly 2.7 times as long.
Cloning hook storage also costs about 59% more. These are small absolute
costs, not sixfold or threefold slowdowns of an entire application.

End-to-end interquartile ranges overlap in most workloads, and there are
outliers even in the isolated run. For example, the paired request-injection
changes range from -38% to +62%. The small changes in those workload medians
do not establish a reliable application-level speedup or regression.

## Consequences and alternatives

The candidate removes explicit property assignments but needs layout metadata
to preserve the existing contract. That shifts maintenance into order fields
and handling boot-only slots, while imposing runtime assignment costs. There
is insufficient benefit to adopt it.

The retained design uses the catalogue for hook policy, explicit constructors
for predictable initialization, and consistency/layout tests to catch drift.
Adding a built-in hook still requires updating its storage and context
integration, as documented in the design proposal.

Build-time generation of explicit assignments could avoid dynamic assignment
costs. It would also add a generator, generated sections, layout metadata, and
an integrity check to the contribution workflow. This is an unimplemented
alternative to reconsider if constructor drift becomes a recurring problem.
Runtime code generation is not needed for this design.

The measurements are local, synthetic observations from one Node.js version
and machine. Small end-to-end differences can be noise; they are not release
performance guarantees. Any future constructor change should repeat the
comparison on supported Node.js versions and relevant application workloads.

## Reproduction

From the repository root, with dependencies installed, create isolated copies
of the current implementation and apply the experimental patch to one:

```sh
repo_dir="$PWD"
study_dir=$(mktemp -d)
mkdir "$study_dir/baseline"
cp fastify.js package.json "$study_dir/baseline/"
cp -R lib "$study_dir/baseline/lib"
ln -s "$repo_dir/node_modules" "$study_dir/baseline/node_modules"
cp -RP "$study_dir/baseline" "$study_dir/candidate"
git -C "$study_dir/candidate" apply \
  "$repo_dir/docs/Design/Hook-Initialization-candidate.patch"
node examples/benchmark/hook-initialization.js \
  --baseline "$study_dir/baseline" \
  --candidate "$study_dir/candidate" > "$study_dir/results.json"
```

Keep other CPU-intensive tasks idle. Progress is written to stderr; stdout
contains the JSON report. To measure just the current implementation, run:

```sh
node examples/benchmark/hook-initialization.js > baseline-results.json
```

For other workload sizes, set `--rounds`, `--iterations`, `--allocations`, or
`--requests`. The candidate patch targets the current constructor layout;
if it no longer applies, review and update the experiment before measuring.
Do not treat this benchmark as a deterministic CI pass/fail threshold.
