# Atelier CLI 가이드 (에이전트용)

`atelier` 는 실행 중인 Atelier 앱을 제어한다. Atelier 의 워크스페이스·탭·세션이 진실인 작업에만 쓴다. 출력은 항상 JSON 한 덩어리이고, 실패는 exit 1 과 `{"error":{"code","message"}}` 다.

## 모델

- **워크스페이스**: 이름 + 기본 경로(선택). 탭을 묶는 단위.
- **탭**: 채팅 세션 하나. provider(claude|codex), policy(ask|auto_edit|full), cwd, 상태(idle|running|queued|waiting_permission|error)를 가진다.
- **선택자 `<sel>`**: `active`(앱에서 보고 있는 탭) · 탭 id · 정확한 제목 · 유일한 제목 접두. 애매하면 `ambiguous` 오류에 후보가 실린다. `--tab` 을 생략하면 `active`.

## 자주 쓰는 흐름

새 탭을 열고 지시를 보내고 답을 받기:

```text
atelier tab new --ws <name> --cwd /abs/repo --provider claude --policy auto_edit --title "auth 버그" --prompt "로그인 500 원인 찾아줘" --activate
atelier tab wait --tab "auth 버그" --timeout-ms 600000
atelier tab read --tab "auth 버그" --last 6
```

이미 있는 탭에 이어서 보내고 그 답만 받기(보내기 + 기다리기 한 번에):

```text
atelier tab send --tab "auth 버그" --text "테스트도 추가해줘" --wait --timeout-ms 900000
```

- `send` 결과의 `send.queued` 가 true 면 동시 실행 상한에 걸려 차례를 기다리는 것이고, `send.pending` 이 true 면 그 탭이 다른 턴을 돌고 있어 프롬프트 큐에 들어간 것이다(그 턴이 끝나면 자동 전송). 둘 다 오류가 아니다. 탭 정보의 `pending` 은 큐에 남은 프롬프트 수, `limitWait` 는 사용량 한도로 재시도를 기다리는 중이라는 뜻이다.
- `wait` 결과는 `wait.satisfied` 로 판단한다. 시간 초과도 정상 출력이며 `satisfied:false` 다. 다시 보내지 말고 다시 기다린다. `send --wait` 는 방금 보낸 메시지의 턴이 실제로 끝났을 때만(큐·한도 대기를 지나) satisfied 가 되고, 단독 `wait` 는 탭에 남은 일이 없으면 즉시 satisfied 다.
- `satisfied:true` 면 `reply` 에 마지막 사용자 메시지 뒤의 어시스턴트 텍스트가 이어 붙어 온다. 도구 호출 내역까지 필요하면 `tab read`.
- 긴 텍스트는 `--text -` / `--prompt -` 로 stdin 에서 넣는다.

상태 보기:

```text
atelier status
atelier ws list
atelier tab list                # 열린 탭. --all 이면 닫힌 탭까지
atelier tab list --ws <name>
atelier tab status --tab <sel>
```

탭 다루기:

```text
atelier tab activate --tab <sel>   # 앱 화면에서 그 탭으로
atelier tab abort --tab <sel>      # 진행 중인 턴 중단
atelier tab close --tab <sel>      # 탭 닫기(기록은 남는다)
atelier ws add --path /abs/dir     # 워크스페이스 추가(탭 하나가 같이 생긴다)
```

검증(테스트·빌드를 돌려 결과 카드로 남기기):

```text
atelier tab verify --tab <sel> --wait                          # 워크스페이스에 저장한 검증 명령을 그 탭의 cwd 에서 순서대로
atelier tab verify --tab <sel> --cmd "yarn typecheck" --cmd "yarn test" --wait --timeout-ms 1800000
atelier tab verify-abort --tab <sel>
```

- 결과는 그 탭의 대화에 검증 카드로 남고, `--wait` 면 `result` 에 `status`(passed|failed|aborted)·실행 시점 `head`(sha·branch·dirty)·명령별 `status`/`exitCode`/`output`(꼬리)이 온다. 하나라도 실패하면 뒤 명령은 `skipped`.
- `--cmd` 를 주면 그 명령만 돌리고 저장하지는 않는다. 저장은 앱의 검증 버튼 옆 편집창에서 한다.
- 사용자 대신 커밋하기 전에는 이 명령으로 검증을 돌리고 `status:passed` 를 확인한다.

앱 화면 열기:

```text
atelier file open --path /abs/file.ts --line 42 [--tab <sel>]   # 그 탭의 에디터 패널에서 파일을 그 줄에서 연다
atelier browser open --url http://localhost:3000 [--tab <sel>]  # 그 탭의 인앱 브라우저 탭으로
atelier browser read [--tab <sel>]                             # 보이는 글 + 누를 만한 것(선택자 포함)
atelier browser click --selector "#save" [--tab <sel>]         # 또는 --text "저장"
atelier browser fill --selector "#email" --value "a@b.c"       # React 도 상태가 갱신된다
```

팬아웃(같은 지시를 격리 세션 여러 개에 동시에 보내 비교):

```text
atelier tab fanout --tab <sel> --prompt "<지시>" --provider claude --provider codex --policy auto_edit --wait --timeout-ms 1800000
```

- 변형마다 저장소의 git worktree 와 새 탭이 생겨 서로 파일을 건드리지 않는다. `--wait` 결과의 `result.variants[]` 에 변형별 `status`(done|failed|waiting)·변경 통계(`files`/`added`/`deleted`)·답변 요약이 온다. `waiting` 은 그 탭이 권한 응답을 기다린다는 뜻(사람이 봐야 함).
- 어느 변형을 채택할지는 사용자가 앱의 비교 화면에서 고른다(패치를 원본에 적용). CLI 는 채택하지 않는다.

## 오케스트레이션(감독이 필요한 다중 워커)

여러 작업을 워커 탭들에 나눠 주고, 질문에 답하고, 완료 보고를 모아야 할 때 쓴다. 단순히 다른 탭에 넘기기만 할 거면 아래 "핸드오프" 로 충분하다.
모델: **Run**(코디네이터의 인박스) > **Task**(자족적인 작업 명세) > **Dispatch**(그 작업의 권위 있는 시도 1개 = 워커 탭 하나). 권한은 dispatchId + capability 에 묶인다.

### 코디네이터(당신이 탭 안에서 감독할 때)

```text
atelier orch run-create --objective "<목표>" --coordinator active        # 응답의 coordinatorKey 를 모든 명령에 --key 로
atelier orch worker-start --run <run> --key <k> --spec "<Task 명세>" --agent codex --worktree
atelier orch worker-start --run <run> --key <k> --spec "<다른 Task>" --agent claude --worktree
atelier orch check --run <run> --key <k> --wait --types worker_done,question,escalation,note --timeout-ms 900000
atelier orch reply --run <run> --key <k> --id <question_id> --body "<답>"
atelier orch send  --run <run> --key <k> --type followup --to dispatch:<id> --body "<지시>"
atelier orch check --run <run> --key <k> --ack <delivery_id> --wait --types worker_done,question,escalation,note --timeout-ms 900000
atelier orch worker-release --run <run> --key <k> --dispatch <id>           # 정산된 워커 정리(탭은 남는다)
```

- Task 명세는 자족적으로: 대상(파일·컴포넌트), 변경, 제약(건드리면 안 되는 것), 소유 범위(이 워커가 편집해도 되는 것), 확인 가능한 완료 기준(테스트·출력).
- 독립 작업은 한꺼번에 띄운 뒤 기다린다. `check --wait` 는 인박스의 오래된 배치부터 준다(Delivery). **모든 메시지를 처리한 뒤** `--ack <delivery_id>` 로 다음을 기다린다. ack 전에는 같은 배치가 다시 온다.
- 빈 대기·시간 초과는 실패가 아니라 체크포인트다. 워커가 살아 있는 한 다시 기다린다. 앱 통지(note) 중 `turn_ended_without_report` 는 워커 턴이 보고 없이 끝났다는 뜻 — 탭을 보고 후속 지시를 보내거나 `worker-abandon`.
- 편집이 있는 워커는 `--worktree` 로 격리한다. 같은 경로에 편집 워커 둘을 두지 않는다. worktree 는 원본 HEAD 에서 시작하므로 원본의 커밋 안 된 변경은 넘어가지 않는다.
- 코디네이터 탭은 Run 이 살아 있는 동안 동시 작업 수에서 빠진다 — `check --wait` 로 기다리는 동안 워커 자리를 막지 않는다.
- 후속 지시는 `--to dispatch:<id>` 또는 그룹 `@all` · `@claude` · `@codex` · `@idle`(살아 있는 워커에게 각각 전달). 워커 탭은 새 Run 을 만들 수 없다(`nested_run`).
- 사람이 앱의 오케스트레이션 패널에서 "코디네이터 인수" 를 누르면 당신의 키는 `consumer_fenced` 가 된다. 그러면 멈추고 사용자에게 알린다.
- 순서가 진짜 필요한 작업만 `task-create --deps` 로 잇는다. 의존 Task 가 succeeded 가 아니면 worker-start 가 `deps_unmet` 이다. `task-list --ready` 가 지금 시작할 수 있는 Task 를 준다 — 독립 작업을 먼저 한꺼번에(웨이브) 띄우고, 끝난 뒤 다음 웨이브를 띄운다. deps 는 순서만 뜻한다: 앞 Task 의 산출물이 어디 있는지는 뒤 Task 의 spec 에 적어야 한다.
- 시작 전에 사람·코디네이터가 결정해야 할 게 있으면 `gate-create` 로 게이트를 건다(미해결이면 `gate_pending`). 워커의 질문(ask)을 대신하는 용도가 아니다.
- 정산된 워커의 탭은 `worker-start --task <next> --terminal <tabId>` 로 다음 Task 에 재사용할 수 있다(같은 provider·경로). 더 안 쓰면 `worker-cleanup` 이 탭을 닫고 worktree 를 지운다 — release(감독 해제)와 다르며, 커밋 안 된 변경도 사라진다.
- 앱 통지 `worker_tab_missing` 은 워커 탭이 사라졌다는 뜻(실행 상태 알 수 없음) — 확인 뒤 abandon.

### 워커(프롬프트 맨 위에 "[Atelier 오케스트레이션 · 워커 계약]" 이 있을 때)

preamble 의 명령을 그대로 복사해 쓴다(--run/--dispatch/--capability). 규칙: 그 Task 만 한다 · 코디네이터에게 물을 땐 `orch ask`(막힘, 시간 초과면 같은 message_id 로 `--resume`) · 새 파일 시작 전·테스트 뒤·보고 직전에 `orch check` 로 후속 지시를 읽는다 · `consumer_fenced` 가 오면 즉시 멈춘다 · 완료 보고는 `orch send --type worker_done --outcome succeeded|failed` 로 정확히 한 번, 실패를 본문에 숨기지 않는다 · 보고 뒤엔 새 일을 시작하지 않고 턴을 끝낸다 · 다른 워커·Run 을 만들지 않는다. 읽지 않은 후속 지시가 있으면 보고가 `followup_pending` 으로 거절된다 — 먼저 check.

## 핸드오프(다른 탭에 넘기기)

새 탭을 만들어 브리핑을 보내고, 받았음(`send.ok:true`)만 확인하면 끝이다. 그 탭이 끝날 때까지 기다리라는 요청이 아니면 `wait` 하지 않는다.

```text
atelier tab new --ws <name> --cwd /abs/repo --provider codex --title "<작업 이름>" --prompt "<브리핑>" --json
```

## 규칙

- 사람이 보고 있는 탭(`active`)에 지시를 보내면 사람의 대화에 끼어드는 것이다. 사용자가 명시하지 않았으면 새 탭을 만들어 쓴다.
- `--policy full` 은 승인 없이 실행한다. 사용자가 허락했을 때만.
- 자기 자신이 든 탭에 `send` 하고 `wait` 하면 영원히 기다린다. 자기 탭 id 는 `atelier tab list` 의 `active` 나 사용자가 알려 준 제목으로 알아낸다.
- `read` 의 `blocks` 는 오래된 것부터 순서대로다. `kind` 는 user · assistant · tool · turn · error · review(교차 리뷰) · verify(검증 결과) · fanout(팬아웃) · orchestration(오케스트레이션 카드).
- 앱이 꺼져 있으면 `not_running` 오류다. 앱을 열어 달라고 하고 멈춘다.
