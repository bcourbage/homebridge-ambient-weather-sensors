# Dependency security

CI and the release workflow audit the locked production and development
dependency tree after `npm ci`:

```sh
npm audit --include=dev --audit-level=high
```

High and critical findings block both workflows. The threshold changes the
exit status, not the report: low and moderate findings remain visible in the
job output and require triage. Build tools are included because they execute
while producing the published artifacts. A clean production-only audit does
not replace this check.

## Triage

Before a release, review the full audit report, including findings below the
blocking threshold. Track each unresolved advisory in an issue, or update its
existing issue, with:

- The advisory link, affected package and installed version, and severity.
- Whether it affects the installed plugin, the build or test environment, or
  both, and the relevant exploit conditions.
- The remediation or mitigation, an owner, and a target release or review date.
- The release decision and its rationale if remediation is deferred.

Severity is an automated minimum, not permission to ship a demonstrated
exploit. A reachable vulnerability or credible artifact-integrity risk can
block a release at any severity. High and critical findings must be remediated
before the gate passes; lower-severity deferrals must be explicitly recorded
and reconsidered when their review date or target release arrives.

## Remediation and verification

Prefer a supported dependency update. If an upstream dependency pins a
vulnerable transitive package, a narrowly scoped override may be used after
checking compatibility and documenting why it is needed. Do not lower the
threshold or ignore a failed audit to get a particular release through. npm
audit has no native per-advisory ignore, so the issue tracker records triage;
it is not a suppression list.

Keep audits read-only in CI and release. Do not run `npm audit fix` there or
change the dependency tree after verification. Dependency changes belong in
a reviewed change with a regenerated lockfile and the full gates: lint,
plugin/UI builds, cold app build and determinism, tests, and `verify:package`.
Check the actual resolved versions and audit the resulting tree again. For a
release candidate, also audit a fresh production-only install of its exact
tarball; consumer resolution can differ from the development lockfile.

An unavailable audit service or other command failure is not a clean report.
Leave the gate failed, investigate, and rerun it when the service recovers.
