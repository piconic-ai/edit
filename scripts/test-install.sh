#!/usr/bin/env bash
# Run packages/web/public/install.sh against archives from build-cli-release.sh,
# served from a local directory instead of GitHub Releases.
set -euo pipefail

version=${1:?Usage: test-install.sh VERSION RELEASE_DIRECTORY}
release=${2:?Usage: test-install.sh VERSION RELEASE_DIRECTORY}
release=$(cd "$release" && pwd)
script="$(cd "$(dirname "$0")/.." && pwd)/packages/web/public/install.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# CI archives have no published attestation. Mock the verifier at the process
# boundary; production verification remains mandatory, including for file://.
mkdir "$work/tools"
export INSTALL_TEST_GH_LOG="$work/gh.log"
export INSTALL_TEST_TAR_LOG="$work/tar.log"
export INSTALL_TEST_REAL_TAR
INSTALL_TEST_REAL_TAR=$(command -v tar)
cat >"$work/tools/gh" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$INSTALL_TEST_GH_LOG"
[ "$#" -eq 8 ]
[ "$1" = attestation ] && [ "$2" = verify ] && [ -f "$3" ] || exit 99
[ "$4" = --repo ] && [ "$5" = piconic-ai/edit ] || exit 99
[ "$6" = --signer-workflow ] && [ "$7" = piconic-ai/edit/.github/workflows/tagpr.yml ] || exit 99
[ "$8" = --deny-self-hosted-runners ]
exit "${INSTALL_TEST_GH_EXIT:-0}"
SH
cat >"$work/tools/tar" <<'SH'
#!/bin/sh
echo invoked >>"$INSTALL_TEST_TAR_LOG"
exec "$INSTALL_TEST_REAL_TAR" "$@"
SH
chmod +x "$work/tools/gh" "$work/tools/tar"
export PATH="$work/tools:$PATH"

echo "--- requires GitHub CLI before downloading"
mkdir "$work/no-gh"
ln -s "$(command -v curl)" "$work/no-gh/curl"
if PATH="$work/no-gh" /bin/sh "$script" >"$work/missing.stdout" 2>"$work/missing.stderr"; then
  echo "install.sh accepted a missing GitHub CLI" >&2
  exit 1
fi
grep -q 'GitHub CLI (gh) is required' "$work/missing.stderr"
test ! -s "$work/missing.stdout"

echo "--- installs and verifies a release"
PEDIT_VERSION="$version" PEDIT_DOWNLOAD_URL="file://$release" PEDIT_INSTALL_DIR="$work/ok/bin" \
  sh "$script"
test "$("$work/ok/bin/pedit" --version)" = "$version"
test -s "$INSTALL_TEST_GH_LOG"

echo "--- refuses failed provenance verification before extraction or replacement"
for verifier_exit in 1 2 127; do
  mkdir -p "$work/rejected-$verifier_exit/bin"
  echo untouched >"$work/rejected-$verifier_exit/bin/pedit"
  : >"$INSTALL_TEST_TAR_LOG"
  if INSTALL_TEST_GH_EXIT="$verifier_exit" PEDIT_VERSION="$version" \
    PEDIT_DOWNLOAD_URL="file://$release" PEDIT_INSTALL_DIR="$work/rejected-$verifier_exit/bin" \
    sh "$script" >"$work/rejected.stdout" 2>"$work/rejected.stderr"; then
    echo "install.sh accepted failed provenance verification" >&2
    exit 1
  fi
  grep -q 'release provenance verification failed' "$work/rejected.stderr"
  test "$(cat "$work/rejected-$verifier_exit/bin/pedit")" = untouched
  test ! -s "$INSTALL_TEST_TAR_LOG"
  test -z "$(find "$work/rejected-$verifier_exit/bin" -name '.pedit.*')"
  if grep -q Installed "$work/rejected.stdout"; then
    echo "install.sh reported success after failed verification" >&2
    exit 1
  fi
done

echo "--- replaces a pedit that is running"
mkdir -p "$work/busy/bin"
cp "$(command -v sleep)" "$work/busy/bin/pedit"
"$work/busy/bin/pedit" 60 &
running=$!
PEDIT_VERSION="$version" PEDIT_DOWNLOAD_URL="file://$release" PEDIT_INSTALL_DIR="$work/busy/bin" \
  sh "$script"
kill "$running"
test "$("$work/busy/bin/pedit" --version)" = "$version"
test -z "$(find "$work/busy/bin" -name '.pedit.*')"

echo "--- leaves a file planted under a guessable staging name alone"
mkdir -p "$work/planted/bin"
echo untouched >"$work/planted/victim"
chmod 600 "$work/planted/victim"
# exec keeps the PID, so .pedit.$$ is the name the installer would see as $$.
PEDIT_VERSION="$version" PEDIT_DOWNLOAD_URL="file://$release" PEDIT_INSTALL_DIR="$work/planted/bin" \
  sh -c 'ln -s "$1" "$2/.pedit.$$" && exec sh "$3"' sh "$work/planted/victim" "$work/planted/bin" "$script"
test "$(cat "$work/planted/victim")" = untouched
test -n "$(find "$work/planted/victim" -perm 600)"
test "$("$work/planted/bin/pedit" --version)" = "$version"

echo "--- fails when the destination is a directory"
mkdir -p "$work/dir/bin/pedit"
if PEDIT_VERSION="$version" PEDIT_DOWNLOAD_URL="file://$release" PEDIT_INSTALL_DIR="$work/dir/bin" \
  sh "$script" >"$work/dir/stdout" 2>"$work/dir/stderr"; then
  echo "install.sh succeeded over a directory" >&2
  exit 1
fi
grep -q "is a directory" "$work/dir/stderr"
if grep -q Installed "$work/dir/stdout"; then
  echo "install.sh reported success over a directory" >&2
  exit 1
fi
test -d "$work/dir/bin/pedit"
test -z "$(ls -A "$work/dir/bin/pedit")"

echo "--- refuses an archive that does not match checksums.txt"
: >"$INSTALL_TEST_GH_LOG"
: >"$INSTALL_TEST_TAR_LOG"
mkdir "$work/bad"
cp "$release"/* "$work/bad/"
sed -E 's/^[0-9a-f]{64}/0000000000000000000000000000000000000000000000000000000000000000/' \
  "$release/checksums.txt" >"$work/bad/checksums.txt"
if PEDIT_VERSION="$version" PEDIT_DOWNLOAD_URL="file://$work/bad" PEDIT_INSTALL_DIR="$work/bad/bin" \
  sh "$script" 2>"$work/bad/stderr"; then
  echo "install.sh accepted a checksum mismatch" >&2
  exit 1
fi
grep -q "checksum mismatch" "$work/bad/stderr"
test ! -e "$work/bad/bin/pedit"
test ! -s "$INSTALL_TEST_GH_LOG"
test ! -s "$INSTALL_TEST_TAR_LOG"

echo "ok"
