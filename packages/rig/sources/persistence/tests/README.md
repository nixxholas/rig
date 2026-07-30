# Persistence tests

These tests cover persistence boundaries shared by more than one domain. They execute against
isolated SQLite databases and verify transaction and database-failure behavior.

```text
shared persistence test
          |
          v
   TX / inTx / classifier
          |
          v
        SQLite
```

Domain-specific persistence tests stay with their corresponding domain directory.
