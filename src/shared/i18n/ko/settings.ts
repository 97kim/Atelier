// 설정 화면. 카드마다 한 덩어리로 둔다.
export const settings = {
  general: {
    title: "일반",
    description: "화면과 알림, 브라우저, Claude·Codex의 실행 방식을 설정합니다.",
  },
  update: {
    title: "업데이트",
    description: "GitHub에 올라온 최신 버전과 비교합니다. Homebrew로 설치했다면 여기서 바로 업데이트할 수 있습니다.",
    currentVersion: "현재 버전",
    idle: "아직 확인하지 않았습니다.",
    checking: "확인하는 중…",
    available: "새 버전이 있습니다: {{version}}",
    latest: "최신 버전입니다.",
    notBrew: "Homebrew로 설치한 앱이 아니어서 릴리즈 페이지에서 DMG를 받아야 합니다.",
    upgrading: "새 버전({{version}})으로 업데이트하는 중… 1~2분 걸릴 수 있습니다.",
    done: "업데이트했습니다({{version}}). 다시 시작하면 새 버전이 열립니다.",
    checkFailed: "확인하지 못했습니다: {{error}}",
    notes: "변경 사항",
    releasePage: "릴리즈 페이지",
    relaunch: "다시 시작",
    run: "업데이트",
    check: "업데이트 확인",
  },
  language: {
    title: "언어",
    description: "앱 화면에 쓰는 언어입니다. 메뉴와 일부 메시지는 아직 한국어로 보일 수 있습니다.",
    options: {
      system: { label: "시스템 따라가기", hint: "macOS의 언어 설정을 따릅니다." },
      ko: { label: "한국어", hint: "항상 한국어로 표시합니다." },
      en: { label: "English", hint: "항상 영어로 표시합니다." },
    },
  },
  theme: {
    title: "화면 테마",
    description: "인앱 브라우저에 표시되는 웹사이트에는 적용되지 않습니다.",
    options: {
      system: { label: "시스템 따라가기", hint: "macOS 화면 모드가 바뀌면 함께 바뀝니다." },
      light: { label: "밝게", hint: "항상 밝은 배경." },
      dark: { label: "어둡게", hint: "항상 어두운 배경." },
    },
  },
  notify: {
    options: {
      always: { label: "항상", hint: "응답이 끝나면 macOS 알림을 보냅니다. 알림을 누르면 해당 탭으로 이동합니다." },
      unfocused: { label: "안 보고 있을 때만", hint: "다른 앱이나 다른 채팅 탭을 보고 있을 때 알립니다." },
      off: { label: "끄기", hint: "응답 완료는 알리지 않습니다. 작업 승인 요청은 계속 알립니다." },
    },
  },
  link: {
    options: {
      ask: { label: "클릭할 때마다 묻기", hint: "링크를 누를 때 열 위치를 고릅니다. 선택창에서 '기억'을 켜면 다음부터 같은 방식으로 엽니다." },
      app: { label: "인앱 브라우저", hint: "오른쪽 패널의 브라우저 탭에서 엽니다." },
      external: { label: "기본 브라우저", hint: "macOS 기본 브라우저에서 엽니다." },
    },
  },
  warm: {
    options: {
      active: { label: "보고 있는 탭", hint: "탭을 열거나 이동하면 Claude·Codex를 미리 실행해 첫 응답의 준비 시간을 줄입니다." },
      off: { label: "끄기", hint: "메시지를 보낼 때 실행합니다. 대기 중 메모리 사용은 줄지만 첫 응답을 준비하는 시간이 필요합니다." },
    },
  },
};
