# Master plan 19: onboarding

## Big picture

Happy must be able to determine whether the local Rig is ready to use and, when
it is not, show the one onboarding action required next. Rig owns the durable
onboarding state, and `rig-connect` exposes the resulting status to the desktop
application.

Onboarding proves that each requirement worked once. It is not continuous
health monitoring. In particular, provider inference is verified with a real
request during onboarding and the success is remembered. If that provider
breaks later, Rig remains onboarded.

The required profile is the same human profile used for P2P message identity,
not a separate account or Rig login. It has a stable identity, a required name
and email, and an optional avatar.

## Status surface

There are two related paths.

The fast path answers whether onboarding is complete for the current onboarding
version. After the desktop application has connected to the local daemon, this
path reads only durable local state. It performs no provider requests and no
other network work. When the current version is marked complete, the application
can become ready immediately.

When the fast path is not complete, the detailed path returns one current
onboarding state as an enum with the data needed to render and complete that
step. The states cover:

- Rig is unavailable, including whether it is not installed, not running, or
  cannot be connected to.
- Happy and Rig are incompatible, including which one must be upgraded.
- No provider is configured.
- Providers are being verified, including visible progress and status for the
  providers being tried.
- A profile is required.
- Onboarding is complete.

The connection and compatibility states exist before daemon-owned onboarding
state can be read. Once a compatible connection exists, Rig is authoritative
for every remaining state.

## Ordered flow

First, determine whether Rig is installed, running, and reachable. If it is not,
return the appropriate availability state instead of attempting later checks.

Second, establish a compatible connection. If the Rig and Happy versions do not
work together, return a version-mismatch state that says whether Rig or Happy
must be upgraded.

Third, check whether any providers are configured. If none are available,
onboarding stops at provider setup.

Fourth, verify provider inference with a real request and show progress while
the configured providers are being tried. Onboarding may continue as soon as at
least one provider has successfully performed inference. That successful
verification is persisted and is not repeated during ordinary startup.

Fifth, require the person to complete their profile with a name and email. An
avatar may be added but is optional. The profile step cannot be skipped.

Finally, mark onboarding complete for the current onboarding version.

## State and versioning

Rig persists the facts that cannot be derived cheaply, including successful
provider verification. Profile completion is derived from the stored profile.
A versioned completion marker provides the fast startup path.

The onboarding process has a version. Adding or changing a required onboarding
step advances that version and makes the previous completion marker insufficient.
On the next application start, the detailed status path evaluates the current
requirements and presents any newly missing screens. Once every requirement for
the new version is satisfied, Rig records that version as complete.

A completed marker for the current version means the application skips the
entire detailed onboarding flow after connecting to the local daemon. No
provider or internet check belongs on that startup path.

## What done looks like

- Happy can show whether Rig must be installed, started, connected, or upgraded,
  and a version mismatch identifies which application needs the upgrade.
- After connection, one detailed status identifies exactly one next onboarding
  step and carries the data needed to render it.
- Provider verification shows progress and proves that at least one configured
  provider can perform real inference.
- A successful provider verification is durable; later provider failure does
  not reopen onboarding.
- Onboarding cannot complete without a stored profile containing a name and
  email; the avatar remains optional.
- A completed onboarding version is read locally and quickly, without internet
  access or repeated inference.
- A future onboarding-version change returns an existing installation to the
  flow only for requirements that are not yet satisfied.
