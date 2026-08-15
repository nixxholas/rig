# Applet persistence

These operations store applet identities and their versioned imports.

An applet row carries the kebab-case name, description, purpose, author session, optional source
description, and which version is current. Each import is a `applet_versions` row with its change
description. Creating an applet writes the identity and its first version in one transaction, and
adding a version records the row and moves the current pointer in one transaction, so an applet can
never exist without a version or point at a version that was not recorded.
