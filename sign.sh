#!/bin/bash
# Sign the extension through addons.mozilla.org (AMO) as an UNLISTED add-on,
# so you can install it permanently in a release build of Firefox/LibreWolf.
#
# You need your own AMO API credentials:
#   https://addons.mozilla.org/developers/addon/api/key/
# and your own unique add-on id in extension/manifest.json
# (browser_specific_settings.gecko.id). AMO ties that id to your account.
#
# Credentials go in through the ENVIRONMENT, never as CLI arguments.
# web-ext accepts --api-key/--api-secret, but argv is world-readable in
# /proc: any local process, or a stray `ps`, sees the secret in full.
# web-ext reads WEB_EXT_API_KEY / WEB_EXT_API_SECRET, so use those.
#
# Usage:
#   ./sign.sh                    # WEB_EXT_API_KEY / WEB_EXT_API_SECRET already exported
#   ./sign.sh path/to/amo.env    # a file (chmod 600) that exports those two
#
# Bump "version" in extension/manifest.json first: AMO rejects a repeat.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if [ $# -ge 1 ]; then
  # shellcheck disable=SC1090
  . "$1"
fi

: "${WEB_EXT_API_KEY:?WEB_EXT_API_KEY is not set (your AMO JWT issuer)}"
: "${WEB_EXT_API_SECRET:?WEB_EXT_API_SECRET is not set (your AMO JWT secret)}"
export WEB_EXT_API_KEY WEB_EXT_API_SECRET

mkdir -p dist

# Redact anyway, belt and braces: a validation error can echo the key back.
# Fixed-string replacement in Python, so no character in a secret can break it.
npx --yes web-ext sign \
    --source-dir=./extension \
    --artifacts-dir=./dist \
    --channel=unlisted 2>&1 \
  | python3 -c '
import os, sys
k, s = os.environ["WEB_EXT_API_KEY"], os.environ["WEB_EXT_API_SECRET"]
for line in sys.stdin:
    sys.stdout.write(line.replace(k, "<KEY-REDACTED>").replace(s, "<SECRET-REDACTED>"))
'
