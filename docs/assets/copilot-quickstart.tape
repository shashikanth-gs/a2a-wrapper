# Regenerate from the repo root:  vhs docs/assets/copilot-quickstart.tape
# This is a REAL run: it needs `gh auth login` (or GITHUB_TOKEN) with Copilot access.
Output docs/assets/copilot-quickstart.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 720
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WindowBar Colorful
Set BorderRadius 8

Hide
Type 'export PS1="\[\e[32m\]demo\[\e[0m\] \$ "' Enter
# From a source checkout the CLI is run via tsx; with npm it is simply `a2a-copilot`.
Type 'R=$(pwd); a2a-copilot() { $R/node_modules/.bin/tsx $R/a2a-copilot/src/cli.ts "$@"; }' Enter
Type "cd examples/copilot-quickstart" Enter
Type "clear" Enter
Show

Type "# 1. Turn GitHub Copilot into an A2A server with one config file" Enter
Sleep 800ms
Type "a2a-copilot --config config.json > server.log 2>&1 &" Enter
Sleep 9s
Type "# 2. Any A2A client can now discover it..." Enter
Type "curl -s localhost:3000/.well-known/agent-card.json | jq '{name, protocolVersion, url, skills: [.skills[].id]}'" Enter
Sleep 3s
Type "# 3. ...and talk to it" Enter
Type 'node ask.mjs "In two sentences, what does Array.prototype.flatMap do?"' Enter
Sleep 14s

Hide
Type "kill %1; rm -f server.log" Enter
