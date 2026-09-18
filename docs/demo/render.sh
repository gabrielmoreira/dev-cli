#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if ! command -v docker >/dev/null 2>&1; then
  docker_desktop_bin="/Applications/Docker.app/Contents/Resources/bin"
  if [[ -x "$docker_desktop_bin/docker" ]]; then
    export PATH="$docker_desktop_bin:$PATH"
  fi
fi

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required to render docs/demo.tape.\n' >&2
  exit 1
}
command -v vhs >/dev/null 2>&1 || {
  printf 'VHS is required to render docs/demo.tape. Run mise install.\n' >&2
  exit 1
}

cd "$repo_root"
mkdir -p docs/assets
build_args=(--file docs/demo/Dockerfile --tag dev-cli-demo:local)
ca_file="${SSL_CERT_FILE:-${NODE_EXTRA_CA_CERTS:-}}"
if [[ -f "$ca_file" ]]; then
  build_args+=(--secret "id=extra_ca,src=$ca_file")
fi
if [[ -n "${NPM_CONFIG_REGISTRY:-}" ]]; then
  build_args+=(--secret id=npm_registry,env=NPM_CONFIG_REGISTRY)
fi
docker build "${build_args[@]}" .
rm -f docs/assets/dev-cli-demo.gif
vhs docs/demo.tape
if [[ ! -s docs/assets/dev-cli-demo.gif ]]; then
  printf 'VHS completed without writing docs/assets/dev-cli-demo.gif.\n' >&2
  exit 1
fi
