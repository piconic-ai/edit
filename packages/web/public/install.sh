#!/bin/sh
# Install pedit from GitHub Releases:
#
#   curl -fsSL https://edit.piconic.ai/install.sh | sh
#
# PEDIT_VERSION     release tag to install (default: the latest release)
# PEDIT_INSTALL_DIR where to put the binary (default: ~/.local/bin)
#
# It never uses sudo and never edits shell profiles. Everything runs from
# main(), called on the last line, so a truncated download does nothing.
set -eu

repo=piconic-ai/edit

fail() {
  echo "pedit install: $*" >&2
  exit 1
}

detect_target() {
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "unsupported OS $(uname -s); download a binary from https://github.com/$repo/releases" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported architecture $(uname -m); download a binary from https://github.com/$repo/releases" ;;
  esac
}

latest_version() {
  # /releases/latest redirects to /releases/tag/<tag>; this avoids the API rate limit.
  url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") ||
    fail "could not look up the latest release"
  case ${url##*/} in
    v*) echo "${url##*/}" ;;
    *) fail "could not find the latest release at $url" ;;
  esac
}

verify_checksum() {
  # $1: directory holding the archive and checksums.txt, $2: archive name
  grep "  $2\$" "$1/checksums.txt" >"$1/expected.txt" || fail "$2 is not listed in checksums.txt"
  if command -v sha256sum >/dev/null 2>&1; then
    sum="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sum="shasum -a 256"
  else
    fail "neither sha256sum nor shasum is available to verify the download"
  fi
  (cd "$1" && $sum -c expected.txt >/dev/null 2>&1) || fail "checksum mismatch for $2"
}

main() {
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  detect_target
  version=${PEDIT_VERSION:-}
  [ -n "$version" ] || version=$(latest_version)
  install_dir=${PEDIT_INSTALL_DIR:-$HOME/.local/bin}
  # PEDIT_DOWNLOAD_URL replaces GitHub in tests (scripts/test-install.sh).
  base=${PEDIT_DOWNLOAD_URL:-https://github.com/$repo/releases/download/$version}
  archive="pedit_${version}_${os}_${arch}.tar.gz"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading pedit $version ($os/$arch)"
  curl -fsSL -o "$tmp/$archive" "$base/$archive" || fail "could not download $base/$archive"
  curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt" || fail "could not download $base/checksums.txt"
  verify_checksum "$tmp" "$archive"

  tar -xzf "$tmp/$archive" -C "$tmp" pedit
  mkdir -p "$install_dir"
  cp "$tmp/pedit" "$install_dir/pedit"
  chmod 755 "$install_dir/pedit"
  echo "Installed pedit $version to $install_dir/pedit"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) echo "Add $install_dir to your PATH to run pedit, for example: export PATH=\"$install_dir:\$PATH\"" ;;
  esac
}

main "$@"
