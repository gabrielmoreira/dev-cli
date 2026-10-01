# D8: Keep the embedded plugin and its hooks

## Decision

Keep the embedded qmd plugin with its own `plugins.qmd` configuration and a configuration directory scoped to the root by default. Register `qmdFactory` in `builtinFactories`. Its hooks run only for roots with `index:*` labels: mirror sync updates the index, and label changes reconcile collections from existing mirrors without embedding. Use the word "plugin" for the types, configuration, and public vocabulary. [Q1 records external plugin loading](q1-external-plugins.md).

## Rejected alternative

Deleting the event system removes the hooks required by the embedded plugin.
