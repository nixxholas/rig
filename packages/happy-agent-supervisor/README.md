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

Egress with a non-empty `allowedHosts` currently fails closed. Phase 2 will
provide the managed CONNECT bridge needed to enforce hostname filtering
without direct network bypass or TLS interception. A host list with egress
disabled is already enforced by the isolated network namespace.

## Binary resolution

`resolveSupervisorBinary()` selects the current host binary.
`resolveLinuxSupervisorBinary(architecture)` selects Linux `x64` or `arm64`
independently of the host, for read-only mounting into a container.

The package script emits four npm variants:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `aarch64-unknown-linux-musl`
- `x86_64-unknown-linux-musl`
