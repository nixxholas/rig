# Config module

`ConfigModule` is the first module loaded by a Happy Agent host. It resolves
one `.happy` root, reads the global, project, and private runtime TOML layers,
and exposes one deeply frozen snapshot.

```text
<parent>/
├── .happy/
│   └── agent/
│       ├── agent.sqlite
│       └── runtime.toml
└── Happy/
    └── Config/
        ├── happy.toml
        ├── AGENTS.md
        └── SECURITY.md
```

The project layer is `rig.toml`, with `happy.toml` as a fallback, in the
current working directory. Project machine settings (credentials, provider
selection, daemon settings, permission mode, and observation) are filtered
before merging. Precedence is global → project → runtime.

Missing files are valid and use bounded defaults. `happy.toml` uses the Rig
spelling; resolved values use ergonomic camelCase names such as `modelId`,
`providerId`, `permissionMode`, `compactCompletedTurns`, and
`serviceTier`. The resolved snapshot includes all Rig-shaped sections:
providers, MCP servers, Docker, network, observation, permissions, P2P,
presence, sharing, theme, features, workspace sync/protection, and retention
settings.

`[observation]` decides what the agent records about itself, and is read only
from the global and runtime layers. A checked-in project file that turned
tracing on and named its own endpoint would send this machine's traces
wherever the repository asked, so the section is dropped from that layer along
with the other machine settings. See
[`../observation/README.md`](../observation/README.md).

`[sharing]` turns Murmur on and names the relay it reaches. It is off by
default: an installation should not acquire an identity that reaches a relay
and accepts contact requests unless someone said so. Like `[observation]` it is
read only from the global and runtime layers, because a checked-in project file
that turned sharing on and named its own relay would give this machine an
identity, and a place to reach, that nobody here asked for. See
[`../murmur/README.md`](../murmur/README.md).

Unknown TOML keys are ignored and retained in each source's `unknownSettings`
list. `unknownSettingsTruncated` explicitly reports bounded metadata.
Malformed TOML, invalid known values, inconsistent provider types, oversized
files, and unbounded tables fail loading.
