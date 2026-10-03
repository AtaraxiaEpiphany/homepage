# status — ask the host page to fetch and print shell-server stats.
# Emits an empty-payload OSC 7770; the web client turns it into a `status`
# control frame over the WebSocket and writes the answer back into the
# terminal, so the numbers describe the server, not this shell.
status() {
  local seq wrapped esc=$'\e'
  seq=$(printf '\e]7770;status;\a')
  if [[ -n "$TMUX" ]]; then
    wrapped="${seq//$esc/$esc$esc}"
    printf '\ePtmux;%s\e\\' "$wrapped"
  else
    printf '%s' "$seq"
  fi
}
