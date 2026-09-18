#!/usr/bin/env zsh
set -euo pipefail

export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z"
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
git config --global user.name "dev demo"
git config --global user.email "demo@example.com"
git config --global init.defaultBranch main

mkdir -p /demo/remotes /demo/seeds /demo/dev

seed_repository() {
  local name="$1"
  local title="$2"
  local body="$3"
  local seed="/demo/seeds/$name"
  local remote="/demo/remotes/$name.git"

  git init --quiet --bare --initial-branch=main "$remote"
  git init --quiet --initial-branch=main "$seed"
  printf '# %s\n\n%s\n' "$title" "$body" > "$seed/README.md"
  git -C "$seed" add README.md
  git -C "$seed" commit --quiet --message "docs: add $name guide"
  git -C "$seed" remote add origin "$remote"
  git -C "$seed" push --quiet --set-upstream origin main
}

seed_repository platform "Platform Operations" \
  "Release checklist: run verification, review the diff, publish the artifact, and confirm the installed version."
seed_repository handbook "Engineering Handbook" \
  "Workspace guidance: keep one task context, declare every repository, and resume from ws.md."

cat > /demo/dev/dev.yaml <<'YAML'
version: 1
label_defs:
  "index:demo": {}
defaults:
  sync_strategy: ff-only
  workspace_prefix: ws/
  canonical_prefix: mirrors/
sources:
  - url: /demo/remotes/platform.git
    branch: main
  - url: /demo/remotes/handbook.git
    branch: main
worksets:
  platform:
    description: Review a platform release with its operating guide
    members:
      - source: /demo/remotes/platform.git
        ref: main
        path: platform
        reason: Release implementation
      - source: /demo/remotes/handbook.git
        ref: main
        path: handbook
        reason: Operating guidance
plugins:
  qmd:
    command: qmd
    config_dir: scoped
YAML
if (( $# > 0 )); then
  exec "$@"
fi
exec zsh -df
