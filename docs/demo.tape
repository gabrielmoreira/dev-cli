# Render from the repository root with: mise run demo
Output docs/assets/dev-cli-demo.gif
Output docs/assets/dev-cli-demo.mp4

Require docker

Set Shell "bash"
Set Width 1200
Set Height 800
Set FontSize 18
Set FontFamily "CaskaydiaCove NF"
Set Theme "Catppuccin Mocha"
Set TypingSpeed 28ms
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

# First-time setup: accept ~/dev and skip remote providers for this local demo.
Type "dev init"
Enter
Wait+Screen@20s /Dev root path/
Enter
Wait+Screen@20s /Add a provider now/
Right
Enter
Sleep 1s
Type "cd ~/dev"
Enter
Sleep 1s

# Simplest path: one repository URL creates a ready workspace.
Type "dev ws init https://github.com/gabrielmoreira/skills.git"
Enter
Wait+Screen@20s /Workspace name/
Enter
Wait+Screen@20s /Workspace description/
Enter
Wait+Screen@60s /Initialized workspace 'gh-gabrielmoreira-skills'/
Sleep 3s

# Start empty by name, then add a repository through the selector.
Type "clear"
Enter
Type "dev ws init scratch"
Enter
Wait+Screen@20s /Workspace description/
Enter
Wait+Screen@20s /Initialized workspace 'scratch'/
Type "cd ws/scratch"
Enter
Type "dev ws add"
Enter
Wait+Screen@20s /Select repositories/
Tab
Enter
Wait+Screen@20s /Select mounts to customize/
Tab
Enter
Wait+Screen@20s /Create these mounts/
Enter
Sleep 6s
Type "clear"
Enter
Type "dev ws status"
Enter
Wait+Screen@20s /checkout-api/
Sleep 3s

# Advanced path: build one task context from three repositories.
Type "clear"
Enter
Type "cd ~/dev"
Enter
Type "dev ws init"
Enter
Wait+Screen@20s /How do you want to start/
Down
Enter
Wait+Screen@20s /Select repositories/
Tab
Down
Tab
Down
Tab
Enter
Wait+Screen@20s /Workspace name/
Type "incident"
Enter
Wait+Screen@20s /Workspace description/
Type "Investigate checkout timeouts"
Enter
Wait+Screen@90s /Select repositories to customize/
Tab
Enter
Wait+Screen@20s /Create this workspace/
Enter
Sleep 10s

Type "clear"
Enter
Type "cd ws/incident"
Enter

# Advanced knowledge setup: declare OMP docs and the skill catalog as mirrors.
Type "dev mirror add"
Enter
Wait+Screen@20s /Select repository/
Type "omp"
Enter
Wait+Screen@30s /Added mirror/
Type "clear"
Enter
Type "dev mirror add"
Enter
Wait+Screen@20s /Select repository/
Type "gabriel"
Enter
Wait+Screen@60s /Added mirror/
Type "clear"
Enter

# One label turns both knowledge repositories into a full QMD index.
Type "dev mirror label add"
Enter
Wait+Screen@20s /Select sources to label/
Tab
Down
Tab
Enter
Wait+Screen@20s /Label name:/
Type "index:incident"
Enter
Wait+Screen@20s /Apply this label plan/
Enter
Wait+Screen@20s /Applied label 'index:incident'/

Type "dev qmd sync index:incident"
Enter
Wait+Screen@300s /2 collection\(s\) reconciled/
Sleep 2s
Type "dev qmd x search debugging-by-evidence --format cli"
Enter
Wait+Screen@30s /debugging-by-evidence/
Sleep 4s

# Hand the indexed workspace to OMP through HerdR.
Type "clear"
Enter
Type "dev ws start --json"
Enter
Wait+Screen@60s /incident-omp/
Type "herdr"
Enter
Wait+Screen@30s /OpenRouter Free Models Router/
Sleep 2s

Type "Search QMD first. Start with DECISION. Which skill should I use for an intermittent checkout timeout with no known cause? Then show the exact free-only OpenRouter setup for OMP. Cite the indexed files. Do not edit anything. Answer in at most 8 short lines."
Enter
Wait+Screen@180s /debugging-by-evidence/
Wait+Screen@30s /OPENROUTER_API_KEY/
Sleep 15s
