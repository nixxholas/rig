# Workspace file search — learnings

## Native search starts only when it is needed

Loading the FFF native binding while composing the daemon put optional autocomplete work on the
workspace-startup critical path. The module now imports FFF lazily on its first search. Later
requests reuse the loaded binding and a bounded set of watched workspace indexes.

## Search belongs to the selected physical workspace

The API resolves a project or child-workspace resource through `ProjectFilesModule` first, then
hands that canonical root to this module. The search index never derives another path, so a child
workspace searches its own checkout rather than the root project's files.
