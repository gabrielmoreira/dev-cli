# Q1: Load configured external plugins

## Decision

Load external plugins from `plugins.<name>.module`, resolved relative to the root. The module default-exports a plugin factory. A load or factory failure produces one warning and does not block the command. [D8 records the embedded plugin and its hooks](d8-embedded-plugin.md).

## Rejected alternative

Deleting the comment that promises a loader leaves configured external plugins unloaded. Implement the loader rather than remove that promise.
