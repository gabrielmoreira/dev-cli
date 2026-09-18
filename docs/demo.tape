# Render from the repository root with: mise run demo
Output docs/assets/dev-cli-demo.gif

Require docker

Set Shell "bash"
Set Width 1200
Set Height 800
Set FontSize 18
Set FontFamily "JetBrains Mono"
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms
Set Framerate 15
Set Padding 18
Set Margin 24
Set MarginFill "#181825"
Set WindowBar Colorful
Set WindowBarSize 38
Set BorderRadius 10

# Enter the disposable Debian environment. Its tools were installed by Mise.
Type "docker run --rm --interactive --tty dev-cli-demo:local"
Enter
Wait+Screen@20s /demo@dev/
Sleep 1s

Type "mise --version && print 'DONE:'$?' mise'"
Enter
Wait+Screen@10s /2026.9.6/
Wait+Screen@10s /DONE:0 mise/

Type "dev --version && print 'DONE:'$?' dev'"
Enter
Wait+Screen@10s /dev v1.5.2/
Wait+Screen@10s /DONE:0 dev/

Type "qmd --version && print 'DONE:'$?' qmd'"
Enter
Wait+Screen@10s /qmd 2.8.3/
Wait+Screen@10s /DONE:0 qmd/
Sleep 2s
Ctrl+L
Sleep 1s

# Inspect and materialize a reusable two-repository workset.
Type "dev workset show platform --root /demo/dev && print 'DONE:'$?' workset'"
Enter
Wait+Screen@20s /handbook.git @ main/
Wait+Screen@10s /DONE:0 workset/
Sleep 2s

Type "dev ws init launch-review --workset platform --desc 'Release review' --yes --root /demo/dev && print 'DONE:'$?' workspace'"
Enter
Wait+Screen@20s /Continue with defaults/
Tab
Enter
Wait+Screen@60s /DONE:0 workspace/
Sleep 2s
Ctrl+L
Sleep 1s

Type "dev ws status launch-review --offline --root /demo/dev && print 'DONE:'$?' status'"
Enter
Wait+Screen@20s /Status:.*clean/
Wait+Screen@10s /DONE:0 status/
Sleep 2s

Ctrl+L
Sleep 1s

# Label one source and build a root-scoped lexical QMD index.
Type "dev mirror label add /demo/remotes/platform.git index:demo --root /demo/dev && print 'DONE:'$?' label'"
Enter
Wait+Screen@20s /Applied label 'index:demo'/
Wait+Screen@10s /DONE:0 label/
Sleep 2s

Type "dev qmd sync index:demo --no-embed --root /demo/dev && print 'DONE:'$?' index'"
Enter
Wait+Screen@60s /collection\(s\) reconciled/
Wait+Screen@10s /DONE:0 index/
Sleep 2s

Type "dev qmd --root /demo/dev x search 'release checklist' --format cli && print 'DONE:'$?' search'"
Enter
Wait+Screen@20s /Release checklist/
Wait+Screen@10s /DONE:0 search/
Sleep 3s

# Negotiate MCP over stdio and call the real QMD query tool.
Type "node /opt/demo/mcp-query.mjs && print 'DONE:'$?' mcp'"
Enter
Wait+Screen@30s /MCP tool call: query/
Wait+Screen@10s /DONE:0 mcp/
Sleep 6s
