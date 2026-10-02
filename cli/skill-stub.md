---
name: atelier-cli
description: >-
  Control the Atelier app's workspaces, tabs, and sessions (워크스페이스·탭·세션) with the `atelier` CLI.
  Atelier is a macOS app that runs Claude Code and Codex as chat tabs. Use for opening a session in Atelier,
  sending a prompt to a tab, reading a tab's reply, handing work off to another tab, or opening a file in Atelier:
  "atelier tab", "open a new session in Atelier", "send it to that tab", "read that tab's result", "hand this off",
  "atelier 탭", "Atelier 에서 새 세션 열어", "그 탭에 보내", "탭 결과 읽어", "다른 탭에 넘겨/핸드오프",
  "atelier 로 파일 열어", "$atelier-cli". Use only when the task depends on the running Atelier app's state;
  for anything else, use your usual shell tools.
---

# Atelier CLI

This stub is short. The actual commands and rules live in **the guide for the app version that is installed now**. Run this first and follow what it says:

```text
atelier skills get atelier-cli
```

- If `atelier` is missing (command not found), tell the user to install the atelier CLI under Atelier Settings > General > CLI and agent skills, and stop. Do not dig through source files.
- If a command returns `{"error":{"code":"not_running"}}`, ask the user to open the Atelier app first, and stop.
- Commands print JSON (the guide above and `--help` are plain text). When you report to a person, pick out only the fields that matter.
- Write everything the user reads in the user's language: follow their language setting, and otherwise the language of their request.
