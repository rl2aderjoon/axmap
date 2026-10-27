---
name: pipeline
description: Show the current repository's axMap local session graph, request and reply routing, observed usage and events. Use for /pipeline or axMap pipeline monitoring requests.
---

Use the current Git repository as scope. When the workspace root is outside Git, use its explicitly configured primary repository; never choose another repository silently.

Call `ax_pipeline` if available to show its MCP Apps session graph. This is read-only and does not invoke models. If the host lacks the tool/UI, use `axmap pipeline --cwd <absolute-repository>` in an interactive terminal, or `axmap pipeline --web --cwd <absolute-repository>` for the read-only loopback graphical view. For a snapshot use `--once`, and identify it as a snapshot rather than a live view.

The display shows registered bridge sessions and observed request IDs, roles, actual usage and events. An unregistered native Codex thread is not automatically visible. Missing usage is unknown, not zero; no invented task percentages. Opening the view never starts or resumes a model session or approves a request.

For an existing, user-selected Codex conversation, `axmap bridge connect codex --thread <existing-thread-id> --socket <official-local-control-socket> --role <role>` attaches through the already-running daemon. It preserves the original conversation and requires verified idle state. The connection process must stay running. Never replace failed attachment with a new blank session.

Codex-enabled skills may appear in the slash menu or be invoked as `$pipeline`; exact `/pipeline` menu availability depends on the host. Do not claim the client reserves a custom bare command when it does not.
