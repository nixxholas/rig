# Model catalog tests

These tests cover the public catalog builder.

```
local configuration + environment
              |
              v
createModelCatalog
              |
              v
catalog providers, defaults, and availability errors
```

The cases use explicit environment maps so they never depend on credentials
from the machine running the tests.
