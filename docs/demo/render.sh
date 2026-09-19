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

if [[ -z "${OPENROUTER_API_KEY:-}" && -f "$repo_root/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == OPENROUTER_API_KEY=* ]]; then
      openrouter_key="${line#OPENROUTER_API_KEY=}"
      openrouter_key="${openrouter_key%$'\r'}"
      if [[ "$openrouter_key" == \"*\" || "$openrouter_key" == \'*\' ]]; then
        openrouter_key="${openrouter_key:1:${#openrouter_key}-2}"
      fi
      export OPENROUTER_API_KEY="$openrouter_key"
      break
    fi
  done < "$repo_root/.env"
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  printf 'OPENROUTER_API_KEY is required in the environment or ignored .env file.\n' >&2
  exit 1
fi

cd "$repo_root"
mkdir -p docs/assets
build_args=(--file docs/demo/Dockerfile --tag dev-cli-demo:local)
if [[ -n "${DEV_VERSION:-}" ]]; then
  build_args+=(--build-arg "DEV_VERSION=$DEV_VERSION")
fi
ca_file="${SSL_CERT_FILE:-${NODE_EXTRA_CA_CERTS:-}}"
if [[ -f "$ca_file" ]]; then
  build_args+=(--secret "id=extra_ca,src=$ca_file")
fi
if [[ -n "${NPM_CONFIG_REGISTRY:-}" ]]; then
  build_args+=(--secret id=npm_registry,env=NPM_CONFIG_REGISTRY)
fi
docker build "${build_args[@]}" .
rm -f docs/assets/dev-cli-demo.gif docs/assets/dev-cli-demo.mp4
vhs_status=0
vhs docs/demo.tape || vhs_status=$?
if (( vhs_status != 0 && vhs_status != 143 )); then
  exit "$vhs_status"
fi
for demo_output in docs/assets/dev-cli-demo.gif docs/assets/dev-cli-demo.mp4; do
  if [[ ! -s "$demo_output" ]]; then
    printf 'VHS completed without writing %s.\n' "$demo_output" >&2
    exit 1
  fi
done
