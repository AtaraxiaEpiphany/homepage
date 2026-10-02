# Container zshrc — homepage shell image.
# Host-only stuff (openspec completions, nvm/cargo/venv, p10k instant prompt)
# is dropped; everything else mirrors the host ~/.zshrc order.
# ZDOTDIR=/opt/dotfiles, ZIM_HOME=/opt/zim (both read-only, baked at build).

[ -f "$ZDOTDIR/.shellrc" ] && source "$ZDOTDIR/.shellrc"

# Zim modules — init.zsh is prebuilt at image build time; no download or
# zimfw run here (ZIM_HOME is read-only at runtime).
source "$ZIM_HOME/init.zsh"

# To customize prompt, run `p10k configure` or edit .p10k.zsh.
[[ ! -f "$ZDOTDIR/.p10k.zsh" ]] || source "$ZDOTDIR/.p10k.zsh"

# fzf key bindings & completion (Ctrl-R / Ctrl-T / Alt-C, fzf-tab drives Tab)
if fzf --zsh >/dev/null 2>&1; then
  source <(fzf --zsh)
else
  echo "Note: 'fzf --zsh' not available, skipping." >&2
fi

# zoxide smarter cd (z/zi) — trixie package
if command -v zoxide >/dev/null 2>&1; then
  eval "$(zoxide init zsh --cmd z)"
fi

# Shared aliases — sourced LAST so they override zim's utility-module ls/ll.
[ -f "$ZDOTDIR/.shell_aliases" ] && source "$ZDOTDIR/.shell_aliases"

# Homepage shell functions (open, demo, ...)
for f in "$ZDOTDIR"/functions/*.zsh(N); do
  source "$f"
done
