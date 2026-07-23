# Walkthrough: `sidemux benchmark` measuring the demo project's own commands
# inline vs through the sidemux server, ending on the savings table.

Output "assets/usage/benchmark.gif"

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

Type `node "$SIDEMUX_REPO/dist/index.js" benchmark --command "pnpm test" --command "pnpm build"` Sleep 500ms Enter
# Each command runs twice (inline + via MCP): ~12s each pass, plus setup.
Wait+Screen@120s /overall|Reduction|reduction/
Sleep 6s
