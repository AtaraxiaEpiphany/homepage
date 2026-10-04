# demo — AIGC-style typewriter showcase of this site's shell.
#
# Terminal-native on purpose: it really runs `cat`/`ll`/`open` in the live
# shell; no frontend interception anywhere. Keys: space = pause/resume,
# q or Ctrl-C = quit. Pacing: 18ms/char baseline, +180ms after punctuation,
# +600ms at scene breaks.

typeset -g _DEMO_PAUSED=0 _DEMO_ABORT=0

_demo_handle_key() {
  case "$1" in
    ' ') _DEMO_PAUSED=$((1 - _DEMO_PAUSED)) ;;
    [qQ]) _DEMO_ABORT=1 ;;
  esac
}

# Wait $1 seconds; any keypress that lands during the wait is handled.
_demo_wait() {
  local k
  if read -k1 -s -t "$1" k 2>/dev/null; then
    _demo_handle_key "$k"
  fi
  (( _DEMO_ABORT )) && return 1
  return 0
}

# Pause loop: redraws the status line in place until resumed; leaves the
# line cleared at column 1 so the caller can repaint (or continue fresh).
_demo_pause_loop() {
  local k
  while (( _DEMO_PAUSED && ! _DEMO_ABORT )); do
    printf '\r\e[2K\e[33m⏸ paused — space to resume · q to quit\e[0m'
    if read -k1 -s -t 0.1 k 2>/dev/null; then
      _demo_handle_key "$k"
    fi
  done
  printf '\r\e[2K'
  (( ! _DEMO_ABORT ))
}

# Type $1 character by character in color $2 (raw escape prefix).
_demo_type() {
  local text="$1" color="${2:-}" c i
  (( _DEMO_ABORT )) && return 1
  [[ -n "$color" ]] && printf '%s' "$color"
  for (( i = 1; i <= ${#text}; i++ )); do
    if (( _DEMO_PAUSED )); then
      _demo_pause_loop || return 1
      # Repaint what we already typed on this line (pause wiped it).
      printf '\r%s%s' "$color" "${text[1,i-1]}"
    fi
    c="${text[i]}"
    printf '%s' "$c"
    (( _DEMO_ABORT )) && return 1
    if [[ "$c" == "." || "$c" == "!" || "$c" == "?" || "$c" == ";" ]]; then
      _demo_wait 0.18 || return 1
    else
      _demo_wait 0.018 || return 1
    fi
  done
  [[ -n "$color" ]] && printf '\e[0m'
  return 0
}

# Type a command, "press enter", then type its real output line by line.
_demo_run() {
  local cmd="$1" out line
  _demo_type "$cmd" $'\e[32m' || return 1
  _demo_wait 0.45 || return 1
  printf '\r\n'
  if ! out="$(eval "$cmd" 2>&1)"; then
    printf '\e[31mdemo: scene command failed: %s\e[0m\r\n' "$cmd"
    return 1
  fi
  while IFS= read -r line; do
    _demo_type "$line" || return 1
    # newline first so a pause during the gap can't wipe the typed line
    printf '\r\n'
    _demo_wait 0.045 || return 1
  done <<< "$out"
  return 0
}

demo() {
  _DEMO_PAUSED=0 _DEMO_ABORT=0
  trap '_DEMO_ABORT=1' INT
  # User abort (q / Ctrl-C) is a clean exit: wipe the partial line, restore.
  _demo_abort_cleanup() {
    printf '\r\e[2K'
    trap - INT
    return 0
  }

  printf '\e[36m'
  _demo_type 'tulip demo — real shell, real commands' || _demo_abort_cleanup
  (( _DEMO_ABORT )) && return 0
  printf '\e[0m\r\n'
  _demo_type '(space = pause · q = quit) — everything below actually executes.' || { _demo_abort_cleanup; return 0; }
  printf '\r\n\r\n'
  _demo_wait 0.6 || { _demo_abort_cleanup; return 0; }

  _demo_run 'cat ~/content/hello.md' || { _demo_abort_cleanup; return 0; }
  printf '\r\n' && _demo_wait 0.6 || { _demo_abort_cleanup; return 0; }

  _demo_run 'll' || { _demo_abort_cleanup; return 0; }
  printf '\r\n' && _demo_wait 0.6 || { _demo_abort_cleanup; return 0; }

  if [[ -f ~/content/charts.md ]]; then
    _demo_type 'watch the page: ' $'\e[90m' || { _demo_abort_cleanup; return 0; }
    _demo_run 'open ~/content/charts.md' || { _demo_abort_cleanup; return 0; }
    printf '\r\n' && _demo_wait 0.6 || { _demo_abort_cleanup; return 0; }
  fi

  _demo_type 'try it yourself: ' $'\e[90m' || { _demo_abort_cleanup; return 0; }
  _demo_type 'Ctrl-R (fzf history) · Tab (fzf-tab completion) · Ctrl+P / ⌘P (palette)' || { _demo_abort_cleanup; return 0; }
  printf '\r\n'
  _demo_type 'demo complete.' $'\e[32m' || { _demo_abort_cleanup; return 0; }
  printf '\r\n'

  trap - INT
  return 0
}
