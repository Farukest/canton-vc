#!/bin/bash
# WSL/Windows convenience build script.
#
# DAML SDK on Windows runs faster from a Linux filesystem than from
# /mnt/c. This script copies the package to /tmp, builds it there,
# and copies the DAR back to the repository.
#
# Requires DAML SDK 3.4.11+ installed in WSL ($HOME/.daml/bin).
set -e
unset PATH
export PATH="$HOME/.daml/bin:/usr/local/bin:/usr/bin:/bin"

# Resolve script directory (works from any cwd, even Windows path).
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD=/tmp/canton-vc-credential-build

rm -rf "$BUILD"
mkdir -p "$BUILD"
cp "$SRC/daml.yaml" "$BUILD/"
cp -r "$SRC/daml" "$BUILD/"

cd "$BUILD"
daml build
ls -la .daml/dist/

# Copy DAR back into the repo's release/ directory (tracked, committed).
mkdir -p "$SRC/release"
cp .daml/dist/*.dar "$SRC/release/"
echo "DAR copied to $SRC/release/"
ls -la "$SRC/release/"*.dar
