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

# The image preinstalls the published tools pinned in mise.toml; install is repeatable.
Type@25ms "# Tools are pinned in mise.toml; install is repeatable"
Enter
Sleep 500ms
Type "mise install"
Sleep 500ms
Enter
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
Sleep 6s

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
Sleep 6s

# The shell integration pays off at once: with one workspace, dev go jumps straight in.
Type "clear"
Enter
Type@25ms "# dev go jumps into it"
Enter
Sleep 500ms
Type "dev go"
Sleep 500ms
Enter
Wait+Screen@20s /dev\/ws\/gh-gabrielmoreira-skills/
Sleep 1s
Type "ls -A"
Sleep 500ms
Enter
Wait+Screen@20s /ws\.md/
Sleep 6s

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
Sleep 6s
Type "dev go scratch"
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
Sleep 6s
Type "clear"
Enter
Type "dev status"
Sleep 500ms
Enter
Wait+Screen@20s /checkout-api/
Sleep 6s

# Reusable path: describe a recurring setup once through the interactive manager.
Type "clear"
Enter
Type "cd ~/dev"
Enter
Type "clear"
Enter
Type@25ms "dev workset manage incident  # a reusable recipe"
Sleep 500ms
Enter
Wait+Screen@20s /Workset description/
Type "Investigate checkout timeouts"
Enter
Wait+Screen@20s /Manage workset/
Type "Edit setup command"
Sleep 500ms
Enter
Wait+Screen@20s /Setup command/
Type "mise install"
Sleep 500ms
Enter
Sleep 1s
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
Sleep 6s
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
Sleep 6s
Type "clear"
Enter
Type "dev workset show incident"
Sleep 500ms
Enter
Wait+Screen@20s /setup: mise install/
Wait+Screen@20s /Affected service/
Wait+Screen@20s /Debugging skills/
Sleep 6s

# A fresh task workspace from the workset, named on the command line; --consent runs its setup.
Type "clear"
Enter
Type "dev ws init incident --workset incident --consent"
Sleep 500ms
Enter
Wait+Screen@20s /What is this task about/
Sleep 1s
Enter
Wait+Screen@20s /Select repositories to customize/
Sleep 1s
Tab
Sleep 1s
Enter
Wait+Screen@20s /Workspace plan/
Sleep 1s
Wait+Screen@20s /Create this workspace/
Sleep 1s
Type "y"
Wait+Screen@120s /Initialized workspace 'incident'/
Sleep 6s

# With several workspaces, dev go opens a picker.
Type "clear"
Enter
Type@25ms "# Pick a workspace to jump into"
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
Sleep 6s

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
Sleep 6s
Type "clear"
Enter
Type "dev qmd sync  # build the search index"
Sleep 500ms
Enter
Hide
Wait+Screen@300s /2 collection\(s\) reconciled/
Show
Sleep 6s
Type "clear"
Enter
Type@25ms "# Search the index yourself"
Enter
Sleep 500ms
Type "dev qmd search debug"
Sleep 500ms
Enter
Wait+Screen@30s /Title:/
Sleep 6s

# The workspace's agent session searches the same index.
Type "clear"
Enter
Type@25ms "# Ask the agent; it searches the indexed repositories"
Enter
Sleep 500ms
Type "dev ws start"
Sleep 500ms
Enter
Wait+Screen@60s /OpenRouter Free Models Router/
Sleep 2s

Set TypingSpeed 20ms
Type "Which indexed skill fits an intermittent checkout timeout with no known cause? Cite the files you used. Finish with the uppercase words INDEXED, ANSWER, and COMPLETE joined by hyphens."
Sleep 500ms
Enter
# Keep provider latency out of the artifact while preserving the submitted prompt and final answer.
# One hyphenated token cannot wrap across lines in the agent pane; spaced words did.
Hide
Wait+Screen@240s /INDEXED-ANSWER-COMPLETE/
Show
Sleep 10s
