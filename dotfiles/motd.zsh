# motd.zsh — the homepage, printed once on interactive shell startup:
# word-art banner, contact lines, one-line about. Same shape as jyy's
# homepage (jiangyy.github.io) — the banner IS the homepage; shell help
# lives in the demo tour and the palette, not here. Palette matches the
# web theme: xterm 256-colors 62 purple / 33 blue / 244 gray — all
# legible on the light #fafafa background.

[[ -o interactive ]] || return
[[ -n $MOTD_PRINTED ]] && return
MOTD_PRINTED=1

local -r c_name=$'\e[38;5;62m'   # purple — the banner art and name
local -r c_link=$'\e[38;5;33m'   # blue — links
local -r c_dim=$'\e[38;5;244m'   # gray — secondary text
local -r c_r=$'\e[0m'

print
print -r -- "  ${c_name}████ █  █ █   ██ █▀▀▄${c_r}"
print -r -- "  ${c_name} ▐▌  █  █ █   ▐▌ █  █${c_r}"
print -r -- "  ${c_name} ▐▌  █  █ █   ▐▌ █▄▄ ${c_r}"
print -r -- "  ${c_name} ▐▌ ▝▙▟▖ █▄▄ ▟▙ █${c_r}"
print
print -r -- "  ${c_name}tulip${c_r} ${c_dim}·${c_r} ${c_name}hannibal${c_r} ${c_dim}·${c_r} ${c_link}hi@example.com${c_r}"
print -r -- "  ${c_link}github${c_r} ${c_dim}· blog · rss — ship with the real launch${c_r}"
print
print -r -- "  ${c_dim}a real shell in your browser — a throwaway container:${c_r}"
print -r -- "  ${c_dim}no network, read-only. nothing you do here outlives a reload.${c_r}"
print
