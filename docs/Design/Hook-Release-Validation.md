# Hook warning transition: release validation

Run date: 2026-09-30. Core CI passed every Node/OS combination. The plugin
suite passed 50 of 51 packages; Swagger's sole runtime failure reproduced on
unchanged Fastify using the same plugin commit and Node version. No new failure
was identified by these runs. Subsequent [application validation](Hook-Application-Validation.md)
provides a test-fixture correction and complete passing Swagger runs on both
builds. The original unmodified plugin run remains red; the correction still
needs upstream adoption or maintainer disposition before release approval.

## Tested revisions

- Candidate: `c727fe8b158558332ab49bbca5c337797a57f433`.
- Unchanged base: `8b9c07b645a8156c23a1d2619267fc84ea879250`.
- [Candidate branch](https://github.com/franck-meyer/fastify/tree/codex/hook-warning-transition-20260930).
- [Machine-readable results](Hook-Release-Validation-results.json) record job
  links, resolved Node versions, plugin commits, and test totals.

The candidate is a committed snapshot of the hook catalogue, warning
transition, tests, and documentation. It was tested in a fork using the
repository's existing workflows with manual dispatch. No production-code
changes were needed during validation. This report was added afterward.

## Core CI

[Core CI run](https://github.com/franck-meyer/fastify/actions/runs/36779963424)
completed successfully in approximately six minutes.

| Node version resolved by CI | Linux | Windows | macOS |
| --- | --- | --- | --- |
| 20.20.2 | Pass | Pass | Pass |
| 22.23.3 | Pass | Pass | Pass |
| 24.21.0 | Pass | Pass | Pass |
| 26.10.0 | Pass | Pass | Pass |

Every matrix job reported zero failed runtime tests. Existing platform/version
conditions skipped three to six tests per job; the result file preserves each
job's counts.

Additional checks passed:

- Linux and Windows coverage, each reporting 100% line coverage.
- ESLint and license checks.
- TypeScript: 1,278 assertions on Node 20.
- Pino 9 and 10 compatibility, including runtime and type tests.
- Webpack and esbuild packaging tests.
- The extra Node 24/Linux job created by manual dispatch.

The workflow recorded 21 successful jobs. PR dependency review and automatic
merging were inapplicable to this manual run and were skipped.

## Plugin compatibility

[Plugin suite](https://github.com/franck-meyer/fastify/actions/runs/36779964527):
50 packages passed and one failed on Node 24.21.0, `ubuntu-latest`.
Each job linked the candidate Fastify checkout into the plugin's source tree
and ran that plugin's `npm test`, as configured by `citgm-package.yml`.

No `FSTDEP023` warnings were observed in the 51 plugin job logs. This is
evidence about the executed tests, not every application or plugin code path.
The configured suite excludes several plugins and does not cover all Node/OS
combinations. Plugin source revisions came from their default branches; their
resolved commit hashes are recorded in the result file.

### Swagger failure and baseline comparison

The failing test is `route options - QUERY method (OpenAPI 3.2.0)` in
`test/spec/openapi/route.test.js`. It attempts to register the HTTP `QUERY`
method and receives `FST_ERR_ROUTE_METHOD_NOT_SUPPORTED`.

| Input/result | Candidate | Unchanged base |
| --- | --- | --- |
| Fastify commit | `c727fe8b158558332ab49bbca5c337797a57f433` | `8b9c07b645a8156c23a1d2619267fc84ea879250` |
| Swagger commit | `f3ecd6365bd39da545b1537daa5b1956a09368ce` | Same |
| Node / OS | 24.21.0 / `ubuntu-latest` | Same |
| Runtime tests | 298 | 298 |
| Passed / failed | 297 / 1 | 297 / 1 |
| Failure | `QUERY method is not supported.` | Same |

[Candidate job](https://github.com/franck-meyer/fastify/actions/runs/36779964527/job/110107475072)
and [baseline run](https://github.com/franck-meyer/fastify/actions/runs/36780297429)
provide the logs. The checked-out plugin SHA and resolved Node version were
verified to match. This demonstrates that the observed failure predates the
hook changes; it does not turn the failed plugin run into a pass. Any checks
after the failing runtime command were not reached.

## Remaining release work

- Adopt the tested Swagger fixture correction or obtain the project's
  disposition for the baseline failure. The [follow-up report](Hook-Application-Validation.md)
  records the complete passing suites with that correction.
- Run an actual deployment trial. Constructed application fixtures now cover
  conditional loading, warning policies, startup volume, traffic, and cleanup;
  private application configuration and infrastructure remain untested.
- Revalidate any subsequent production-code changes against the release
  candidate. Strict single-hook enforcement remains a separate major-release
  decision.

These results support compatibility of the warning transition within the
tested scope. They are not a release approval or proof of zero ecosystem risk.
