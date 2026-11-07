#!/bin/sh
# Claude Code hook -> Logbook daemon. Fire-and-forget: never blocks or fails the agent.
[ -n "$LOGBOOK_DISABLE" ] && exit 0
payload=$(cat)
(
  printf '%s' "$payload" | curl -s -m 2 -X POST -H 'content-type: application/json' \
    --data-binary @- "http://127.0.0.1:${LOGBOOK_PORT:-7777}/hook" >/dev/null 2>&1
) &
exit 0
