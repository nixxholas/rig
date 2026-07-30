# Model catalog

This module constructs Rig's local inference-model catalog and resolves the
provider for a selected model. The catalog is curated in source through the
configured executor providers; it never discovers or fetches models from a
provider API.

```
configuration + local credentials
              |
              v
createModelCatalog
              |
              v
ModelCatalog
   |                    |
   v                    v
session selection   protocol catalog
```

`createModelCatalog` reports configured providers that are unavailable, but
only offers models from locally authenticated, enabled providers. Provider IDs
use Rig's canonical keys such as `codex`, `claude`, and `grok`.

The remaining top-level functions resolve provider IDs for a model and remove
duplicate model IDs. Each ID keeps its first position in the catalog while the
last available provider's model metadata wins.
