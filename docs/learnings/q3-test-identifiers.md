# Q3: Replace test identifiers without rewriting history

## Decision

Replace work-specific test identifiers with generic examples going forward. Keep existing Git history unchanged. New fixtures do not carry organization, person, host, or machine-specific names.

## Rejected alternative

Rewriting published history changes existing commits to remove old identifiers. The maintainer chooses forward-only replacement, not a history rewrite.
