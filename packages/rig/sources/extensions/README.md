# Extensions

This module owns locally installed Rig extensions: finding their user-visible folders, validating
their manifests and icons, compiling their TypeScript against Rig's SDK, running each extension in
the existing command sandbox, and serving the private API socket it uses.

```text
~/Happy/Extensions/<folder>          (Linux: ~/happy/extensions)
  |
  +-- rig.plugin.json
  +-- icon.png
  +-- index.ts
  +-- .rig/
       +-- build/                    TypeScript output
       +-- node_modules/happy-plugins/ SDK shipped by this Rig
       +-- runtime/plugin.sock       per-extension API
       +-- extension.log             bounded current-run output
```

`ExtensionManager` is the daemon lifecycle boundary. Registration and compilation are separate
functions so a bad extension can be reported without preventing other extensions or the daemon
from starting.
