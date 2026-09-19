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

# First-time setup: accept ~/dev and skip remote providers for this local demo.
Type "dev init"
Sleep 500ms
Enter
Wait+Screen@20s /Dev root path/
Sleep 1s
Enter
Wait+Screen@20s /Add a provider now/
Sleep 1s
Right
Sleep 1s
Enter
Sleep 1s
Type "cd ~/dev"
Enter
Sleep 1s

Hide
Type "cat /opt/demo/workset.yaml >> dev.yaml"
Enter
Wait+Screen@10s /demo@devbox/
Show

# Simplest path: one repository URL creates a ready workspace.
Type "dev ws init https://github.com/gabrielmoreira/skills.git"
Sleep 500ms
Enter
Wait+Screen@20s /Workspace name/
Enter
Wait+Screen@20s /Workspace description/
Enter
Wait+Screen@60s /Initialized workspace 'gh-gabrielmoreira-skills'/
Sleep 1s
Type "find ws/gh-gabrielmoreira-skills -maxdepth 1 | sort"
Sleep 500ms
Enter
Wait+Screen@20s /ws\/gh-gabrielmoreira-skills\/ws\.md/
Sleep 1s

# Start empty by name, then add a repository through the selector.
Type "clear"
Enter
Type "dev ws init scratch"
Sleep 500ms
Enter
Wait+Screen@20s /Workspace description/
Enter
Wait+Screen@20s /Initialized workspace 'scratch'/
Type "cd ws/scratch"
Enter
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
Enter
Wait+Screen@30s /Mounted repository 'checkout-api'/
Sleep 1s
Type "clear"
Enter
Type "dev ws status"
Sleep 500ms
Enter
Wait+Screen@20s /checkout-api/
Sleep 1s

# Reusable path: create a task workspace from a configured workset.
Type "clear"
Enter
Type "cd ~/dev"
Enter
Type "dev workset list"
Sleep 500ms
Enter
Wait+Screen@20s /incident \(3\)/
Sleep 1s
Type "dev ws init incident --workset incident --desc 'Investigate checkout timeouts' --yes"
Sleep 500ms
Enter
Wait+Screen@20s /Select repositories to customize/
Sleep 1s
Tab
Sleep 1s
Enter
Wait+Screen@90s /Initialized workspace 'incident'/
Sleep 1s

# Shell integration turns workspace selection into a real directory jump.
Type "clear"
Enter
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
Type "find . -maxdepth 1 | sort"
Sleep 500ms
Enter
Wait+Screen@20s /\.\/ws\.md/
Sleep 1s

# Start OMP early so indexing never delays the product handoff.
Type "clear"
Enter
Type "dev ws start --json"
Sleep 500ms
Enter
Wait+Screen@60s /incident-omp/
Type "herdr"
Sleep 500ms
Enter
Wait+Screen@30s /OpenRouter Free Models Router/
Sleep 3s
Ctrl+D
Sleep 1s
Ctrl+C
Wait+Screen@20s /demo@devbox dev\/ws\/incident/
Sleep 1s

# Advanced knowledge setup: declare OMP docs and the skill catalog as mirrors.
Type "dev mirror add"
Sleep 500ms
Enter
Wait+Screen@20s /Select repository/
Sleep 1s
Type "omp"
Sleep 1s
Enter
Wait+Screen@30s /Added mirror/
Type "clear"
Enter
Type "dev mirror add"
Sleep 500ms
Enter
Wait+Screen@20s /Select repository/
Sleep 1s
Type "gabriel"
Sleep 1s
Enter
Wait+Screen@60s /Added mirror/
Type "clear"
Enter

# One label turns both knowledge repositories into a full QMD index.
Type "dev mirror label add"
Sleep 500ms
Enter
Wait+Screen@20s /Select sources to label/
Sleep 1s
Tab
Down
Tab
Enter
Wait+Screen@20s /Select label/
Sleep 1s
Enter
Wait+Screen@20s /Apply this label plan/
Enter
Wait+Screen@20s /Applied label 'index:incident'/

Type "dev qmd sync index:incident"
Sleep 500ms
Enter
Wait+Screen@90s /2 collection\(s\) reconciled/
Sleep 1s
Type "dev qmd x search debugging-by-evidence --format cli"
Sleep 500ms
Enter
Wait+Screen@30s /debugging-by-evidence/
Sleep 1s

# Return to the already-running OMP agent with the new QMD index.
Type "clear"
Enter
Type "herdr"
Sleep 500ms
Enter
Wait+Screen@30s /OpenRouter Free Models Router/
Sleep 1s

Set TypingSpeed 20ms
Type "Search QMD first. Begin with the uppercase decision label followed by a colon. In at most 8 short lines, name the skill for an intermittent checkout timeout with no known cause, show the exact free-only OpenRouter setup for OMP, and cite the indexed files. Do not edit anything. Finish with the uppercase words INDEXED, ANSWER, and COMPLETE separated by spaces."
Sleep 500ms
Enter
Wait+Screen@240s /DECISION:/
Wait+Screen@90s /OPENROUTER_API_KEY/
Wait+Screen@60s /INDEXED ANSWER COMPLETE/
Sleep 6s
