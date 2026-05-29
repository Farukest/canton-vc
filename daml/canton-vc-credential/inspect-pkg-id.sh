#!/bin/bash
export PATH="$HOME/.daml/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")"
daml damlc inspect-dar release/canton-vc-credential-2.2.0.dar 2>&1 | grep -E "canton-vc-credential.*2\.2\.0" | head -3
