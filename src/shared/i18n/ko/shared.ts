// src/shared 의 함수가 만드는 표시 문구(검증 요약·경과 시간 등). 함수는 t 를 인자로 받는다.
export const shared = {
  untitledTab: "새 세션",
  duration: {
    minSec: "{{min}}분 {{sec}}초",
    sec: "{{sec}}초",
  },
  verify: {
    status: {
      running: "실행 중",
      passed: "통과",
      failed: "실패",
      aborted: "중단됨",
    },
    summary: {
      failedAt: "{{index}}번째 명령 실패 ({{passed}}/{{total}} 통과)",
      running: "{{index}}/{{total}} 실행 중",
      aborted: "{{passed}}/{{total}} 통과 뒤 중단",
      passed: "{{passed}}/{{total}} 통과",
    },
  },
  jobs: {
    elapsed: "{{label}} · {{time}} 경과",
    summary_one: "{{count}}개 · {{time}} 경과",
    summary_other: "{{count}}개 · {{time}} 경과",
  },
};
