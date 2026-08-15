# Happy Agent Supervisor

`@slopus/happy-agent-supervisor` is the small trusted native boundary used to
launch agent workloads without an intermediary shell.

```text
caller
  │ policy JSON on fd or file
  │ argv after --
  ▼
supervisor
  ├─ Linux: user + mount + PID namespaces, private procfs, mount policy,
  │          seccomp, zero capabilities, no_new_privs
  └─ macOS: in-process Seatbelt profile
  ▼
execve(target, argv, inherited environment)
```

## Invocation

Pass policy out of argv and pass the command as an argument vector:

```sh
happy-agent-supervisor --policy-fd 3 -- /bin/sh -c 'printf "%s\n" "$VALUE"'
happy-agent-supervisor --policy-file /trusted/policy.json -- /usr/bin/env
```

The supervisor consumes the policy descriptor. Descriptors `0`, `1`, and `2`
are rejected. Policy files are read and closed before sandbox setup. Policy
JSON is limited to 1 MiB and rejects unknown fields.

The policy names match `ComputePermissions`:

```json
{
    "mode": "workspace_write",
    "allowedReadPaths": [],
    "deniedReadPaths": [],
    "allowedWritePaths": [],
    "deniedWritePaths": [],
    "network": {
        "egress": true,
        "allowedHosts": [],
        "localBinding": false
    }
}
```

For `workspace_write` and `auto`, the process working directory is the
workspace write root. Denials win over grants. Linux write-denied paths and
writable roots must already exist so the supervisor never creates a
user-visible mount point while privileged.

## Outgoing proxy

Filtered egress is asked for by adding `network.outgoingProxy`, which names only
the front-ends to offer inside the sandbox:

```json
{
    "network": {
        "egress": true,
        "allowedHosts": ["example.com", "*.internal.example.com"],
        "localBinding": false,
        "outgoingProxy": { "frontEnds": ["http", "socks5"] }
    }
}
```

The supervisor provides the whole proxy. It forks an egress process before the
sandbox exists and joins the two with a socketpair, so the caller supplies no
descriptor and no token, and nothing inside the sandbox reaches the proxy — or
anything else — by address. The workload is given ordinary `HTTP_PROXY` and
`ALL_PROXY` addresses on loopback, carrying a secret generated for that one
invocation; both front-ends refuse a client that does not present it, as HTTP
Basic and as RFC 1929 respectively.

The egress process decides every destination. The requested name must match one
`allowedHosts` entry exactly or under one `*.suffix`, and the address that name
actually resolved to must not be loopback, private, link-local, or multicast
unless the policy named that IP literal directly. A bare `*` is refused: open
egress is expressed by configuring no proxy at all, and an empty list with a
proxy configured reaches nothing.

Egress with a non-empty `allowedHosts` and no proxy fails closed, because nothing
would be enforcing the list. A host list with egress disabled is already enforced
by the isolated network namespace. No TLS is terminated anywhere, so the boundary
is which host may be reached rather than what is sent to it.

## Binary resolution

`resolveSupervisorBinary()` selects the current host binary.
`resolveLinuxSupervisorBinary(architecture)` selects Linux `x64` or `arm64`
independently of the host, for read-only mounting into a container.

The package script emits four npm variants:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `aarch64-unknown-linux-musl`
- `x86_64-unknown-linux-musl`
