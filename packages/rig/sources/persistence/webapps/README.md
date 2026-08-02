# Webapp persistence

These operations store webapp identities and their versioned imports.

A webapp row carries the kebab-case name, description, purpose, author session, optional source
description, and which version is current. Each import is a `webapp_versions` row with its change
description. Creating a webapp writes the identity and its first version in one transaction, and
adding a version records the row and moves the current pointer in one transaction, so a webapp can
never exist without a version or point at a version that was not recorded.
