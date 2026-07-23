# Walkthrough: the standalone `sidemux dashboard` TUI over a seeded workspace
# (running dev server, passing test run, in-flight build).

Output "assets/usage/dashboard.gif"

Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type `cd "$DEMO_DIR" && clear` Enter
Type `tmux -L smux-demo -f "$SIDEMUX_REPO/recording/tmux-demo.conf" new-session -s demo` Enter
Sleep 1s
Type `node "$SIDEMUX_REPO/recording/agent-demo.mjs" seed && clear` Enter
Sleep 16s
Show

Type `SIDEMUX_TMUX_SOCKET=smux-demo node "$SIDEMUX_REPO/dist/index.js" dashboard` Sleep 500ms Enter
Sleep 3s
Down Sleep 1.2s
Down Sleep 1.2s
Up Sleep 1.5s
Sleep 3s
Type "q"
Sleep 1.5s
