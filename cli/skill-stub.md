---
name: atelier-cli
description: >-
  Atelier 앱(Claude Code·Codex 를 채팅 탭으로 쓰는 macOS 앱)의 워크스페이스·탭·세션을 `atelier` CLI 로 제어한다.
  사용자가 "atelier 탭", "Atelier 에서 새 세션 열어", "그 탭에 보내", "탭 결과 읽어", "atelier 로 파일 열어",
  "다른 탭에 넘겨/핸드오프", "$atelier-cli" 라고 하거나, 실행 중인 Atelier 의 상태가 진실인 작업을 시킬 때 쓴다.
  Atelier 상태와 무관한 일은 평소 셸 도구를 쓴다.
---

# Atelier CLI

이 스텁은 짧다. 실제 명령 목록과 규칙은 **지금 설치된 앱 버전의 가이드**에서 읽는다. 먼저 이걸 실행하고 그 내용을 따른다:

```text
atelier skills get atelier-cli
```

- `atelier` 가 없으면(command not found) 사용자에게 "Atelier 설정 > 일반 > 명령줄 도구 설치" 를 안내하고 멈춘다. 소스 파일을 뒤지지 않는다.
- 결과가 `{"error":{"code":"not_running"}}` 이면 Atelier 앱을 먼저 열어 달라고 하고 멈춘다.
- 출력은 항상 JSON 이다. 사람에게 보고할 때는 필요한 필드만 골라 말한다.
