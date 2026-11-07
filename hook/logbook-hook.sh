#!/bin/sh
# Claude Code hook -> Logbook daemon. Never blocks or fails the agent.
[ -n "$LOGBOOK_DISABLE" ] && exit 0
payload=$(cat)
url="http://127.0.0.1:${LOGBOOK_PORT:-7777}/hook"
case "$payload" in
  *'"hook_event_name":"SessionStart"'*|*'"hook_event_name": "SessionStart"'*)
    # Session start waits a moment for an answer: if "Agents say hi in the terminal" is on, it tells Claude who it is in the town.
    printf '%s' "$payload" | curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- "$url?reply=1" 2>/dev/null
    exit 0
    ;;
  *'"hook_event_name":"UserPromptSubmit"'*|*'"hook_event_name": "UserPromptSubmit"'*)
    # A note from you is waiting for a working agent (the daemon leaves a marker next to this script): hand it over with this prompt.
    if [ -e "${0%/*}/notes.pending" ]; then
      printf '%s' "$payload" | curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- "$url?reply=1" 2>/dev/null
      exit 0
    fi
    ;;
esac
# Everything else is fire-and-forget.
(
  printf '%s' "$payload" | curl -s -m 2 -X POST -H 'content-type: application/json' \
    --data-binary @- "$url" >/dev/null 2>&1
) &
exit 0
