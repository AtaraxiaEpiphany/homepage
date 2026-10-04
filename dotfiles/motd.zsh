# motd.zsh — welcome + quickstart for the homepage shell, printed once on
# interactive startup. English throughout; the layout is a two-column
# quickstart (label / commands / description) instead of ASCII art.
# Palette matches the web theme: xterm 256-colors 62 purple / 33 blue /
# 244 gray / 131 warm — all legible on the light #fafafa background.

[[ -o interactive ]] || return
[[ -n $MOTD_PRINTED ]] && return
MOTD_PRINTED=1

local -r c_name=$'\e[38;5;62m'   # purple — the site name
local -r c_link=$'\e[38;5;33m'   # blue — commands and links
local -r c_dim=$'\e[38;5;244m'   # gray — secondary text
local -r c_warm=$'\e[38;5;131m'  # warm accent — section markers
local -r c_r=$'\e[0m'

print
print -r -- " ${c_warm}▌${c_r} ${c_name}tulip${c_r} ${c_dim}— a real shell in your browser, not a simulation${c_r}"
print -r -- "   ${c_dim}a throwaway container: zsh · fzf · eza · no network · read-only.${c_r}"
print -r -- "   ${c_dim}nothing you do here outlives the page reload.${c_r}"
print
print -r -- " ${c_warm}try${c_r}      ${c_link}open hello.md${c_r}   ${c_dim}who I am — opens in this page${c_r}"
print -r -- "          ${c_link}demo${c_r}            ${c_dim}a typed-out tour of what this shell can do${c_r}"
print -r -- "          ${c_link}theme dark${c_r}      ${c_dim}flip the whole site dark${c_r}"
print -r -- "          ${c_link}status${c_r}          ${c_dim}sessions, uptime, image${c_r}"
print -r -- "          ${c_link}open${c_r}            ${c_dim}fuzzy-pick any file (fzf + bat preview)${c_r}"
print
print -r -- " ${c_warm}keys${c_r}     ${c_link}Ctrl-R${c_r} ${c_dim}history${c_r}   ${c_link}Tab${c_r} ${c_dim}completion${c_r}   ${c_link}Ctrl+P${c_r} / ${c_link}⌘P${c_r} ${c_dim}palette${c_r}"
print
