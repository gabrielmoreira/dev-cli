# Q5: Pick a workspace without fzf

## Decision

Use the built-in list for `dev go`. When the shell wrapper captures stdout and stdin and stderr are terminals, draw the list on stderr and print only the selected path on stdout. Keep the wrapper contract of using that path to change your directory. With `--json`, wrappers delegate to the CLI without capturing a navigation target or changing directory. The prompt rule in `AGENTS.md` permits the stdin-and-stderr terminal case.

## Rejected alternative

A `--cwd-file` handshake changes the wrapper contract to exchange a temporary file rather than the printed path.
