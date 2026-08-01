# Plugins

This module owns locally installed Rig plugins: finding them, validating their manifests and icons,
compiling their TypeScript against Rig's SDK, running each plugin in the existing command sandbox,
and serving the private API socket it uses.

A plugin lives in two places. Its code and everything Rig generates for it stay in Rig's managed
home, out of the way. Everything the plugin writes while it runs goes to a folder a person can open.

```text
~/.happy/rig/plugins/<folder>             installed plugin, managed by Rig
  |
  +-- happy.plugin.json
  +-- icon.png
  +-- index.ts
  +-- .build/
       +-- build/                         TypeScript output
       +-- node_modules/happy-plugins/    SDK shipped by this Rig
       +-- plugin.log                     bounded current-run output

~/Happy/Plugins/<folder>                  the plugin's writable folder
  |                                       (Linux: ~/happy/plugins/<folder>)
  +-- .runtime/plugin.sock                per-plugin API socket
  +-- whatever the plugin keeps
```

The plugin process runs with its writable folder as the working directory and receives that path as
`HAPPY_PLUGIN_DIRECTORY`. The socket sits there too, because the sandbox that confines the plugin
allows writes only inside that folder.

`PluginManager` is the daemon lifecycle boundary. Registration and compilation are separate
functions so a bad plugin can be reported without preventing other plugins or the daemon
from starting.
