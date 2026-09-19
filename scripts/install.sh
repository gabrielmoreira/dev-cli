#!/bin/sh
set -eu

VERSION="__DEV_VERSION__"
RELEASES_URL="${DEV_RELEASES_URL:-https://github.com/gabrielmoreira/dev-cli/releases}"
RELEASES_URL="${RELEASES_URL%/}"
TEMP_DIR=""
STAGED_BINARY=""

info() {
  printf 'dev installer: %s\n' "$*"
}

fail() {
  printf 'dev installer: error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
  if [ -n "$STAGED_BINARY" ]; then
    rm -f "$STAGED_BINARY"
  fi
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin\n' ;;
    Linux) printf 'linux\n' ;;
    *) fail "Unsupported operating system: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64 | aarch64) printf 'arm64\n' ;;
    x86_64 | amd64) printf 'x64\n' ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac
}

detect_libc() {
  if [ -n "${DEV_LIBC:-}" ]; then
    case "$DEV_LIBC" in
      glibc | musl) printf '%s\n' "$DEV_LIBC" ;;
      *) fail "DEV_LIBC must be glibc or musl" ;;
    esac
    return
  fi

  if [ -f /etc/alpine-release ] || (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then
    printf 'musl\n'
  else
    printf 'glibc\n'
  fi
}

select_asset() {
  os="$1"
  machine="$2"

  if [ "$os" = "linux" ] && [ "$(detect_libc)" = "musl" ]; then
    printf 'dev-linux-%s-musl.tar.gz\n' "$machine"
  else
    printf 'dev-%s-%s.tar.gz\n' "$os" "$machine"
  fi
}

resolve_install_dir() {
  if [ -n "${DEV_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$DEV_INSTALL_DIR"
  elif [ -n "${XDG_BIN_HOME:-}" ]; then
    printf '%s\n' "$XDG_BIN_HOME"
  elif [ -n "${HOME:-}" ]; then
    printf '%s/.local/bin\n' "$HOME"
  else
    fail "HOME, XDG_BIN_HOME, or DEV_INSTALL_DIR is required"
  fi
}

download() {
  url="$1"
  destination="$2"

  if command -v curl >/dev/null 2>&1; then
    case "$url" in
      https://*) curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --output "$destination" "$url" ;;
      *) curl --fail --silent --show-error --location --output "$destination" "$url" ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --output-document="$destination" "$url"
  else
    fail "curl or wget is required"
  fi
}

sha256() {
  file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{ print $NF }'
  else
    fail "SHA-256 verification requires sha256sum, shasum, or openssl"
  fi
}

verify_checksum() {
  archive="$1"
  checksums="$2"
  asset="$3"
  expected="$(awk -v name="$asset" '$2 == name { print $1; found = 1; exit } END { if (!found) exit 1 }' "$checksums")" ||
    fail "No checksum published for $asset"
  actual="$(sha256 "$archive")"

  [ "$actual" = "$expected" ] || fail "Checksum mismatch for $asset"
}

verify_binary() {
  binary="$1"
  chmod +x "$binary"
  reported="$("$binary" --version)" || fail "Downloaded binary could not be executed"
  [ "$reported" = "dev v$VERSION" ] ||
    fail "Downloaded binary reported '$reported', expected 'dev v$VERSION'"
}

install_binary() {
  binary="$1"
  install_dir="$2"
  destination="$install_dir/dev"

  mkdir -p "$install_dir"
  STAGED_BINARY="$install_dir/.dev.new.$$"
  cp "$binary" "$STAGED_BINARY"
  chmod +x "$STAGED_BINARY"
  mv -f "$STAGED_BINARY" "$destination"
  STAGED_BINARY=""
  info "Installed dev v$VERSION to $destination"
}

path_contains() {
  case ":${PATH:-}:" in
    *:"$1":*) return 0 ;;
    *) return 1 ;;
  esac
}

configure_path() {
  install_dir="$1"

  if path_contains "$install_dir"; then
    return
  fi

  if [ -n "${DEV_INSTALL_DIR:-}" ] || [ "${DEV_NO_MODIFY_PATH:-0}" = "1" ]; then
    info "Add $install_dir to PATH before running dev"
    return
  fi

  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) profile="$HOME/.bashrc" ;;
    fish) profile="$HOME/.config/fish/config.fish" ;;
    *) profile="$HOME/.profile" ;;
  esac

  mkdir -p "$(dirname "$profile")"
  if [ "$shell_name" = "fish" ]; then
    path_line="fish_add_path --global '$install_dir'"
  else
    path_line="export PATH='$install_dir':\"\$PATH\""
  fi

  if [ ! -f "$profile" ] || ! grep -Fqx "$path_line" "$profile"; then
    printf '\n# dev CLI\n%s\n' "$path_line" >>"$profile"
    info "Added $install_dir to PATH in $profile"
  fi
  info "Restart your shell, then run: dev init"
}

main() {
  require_command uname
  require_command mktemp
  require_command tar
  require_command awk

  os="$(detect_os)"
  machine="$(detect_arch)"
  asset="$(select_asset "$os" "$machine")"
  install_dir="$(resolve_install_dir)"
  release_url="$RELEASES_URL/download/v$VERSION"

  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dev-installer.XXXXXX")"
  archive="$TEMP_DIR/$asset"
  checksums="$TEMP_DIR/SHA256SUMS"
  extracted="$TEMP_DIR/extracted"
  mkdir -p "$extracted"

  info "Downloading dev v$VERSION ($os-$machine)"
  download "$release_url/$asset" "$archive"
  download "$release_url/SHA256SUMS" "$checksums"
  verify_checksum "$archive" "$checksums" "$asset"
  tar -xzf "$archive" -C "$extracted"
  [ -f "$extracted/dev" ] || fail "$asset does not contain dev"
  verify_binary "$extracted/dev"
  install_binary "$extracted/dev" "$install_dir"
  configure_path "$install_dir"
}

main "$@"
