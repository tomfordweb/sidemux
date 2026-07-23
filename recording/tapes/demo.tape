# Hero README demo: a scripted MCP client (recording/agent-demo.mjs) drives
# the real sidemux server — build, failing test, grep-the-error, dev server —
# while the human peeks at the live pane through the Prefix+e dashboard popup.
# Rendered by recording/record.sh on an isolated tmux socket (smux-demo).

Output "assets/demo.gif"
Output "assets/demo.mp4"

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
Sleep 1.5s
Show

# The "agent": every tool call and its compact result, exactly what a model sees.
Type `node "$SIDEMUX_REPO/recording/agent-demo.mjs" hero` Sleep 500ms Enter

# pnpm build is now running in a workspace pane. Peek at it live: Prefix+e.
Sleep 4.5s
Ctrl+B
Sleep 300ms
Type "e"
Sleep 3.5s
Type "q"

# Back on the agent: build result lands, failing test runs, grep pulls the
# assertion, dev server starts and wait matches the ready line.
Sleep 13s

# One more peek while the dev server streams in its pane.
Ctrl+B
Sleep 300ms
Type "e"
Sleep 3s
Type "q"

# close_all + the token summary line.
Sleep 9s
