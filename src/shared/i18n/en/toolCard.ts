import type { toolCard as ko } from "../ko/toolCard";
import type { DeepPartial } from "../types";

export const toolCard: DeepPartial<typeof ko> = {
  state: {
    partial: "Preparing input",
    waiting_permission: "Awaiting permission",
    waiting_answer: "Awaiting answer",
    denied: "Denied",
    skipped: "Skipped",
    failed: "Failed",
    done: "Done",
    running: "Running",
  },
};
