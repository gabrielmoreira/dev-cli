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

# Simplest path: one repository URL becomes a ready workspace.
Type "dev ws init https://github.com/gabrielmoreira/skills.git"
Sleep 500ms
Enter
Wait+Screen@20s /Workspace name/
Sleep 1s
Enter
Wait+Screen@20s /Workspace description/
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
Wait+Screen@20s /Workspace description/
Sleep 1s
Enter
Wait+Screen@20s /Initialized workspace 'scratch'/
Sleep 1s
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
Type "dev workset manage"
Sleep 500ms
Enter
Wait+Screen@20s /Workset name/
Type "incident"
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
Wait+Screen@20s /Save this workset/
Sleep 1s
Type "y"
Wait+Screen@20s /Saved workset 'incident'/
Sleep 2s
Ctrl+L
Sleep 1s

# Add one more member with the focused command; it asks for what it needs.
Type "dev workset repo add incident"
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
Sleep 700ms
Enter
Wait+Screen@20s /Added repository to workset 'incident'/
Sleep 2s
Type "clear"
Enter
Type "dev workset show incident"
Sleep 500ms
Enter
Wait+Screen@20s /Debugging skills/
Sleep 3s

# A fresh workspace from the workset, with nothing but prompts.
Type "clear"
Enter
Type "dev ws init"
Sleep 500ms
Enter
Wait+Screen@20s /How do you want to start/
Sleep 1s
Type "Workset"
Sleep 500ms
Enter
Wait+Screen@20s /Select workset/
Sleep 1s
Enter
Wait+Screen@20s /Workspace name/
Sleep 1s
Enter
Wait+Screen@20s /Workspace description/
Sleep 1s
Enter
Wait+Screen@20s /Select repositories to customize/
Sleep 1s
Tab
Sleep 1s
Enter
Wait+Screen@20s /Create this workspace/
Sleep 1s
Enter
Wait+Screen@90s /Initialized workspace 'incident'/
Sleep 3s

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
Type "ls -A"
Sleep 500ms
Enter
Wait+Screen@20s /ws\.md/
Sleep 3s

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
Ctrl+B
Sleep 500ms
Type "q"
Wait+Screen@20s /demo@devbox dev\/ws\/incident/
Sleep 1s

# Knowledge setup: keep the OMP docs and the skill catalog as reference checkouts.
Type "dev mirror add"
Sleep 500ms
Enter
Wait+Screen@20s /Select repository/
Sleep 1s
Type "omp"
Sleep 1s
Enter
Wait+Screen@30s /Added mirror/
Sleep 3s
Type "clear"
Enter
Type "dev mirror add"
Sleep 500ms
Enter
Wait+Screen@20s /Select repository/
Sleep 1s
Type "skills"
Sleep 1s
Enter
Wait+Screen@60s /Added mirror/
Sleep 3s
Type "clear"
Enter

# One label turns both reference checkouts into a searchable QMD index.
Type "dev mirror label add"
Sleep 500ms
Enter
Wait+Screen@20s /Select sources to label/
Sleep 1s
Tab
Down
Tab
Enter
Wait+Screen@20s /Label name/
Type "index:incident"
Enter
Wait+Screen@20s /Apply this label plan/
Enter
Wait+Screen@20s /Applied label 'index:incident'/

Type "dev qmd sync"
Sleep 500ms
Enter
Hide
Wait+Screen@300s /2 collection\(s\) reconciled/
Show
Sleep 1s
Type "dev qmd x search debugging-by-evidence"
Sleep 500ms
Enter
Wait+Screen@30s /Title:/
Sleep 3s

# Return to the already-running OMP agent with the new QMD index.
Type "clear"
Enter
Type "herdr"
Sleep 500ms
Enter
Wait+Screen@30s /OpenRouter Free Models Router/
Sleep 1s

Set TypingSpeed 20ms
Type "Which indexed skill fits an intermittent checkout timeout with no known cause? Search QMD and cite the files. Finish with the uppercase words INDEXED, ANSWER, and COMPLETE separated by spaces."
Sleep 500ms
Enter
Wait+Screen@240s /INDEXED ANSWER COMPLETE/
Sleep 10s
