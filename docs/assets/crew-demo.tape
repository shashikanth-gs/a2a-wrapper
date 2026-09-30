# Regenerate from the repo root:  vhs docs/assets/crew-demo.tape
# Needs: vhs (brew install vhs), node >= 20. Uses the --mock stand-in agents.
Output docs/assets/crew-demo.gif

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
Type 'export PS1="\[\e[32m\]crew\[\e[0m\] \$ "' Enter
Type "cd examples/software-engineering-crew" Enter
Type "MOCK_DELAY_MS=1800 node mock-agents.mjs > /dev/null 2>&1 &" Enter
Type "sleep 1 && clear" Enter
Sleep 2s
Show

Type "# Two A2A agents are up: an implementer (:3030) and a tester (:3020)" Enter
Sleep 1s
Type "curl -s localhost:3030/.well-known/agent-card.json" Enter
Sleep 2s
Type "clear" Enter
Type 'node planner.mjs "Add a slugify(text) helper"' Enter
Sleep 6s

Hide
Type "kill %1" Enter
