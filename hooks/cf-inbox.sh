#!/usr/bin/env bash
# Poll a single locally durable task; source the platform-provided runtime.
set -euo pipefail
: "${HATCH_HOOK_RUNTIME:?Muse hook runtime is required}"
: "${CF_MUSE_CLI:?Absolute cf-muse wrapper is required}"
source "$HATCH_HOOK_RUNTIME"
PAYLOAD="$("$CF_MUSE_CLI" poll)"
COUNT="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])')"
if [[ "$COUNT" == "0" ]]; then
  silent "no queued CF messages" '{}'
else
  wake "new CF channel message for Muse" "$PAYLOAD"
fi
