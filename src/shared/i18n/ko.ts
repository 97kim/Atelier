// 한국어 사전(원본). 키는 영역별 의미 이름으로 — 문구가 바뀌어도 키는 그대로 둔다.
// 화면 문구는 2단계부터 차례로 옮긴다. 여기 없는 문구는 아직 코드에 직접 있다.

export const ko = {
  toolCard: {
    state: {
      partial: "입력 생성 중",
      waiting_permission: "권한 대기",
      waiting_answer: "답변 대기",
      denied: "거부됨",
      skipped: "건너뜀",
      failed: "실패",
      done: "완료",
      running: "실행 중",
    },
  },
};

/** 사전의 모양. 값은 모두 문자열이다. */
export type Dictionary = typeof ko;
