#!/usr/bin/env python3
"""Update release metadata after verifying all four published archives."""
import hashlib
from pathlib import Path
import re
import sys

VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")
TARGETS = ("darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64")


def version_key(value):
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError("Invalid release version")
    prerelease = match[4]
    parts = prerelease.split(".") if prerelease else []
    if any(p.isdigit() and len(p) > 1 and p.startswith("0") for p in parts):
        raise ValueError("Invalid prerelease version")
    return (*map(int, match.group(1, 2, 3)), prerelease is None,
            tuple((0, int(p)) if p.isdigit() else (1, p) for p in parts))


def update(formula, tag, assets):
    if not tag.startswith("v"):
        raise ValueError("Expected a v-prefixed release tag")
    version = tag[1:]
    key = version_key(version)
    if not formula.startswith("class Pedit < Formula\n"):
        raise ValueError("Unexpected formula")
    versions = re.findall(r'^  version "([^"]+)"$', formula, re.M)
    if len(versions) != 1:
        raise ValueError("Expected exactly one version")
    current = version_key(versions[0])
    checksums = {}
    for line in (assets / "checksums.txt").read_text().splitlines():
        digest, name = line.split()
        if not re.fullmatch(r"[a-f0-9]{64}", digest) or name in checksums:
            raise ValueError("Invalid checksum manifest")
        checksums[name] = digest
    result = formula
    for target in TARGETS:
        os, arch = target.split("/")
        name = f"pedit_{tag}_{os}_{arch}.tar.gz"
        digest = hashlib.sha256((assets / name).read_bytes()).hexdigest()
        if checksums.get(name) != digest:
            raise ValueError(f"Checksum mismatch: {name}")
        pattern = rf'^(      sha256 ")[a-f0-9]{{64}}(" # {target})$'
        result, count = re.subn(pattern, lambda m: m[1] + digest + m[2], result, flags=re.M)
        if count != 1:
            raise ValueError(f"Expected exactly one checksum for {target}")
    if key < current:
        return formula
    return re.sub(r'^  version "[^"]+"$', f'  version "{version}"', result, flags=re.M)


if __name__ == "__main__":
    path, tag, directory = sys.argv[1:]
    path = Path(path)
    path.write_text(update(path.read_text(), tag, Path(directory)))
