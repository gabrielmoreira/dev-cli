#!/usr/bin/env zsh
set -euo pipefail

export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z"
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
git config --global user.name "dev demo"
git config --global user.email "demo@example.com"
git config --global init.defaultBranch main

mkdir -p "$HOME/.omp/agent"
printf 'setupVersion: 2\n' > "$HOME/.omp/agent/config.yml"

mkdir -p /demo/remotes /demo/seeds "$HOME/dev/.dev/cache/inventory/demo"

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

seed_omp_docs() {
  local seed="/demo/seeds/omp-docs"
  local remote="/demo/remotes/omp-docs.git"

  git init --quiet --bare --initial-branch=main "$remote"
  git init --quiet --initial-branch=main "$seed"
  mkdir -p "$seed/docs"
  cp "$HOME/.cache/omp-docs/models.md" "$seed/docs/models.md"
  cp "$HOME/.cache/omp-docs/providers.md" "$seed/docs/providers.md"
  printf '# OMP Documentation\n\nPinned model and provider documentation for OMP 18.2.6.\n' > "$seed/README.md"
  git -C "$seed" add README.md docs
  git -C "$seed" commit --quiet --message "docs: add pinned OMP model guides"
  git -C "$seed" remote add origin "$remote"
  git -C "$seed" push --quiet --set-upstream origin main
}

seed_skills() {
  local seed="/demo/seeds/skills"
  local remote="/demo/remotes/skills.git"

  git init --quiet --bare --initial-branch=main "$remote"
  git init --quiet --initial-branch=main "$seed"
  mkdir -p "$seed/skills/debugging-by-evidence"
  cp "$HOME/.cache/skills/skills/debugging-by-evidence/SKILL.md" \
    "$seed/skills/debugging-by-evidence/SKILL.md"
  printf '# Agent Skills\n\nPinned evidence-driven debugging skill for the demo.\n' > "$seed/README.md"
  git -C "$seed" add README.md skills
  git -C "$seed" commit --quiet --message "docs: add debugging skill"
  git -C "$seed" remote add origin "$remote"
  git -C "$seed" push --quiet --set-upstream origin main
}

seed_repository checkout-api "Checkout API" \
  "The checkout endpoint times out two or three times a day, but current traces do not establish whether the fault is in application code, the payment provider, or the network. There is no reliable local reproduction. The team also wants workspace-scoped OMP through OpenRouter free models only, with no paid fallback."
seed_omp_docs
seed_skills

cat > "$HOME/dev/.dev/cache/inventory/demo/repos.jsonl" <<'JSONL'
{"id":"checkout-api","name":"checkout-api","url":"/demo/remotes/checkout-api.git","default_branch":"main","description":"Checkout service adopting OMP","last_changed":"2026-09-19T00:00:00Z","syncedAt":"2026-09-19T00:00:00Z"}
{"id":"omp-docs","name":"omp-docs","url":"/demo/remotes/omp-docs.git","default_branch":"main","description":"Pinned OMP 18.2.6 model and provider docs","last_changed":"2026-09-19T00:00:00Z","syncedAt":"2026-09-19T00:00:00Z"}
{"id":"gabrielmoreira-skills","name":"gabrielmoreira-skills","url":"/demo/remotes/skills.git","default_branch":"main","description":"Pinned evidence-driven debugging skill","last_changed":"2026-09-18T18:27:19Z","syncedAt":"2026-09-19T00:00:00Z"}
JSONL

if (( $# > 0 )); then
  exec "$@"
fi
exec zsh -d
