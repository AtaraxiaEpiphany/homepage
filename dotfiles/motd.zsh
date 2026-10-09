# motd.zsh — the homepage, printed once on interactive shell startup.
# jyy's homepage form (jiangyy.github.io): the banner IS the homepage —
# word-art TULIP with the identity block set beside it (wide terminals)
# or stacked under it (narrow ones). His palette: xterm 256-colors
# 62 purple / 33 blue / 244 gray, bold name, emoji-iconed links, italic
# tagline. Shell help lives in the demo tour and the palette, not here.

[[ -o interactive ]] || return
[[ -n $MOTD_PRINTED ]] && return
MOTD_PRINTED=1

local -r c_name=$'\e[38;5;62m'    # purple — the banner art
local -r c_link=$'\e[38;5;33m'    # blue — links
local -r c_dim=$'\e[38;5;244m'    # gray — secondary text
local -r c_r=$'\e[0m'
local -r b_name=$'\e[1;38;5;62m'  # bold purple — the heading name
local -r c_it=$'\e[3m'            # italic — the tagline

print
if (( COLUMNS >= 78 )) {
  # Wide: art (35 cols) + 3-space gutter + identity block (≤38 cols).
  local -r tag1=$'a real shell in a throwaway container:'
  local -r tag2=$'nothing you do here outlives a reload.'
  print -r -- "  ${c_name}██████  ██  ██  ██     ████  ██████${c_r}"
  print -r -- "  ${c_name}  ██    ██  ██  ██      ██   ██  ██${c_r}   ${b_name}hannibal${c_r} ${c_dim}—${c_r} ${c_link}hi@example.com${c_r}"
  print -r -- "  ${c_name}  ██    ██  ██  ██      ██   ██  ██${c_r}   🐙 ${c_link}github${c_r} ${c_dim}·${c_r} 📝 ${c_link}blog${c_r} ${c_dim}·${c_r} 📡 ${c_link}rss${c_r}"
  print -r -- "  ${c_name}  ██    ██  ██  ██      ██   ██████${c_r}   ${c_dim}— ship with the real launch${c_r}"
  print -r -- "  ${c_name}  ██    ██████  █████   ██   ██${c_r}       ${c_it}${c_dim}${tag1}${c_r}"
  print -r -- "  ${c_name}  ██    ██████  █████  ████  ██${c_r}       ${c_it}${c_dim}${tag2}${c_r}"
} else {
  # Narrow (phones): stack everything under the art.
  print -r -- "  ${c_name}██████  ██  ██  ██     ████  ██████${c_r}"
  print -r -- "  ${c_name}  ██    ██  ██  ██      ██   ██  ██${c_r}"
  print -r -- "  ${c_name}  ██    ██  ██  ██      ██   ██  ██${c_r}"
  print -r -- "  ${c_name}  ██    ██  ██  ██      ██   ██████${c_r}"
  print -r -- "  ${c_name}  ██    ██████  █████   ██   ██${c_r}"
  print -r -- "  ${c_name}  ██    ██████  █████  ████  ██${c_r}"
  print
  print -r -- "  ${b_name}hannibal${c_r} ${c_dim}—${c_r} ${c_link}hi@example.com${c_r}"
  print -r -- "  🐙 ${c_link}github${c_r} ${c_dim}·${c_r} 📝 ${c_link}blog${c_r} ${c_dim}·${c_r} 📡 ${c_link}rss${c_r}"
  print -r -- "  ${c_dim}— ship with the real launch${c_r}"
  print
  print -r -- "  ${c_it}${c_dim}a real shell in a throwaway container:${c_r}"
  print -r -- "  ${c_it}${c_dim}nothing you do here outlives a reload.${c_r}"
}
print
