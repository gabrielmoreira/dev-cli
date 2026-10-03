# Render from the repository root with: mise run demo
#
# Row budget: VHS (0.11 through 0.12) matches Wait+Screen against the first <rows> lines of the terminal buffer
# since the last clear (testing.go, Buffer()), not against the visible screen. At 1200x800 and
# 18pt that is about 30 rows. Every scene starts with a clear, and a marker must land within
# those rows; measure a scene before adding output above its marker. A completed prompt takes
# 4 rows (spacer, question, hint, answer), the shell prompt 3, and a caption line 3 more.
# Captions: one short "# ..." line per scene says what comes next; where a scene is near the
# budget, the caption trails the command on the same line instead.
Output docs/assets/dev-cli-demo.gif
Output docs/assets/dev-cli-demo.mp4

Require docker

Set Shell "bash"
Set Width 1200
Set Height 800
Set FontSize 18
Set FontFamily "CaskaydiaCove NF"
Set Theme "Catppuccin Mocha"
Set TypingSpeed 57ms
Set Framerate 15
Set Padding 18
Set Margin 24
Set MarginFill "#181825"
Set WindowBar Colorful
Set WindowBarSize 38
Set BorderRadius 10

Hide
Type "docker run --rm --interactive --tty --hostname devbox --env OPENROUTER_API_KEY dev-cli-demo:local"
Enter
Wait+Screen@20s /demo@devbox/
Type "clear"
Enter
Wait+Screen@10s /demo@devbox/
Show
Sleep 1s

# Nothing of dev is in the image: install the pinned release and turn on shell integration.
Type@25ms "# Install the dev release this demo shows"
Enter
Sleep 500ms
Type "mise use -g github:gabrielmoreira/dev-cli@$DEV_VERSION"
Sleep 500ms
Enter
# mise prints "<config> tools: <tool>@<version>" once the install is done.
Wait+Screen@180s /tools: github:gabrielmoreira/
Type "dev --version"
Enter
Wait+Screen@20s /dev v\d/
Sleep 1s
Type@25ms "# Let dev go change your shell's directory"
Enter
Sleep 500ms
Type `echo 'eval "$(dev shell-init zsh)"' >> ~/.zshrc`
Sleep 500ms
Enter
Type "source ~/.zshrc"
Enter
Sleep 2s

# First-time setup: accept ~/dev and skip remote providers for this local demo.
Type "clear"
Enter
Type@25ms "# Pick where your work lives; skip providers here"
Enter
Sleep 500ms
Type "dev init"
Sleep 500ms
Enter
Wait+Screen@20s /Where should dev keep your work/
Sleep 2s
Enter
Wait+Screen@20s /Connect GitHub or Azure DevOps/
Sleep 2s
Right
Sleep 1s
Enter
Sleep 1s
Type "cd ~/dev"
Enter
Sleep 500ms
Type "clear"
Enter

# Simplest path: one repository URL becomes a ready workspace.
Type@25ms "# One repository URL becomes a task workspace"
Enter
Sleep 500ms
Type "dev ws init https://github.com/gabrielmoreira/skills.git"
Sleep 500ms
Enter
Wait+Screen@20s /Workspace name/
Sleep 1s
Enter
Wait+Screen@20s /What is this task about/
Sleep 1s
Enter
Wait+Screen@60s /Initialized workspace 'gh-gabrielmoreira-skills'/
Sleep 1s
Type "ls -A ws/gh-gabrielmoreira-skills"
Sleep 500ms
Enter
Wait+Screen@20s /ws\.md/
Sleep 3s

# Start empty, then add a repository through the picker.
Type "clear"
Enter
Type@25ms "# Start an empty workspace for a task"
Enter
Sleep 500ms
Type "dev ws init"
Sleep 500ms
Enter
Wait+Screen@20s /How do you want to start/
Sleep 1s
Enter
Wait+Screen@20s /Workspace name/
Sleep 500ms
Type "scratch"
Enter
Wait+Screen@20s /What is this task about/
Sleep 1s
Enter
Wait+Screen@20s /Initialized workspace 'scratch'/
Sleep 1s
Type "cd ws/scratch"
Enter
Type "clear"
Enter
Type@25ms "# Add a repository from the picker"
Enter
Sleep 500ms
Type "dev ws add"
Sleep 500ms
Enter
Wait+Screen@20s /Select repositories/
Sleep 1s
Type "checkout"
Sleep 1s
Tab
Sleep 1s
Enter
Wait+Screen@20s /Select mounts to customize/
Sleep 1s
Tab
Sleep 1s
Enter
Wait+Screen@20s /Create these mounts/
Sleep 1s
Type "y"
Wait+Screen@30s /✓ Mounted checkout-api @/
Sleep 3s
Type "clear"
Enter
Type "dev status"
Sleep 500ms
Enter
Wait+Screen@20s /checkout-api/
Sleep 3s

# Reusable path: describe a recurring setup once through the interactive manager.
Type "clear"
Enter
Type "cd ~/dev"
Enter
Type "clear"
Enter
Type@25ms "# Save a reusable recipe: a workset"
Enter
Sleep 500ms
Type "dev workset manage incident"
Sleep 500ms
Enter
Wait+Screen@20s /Workset description/
Type "Investigate checkout timeouts"
Enter
Wait+Screen@20s /Manage workset/
Type "Add repository"
Sleep 500ms
Enter
Sleep 700ms
Type "checkout"
Sleep 500ms
Enter
Sleep 700ms
Type "main"
Enter
Sleep 700ms
Enter
Sleep 700ms
Type "Affected service"
Enter
Sleep 1s
Type "Save and exit"
Sleep 500ms
Enter
# The confirmation and result land past the row budget: pace them, and let the next scenes prove the save.
Sleep 1s
Type "y"
Sleep 2s
Type "clear"
Enter
Sleep 1s

# Add one more member with the focused command; it asks for what it needs.
Type "dev workset repo add incident  # one more repo"
Sleep 500ms
Enter
Wait+Screen@20s /Select repository to add/
Sleep 1s
Type "skills"
Sleep 500ms
Enter
Sleep 700ms
Type "main"
Enter
Sleep 700ms
Enter
Sleep 700ms
Type "Debugging skills"
Enter
Wait+Screen@20s /Add this repository/
Sleep 1s
Type "y"
Wait+Screen@20s /to workset 'incident'/
Sleep 2s
Type "clear"
Enter
Type "dev workset show incident"
Sleep 500ms
Enter
Wait+Screen@20s /Affected service/
Wait+Screen@20s /Debugging skills/
Sleep 3s

# A fresh workspace from the workset, through the command the saved workset suggested.
Type "clear"
Enter
Type "dev ws init --workset incident  # from the recipe"
Sleep 500ms
Enter
Wait+Screen@20s /Workspace name/
Sleep 1s
Enter
Wait+Screen@20s /What is this task about/
Sleep 1s
Enter
Wait+Screen@20s /Select repositories to customize/
Sleep 1s
Tab
Sleep 1s
Enter
Wait+Screen@20s /Create this workspace/
Sleep 1s
Type "y"
Wait+Screen@90s /Initialized workspace 'incident'/
Sleep 3s

# Shell integration turns workspace selection into a real directory jump.
Type "clear"
Enter
Type@25ms "# dev go jumps into a workspace"
Enter
Sleep 500ms
Type "dev go"
Sleep 500ms
Enter
Wait+Screen@20s /gh-gabrielmoreira-skills/
Sleep 1s
Type "incident"
Sleep 1s
Enter
Wait+Screen@20s /dev\/ws\/incident/
Sleep 1s
Type "ls -A"
Sleep 500ms
Enter
Wait+Screen@20s /ws\.md/
Sleep 3s

# Start OMP early so indexing never delays the product handoff.
Type "clear"
Enter
Type@25ms "# Start the workspace's agent session"
Enter
Sleep 500ms
Type "dev ws start --json"
Sleep 500ms
Enter
Wait+Screen@60s /incident-omp/
Type "herdr"
Sleep 500ms
Enter
Wait+Screen@30s /OpenRouter Free Models Router/
Sleep 3s
Ctrl+B
Sleep 500ms
Type "q"
Wait+Screen@20s /demo@devbox dev\/ws\/incident/
Sleep 1s

# Knowledge setup: one index label keeps the OMP docs and the skill catalog mirrored.
Type "clear"
Enter
Type "dev label add index:incident  # docs to search"
Sleep 500ms
Enter
Wait+Screen@20s /Select repositories for/
Sleep 1s
Type "omp-docs"
Sleep 1s
Tab
Backspace 8
Type "skills"
Sleep 1s
Tab
Sleep 1s
Enter
Wait+Screen@20s /Select repositories to customize/
Sleep 1s
Tab
Sleep 1s
Enter
Wait+Screen@20s /Apply this label/
Enter
Wait+Screen@20s /missing mirror/
Enter
Wait+Screen@180s /Mirrored skills/
Sleep 2s
Type "clear"
Enter
Type "dev qmd sync  # build the search index"
Sleep 500ms
Enter
Hide
Wait+Screen@300s /2 collection\(s\) reconciled/
Show
Sleep 2s
Type "clear"
Enter
Type@25ms "# Search the index yourself"
Enter
Sleep 500ms
Type "dev qmd x search debugging-by-evidence"
Sleep 500ms
Enter
Wait+Screen@30s /Title:/
Sleep 3s

# Return to the already-running OMP agent with the new QMD index.
Type "clear"
Enter
Type@25ms "# Ask the agent; it searches the same index"
Enter
Sleep 500ms
Type "herdr"
Sleep 500ms
Enter
Wait+Screen@30s /OpenRouter Free Models Router/
Sleep 1s

Set TypingSpeed 20ms
Type "Which indexed skill fits an intermittent checkout timeout with no known cause? Search QMD and cite the files. Finish with the uppercase words INDEXED, ANSWER, and COMPLETE joined by hyphens."
Sleep 500ms
Enter
# Keep provider latency out of the artifact while preserving the submitted prompt and final answer.
# One hyphenated token cannot wrap across lines in the agent pane; spaced words did.
Hide
Wait+Screen@240s /INDEXED-ANSWER-COMPLETE/
Show
Sleep 10s
