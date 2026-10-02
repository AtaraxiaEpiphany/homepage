# open — print a file's content in the in-page viewer via OSC 7770.
#
# Contract with the frontend (apps/web TerminalView):
#   ESC ] 7770 ; open ; <base64url(content-relative path)> BEL
# base64url (no padding) keeps `;`, spaces and CJK out of the OSC framing.
#
# Jail: realpath must land on a regular file under /home/dev/content, ≤ 2 MB.
# The HTTP layer re-validates the same jail — a forged OSC gains nothing.

 CONTENT_DIR=/home/dev/content

open() {
  local -a targets
  if (( $# == 0 )); then
    local picked
    picked=$(fd --type f --exclude .git . "$CONTENT_DIR" 2>/dev/null \
      | fzf --preview='bat --color=always {}' --preview-window=right:60%) || return 0
    targets=("$picked")
  else
    targets=("$@")
  fi

  local t real rel size
  for t in "${targets[@]}"; do
    real=$(realpath -- "${~t}" 2>/dev/null) || { print -u2 "open: no such file: $t"; continue }
    case "$real" in
      "$CONTENT_DIR"/*) rel="${real#"$CONTENT_DIR"/}" ;;
      *) print -u2 "open: only files under ~/content are openable: $t"; continue ;;
    esac
    [[ -f "$real" ]] || { print -u2 "open: not a regular file: $t"; continue }
    size=$(stat -c%s "$real" 2>/dev/null || echo 0)
    if (( size > 2 * 1024 * 1024 )); then
      print -u2 "open: file too large (>2MB): $t"
      continue
    fi
    # printf (not print): no trailing newline — it would get base64-encoded
    local seq wrapped esc=$'\e'
    seq=$(printf '\e]7770;open;%s\a' "$(printf '%s' "$rel" | base64 | tr -d '\n=' | tr '/+' '_-')")
    if [[ -n "$TMUX" ]]; then
      # tmux swallows unknown OSC — wrap in the passthrough sequence and double
      # every ESC inside, so the payload reaches the outer terminal intact.
      # (zsh quirk: $'…' literals don't expand in ${…//…/…} replacements —
      # route them through variables.)
      wrapped="${seq//$esc/$esc$esc}"
      printf '\ePtmux;%s\e\\' "$wrapped"
    else
      printf '%s' "$seq"
    fi
  done
}
