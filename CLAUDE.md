# tulip — project notes

## Commit conventions

Conventional Commits 1.0.0, per the reference in
`~/Documents/wiki/ai/practice/conventional-commits.md`. Commit often — one
logical change per commit; never batch unrelated edits into one commit.

### Format

```
<type>(<scope>): <description>

[body]

[footers]
```

- **Types**: `feat` (MINOR), `fix` (PATCH), `BREAKING CHANGE` (MAJOR, see
  below); extended set allowed — `docs`, `style`, `refactor`, `perf`,
  `test`, `build`, `ci`, `chore`, `revert`.
- **Scopes** — keep to this closed set: `web`, `shell-server`, `container`,
  `dotfiles`, `content`. A change spanning several areas may omit the scope.
- **Description**: imperative mood, lowercase start, no trailing period,
  ≤ 72 chars — "this commit, if applied, will …".
- **Body**: blank line after the description, wrap at 72 columns. Use it
  for the why, not a diff restatement.
- **Breaking changes**: `!` before the `:` **and** a `BREAKING CHANGE:`
  footer saying what breaks and what to do. A rename like the shell user
  (`dev` → `tulip`) or an image base switch is breaking.
- **A commit that fits two types gets split into two commits.**
- **Reverts**: `revert: <original subject>` with a `Refs: <sha>` footer.

### Examples

```
feat(web): restyle terminal to the jyy visual system
fix: retarget jail paths to the tulip home
build(container)!: split install scripts out of the Dockerfile

BREAKING CHANGE: the shell user is renamed `dev` → `tulip`; the home
tmpfs and content jail now live at /home/tulip (see the matching
shell-server/open.zsh fix in the same series).
```
