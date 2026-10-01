# Keep a broken manifest from stopping the workspace list

## Decision

Reject a non-array `mounts` value in `ws.md` with `INVALID_MANIFEST`. When `dev ls` encounters an invalid manifest, keep that workspace in the listing with a per-entry `error` and continue listing the others. Do not silently turn invalid mount data into an empty workspace.

## Rejected alternative

Rethrowing the manifest error from the listing lets one broken file stop `dev ls` and `dev go` for every workspace.
