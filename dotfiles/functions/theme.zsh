# theme — switch the page palette from inside the shell.
#
# Contract with the frontend (apps/web TerminalView):
#   ESC ] 7770 ; theme ; <dark|light> BEL
# The frontend restamps <html data-theme>, swaps the xterm palette, and
# persists the choice in localStorage.
# tmux passthrough: same wrapping as open.zsh (tmux swallows unknown OSC).

theme() {
  case "$1" in
    dark | light) ;;
    *) print -u2 "usage: theme dark|light"; return 1 ;;
  esac

  local seq wrapped esc=$'\e'
  seq=$(printf '\e]7770;theme;%s\a' "$1")
  if [[ -n "$TMUX" ]]; then
    wrapped="${seq//$esc/$esc$esc}"
    printf '\ePtmux;%s\e\\' "$wrapped"
  else
    printf '%s' "$seq"
  fi
}
