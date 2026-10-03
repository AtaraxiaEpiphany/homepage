# motd.zsh — welcome screen for the homepage shell, printed once on
# interactive startup. Palette matches the web theme: xterm 256-colors
# 62 purple / 33 blue / 244 gray / 131 warm — all legible on the light
# #fafafa terminal background.

[[ -o interactive ]] || return
[[ -n $MOTD_PRINTED ]] && return
MOTD_PRINTED=1

local -r c_link=$'\e[38;5;33m'   # blue — links
local -r c_dim=$'\e[38;5;244m'   # gray — secondary text
local -r c_warm=$'\e[38;5;131m'  # warm accent — site markers
local -r c_r=$'\e[0m'

print
print -r -- $'▌     ▌ ▘'
print -r -- $'▛▀ ▌▐ ▌ ▌ ▛▀'
print -r -- $'▌▄ ▙▟ ▌ ▌ ▙▟'
print -r -- $'          ▌'
print -r -- " ${c_dim}— 终端、打字机与随机漫谈${c_r}"
print
print -r -- " ${c_warm}>${c_r} ${c_link}blog${c_r} ${c_dim}·${c_r}  ${c_warm}>${c_r} ${c_link}photos${c_r} ${c_dim}·${c_r}  ${c_warm}>${c_r} ${c_link}projects${c_r}   ${c_dim}(占位)${c_r}"
print -r -- " ${c_dim}[${c_r}${c_link}github${c_r}${c_dim}]${c_r} ${c_dim}[${c_r}${c_link}email${c_r}${c_dim}]${c_r} ${c_dim}[${c_r}${c_link}rss${c_r}${c_dim}]${c_r}"
print
print -r -- " ${c_dim}try${c_r}  ${c_link}open hello.md${c_r} ${c_dim}· demo · theme · status${c_r}"
print -r -- " ${c_dim}keys${c_r} ${c_dim}Ctrl-R history · Tab completion · Ctrl+Shift+P / ⌘⇧P palette${c_r}"
print
