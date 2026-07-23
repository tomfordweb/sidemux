# Walkthrough: `sidemux init` wiring a project for auto-delegation, then the
# guard blocking an inline `pnpm test`.

Output "assets/usage/init.gif"

Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type `cd "$DEMO_DIR" && PS1='❯ ' && clear` Enter
Show

Type `node "$SIDEMUX_REPO/dist/index.js" init` Sleep 500ms Enter
Sleep 2.5s
Type "all" Sleep 800ms Enter
Sleep 3.5s

# Prove the guard: the exact PreToolUse payload Claude Code would send.
Type `echo '{"tool_name":"Bash","tool_input":{"command":"pnpm test"}}' | node .sidemux/delegate-guard.mjs` Sleep 500ms Enter
Sleep 5s
