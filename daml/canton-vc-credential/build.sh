#!/bin/bash
# Build the canton-vc-credential DAR. Requires DAML SDK 3.4.11+.
# Output is mirrored to release/canton-vc-credential-2.2.0.dar.
set -e
export PATH="$HOME/.daml/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")"
daml build
mkdir -p release
cp .daml/dist/canton-vc-credential-2.2.0.dar release/
ls -la release/
