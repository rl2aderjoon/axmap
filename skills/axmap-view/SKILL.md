---
name: axmap-view
description: Show the current Git repository's axMap sessions, active claims, pending mailbox and recent events in a terminal view.
---

Use the current Git repository or the user's explicitly designated repository. Run `axmap view --cwd <absolute-repository>` in an interactive terminal; `q`, Esc or Ctrl+C closes the view. If the host cannot provide an interactive terminal, run `axmap view --cwd <absolute-repository> --once` and identify it as a snapshot. Slash-menu availability depends on the host and installed skill; do not imply that a bare slash command works in every terminal.

The display reads local evidence only. It does not start an AI session, submit work, send or collect mail, or imply that an unobserved session is idle. Never invent progress percentages or token counts.
