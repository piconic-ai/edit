#!/usr/bin/env bash
set -euo pipefail

version=${1:?Usage: build-cli-release.sh VERSION OUTPUT_DIRECTORY}
output=${2:?Usage: build-cli-release.sh VERSION OUTPUT_DIRECTORY}
mkdir -p "$output"
output=$(cd "$output" && pwd)
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

for target in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  os=${target%/*}
  arch=${target#*/}
  name="pedit_${version}_${os}_${arch}"
  package="$staging/$name"
  mkdir -p "$package"
  binary=pedit
  if [[ "$os" == windows ]]; then binary=pedit.exe; fi
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 go build \
    -trimpath -ldflags "-s -w -X main.version=$version" \
    -o "$package/$binary" ./cmd/pedit
  cp LICENSE "$package/LICENSE"
  if [[ "$os" == windows ]]; then
    (cd "$package" && zip -q "$output/$name.zip" "$binary" LICENSE)
  else
    tar -czf "$output/$name.tar.gz" -C "$package" "$binary" LICENSE
  fi
done

(cd "$output" && sha256sum pedit_*.tar.gz pedit_*.zip > checksums.txt)
