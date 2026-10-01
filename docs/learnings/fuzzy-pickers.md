# Rank search selections with a subsequence scorer

## Decision

Every search select and multi-select uses the shared subsequence fuzzy scorer to filter and rank choices. It matches against labels and values, rewards prefixes, word starts, and adjacent characters, and penalizes gaps. Keep the scorer in the existing UI module.

## Rejected alternative

Adding a fuzzy-search dependency introduces another package for behavior the shared scorer already provides.
