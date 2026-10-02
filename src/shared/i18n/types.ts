/** 한국어 사전과 같은 모양이되 빠진 키를 허용한다(영어 사전용). */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };
