#!/bin/sh
# Claude Code hook -> Swarmville daemon. Never blocks or fails the agent.
# (LOGBOOK_* names are from before the rename to Swarmville and still work.)
[ -n "$SWARMVILLE_DISABLE$LOGBOOK_DISABLE" ] && exit 0
payload=$(cat)
url="http://127.0.0.1:${SWARMVILLE_PORT:-${LOGBOOK_PORT:-7777}}/hook"
case "$payload" in
  *'"hook_event_name":"SessionStart"'*|*'"hook_event_name": "SessionStart"'*)
    # Session start waits a moment for an answer: if "Agents say hi in the terminal" is on, it tells Claude who it is in the town.
    printf '%s' "$payload" | curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- "$url?reply=1" 2>/dev/null
    exit 0
    ;;
  *'"hook_event_name":"UserPromptSubmit"'*|*'"hook_event_name": "UserPromptSubmit"'*)
    # A note from you is waiting for a working agent (the daemon leaves a marker next to this script): hand it over with this prompt.
    if [ -e "${0%/*}/notes.pending" ] || [ -e "${0%/*}/steer.pending" ]; then
      printf '%s' "$payload" | curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- "$url?reply=1" 2>/dev/null
      exit 0
    fi
    ;;
  *'"hook_event_name":"PostToolUse"'*|*'"hook_event_name": "PostToolUse"'*)
    # You sent this agent a message from the town while it works: hand it over after this step.
    if [ -e "${0%/*}/steer.pending" ]; then
      printf '%s' "$payload" | curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- "$url?reply=1" 2>/dev/null
      exit 0
    fi
    ;;
  *'"hook_event_name":"PermissionRequest"'*|*'"hook_event_name": "PermissionRequest"'*)
    # A permission prompt: wait for an answer from the town (the terminal prompt shows meanwhile; whichever answers first wins).
    # No answer, or Swarmville isn't running: print nothing and the terminal prompt carries on as usual.
    printf '%s' "$payload" | curl -s -m 590 -X POST -H 'content-type: application/json' --data-binary @- "$url?wait=1" 2>/dev/null
    exit 0
    ;;
esac
# Everything else is fire-and-forget.
(
  printf '%s' "$payload" | curl -s -m 2 -X POST -H 'content-type: application/json' \
    --data-binary @- "$url" >/dev/null 2>&1
) &
exit 0
