import type { shared as ko } from "../ko/shared";
import type { DeepPartial } from "../types";

export const shared: DeepPartial<typeof ko> = {
  untitledTab: "New session",
  duration: {
    minSec: "{{min}}m {{sec}}s",
    sec: "{{sec}}s",
  },
  verify: {
    status: {
      running: "Running",
      passed: "Passed",
      failed: "Failed",
      aborted: "Stopped",
    },
    summary: {
      failedAt: "Command {{index}} failed ({{passed}}/{{total}} passed)",
      running: "Running {{index}}/{{total}}",
      aborted: "Stopped after {{passed}}/{{total}} passed",
      passed: "{{passed}}/{{total}} passed",
    },
  },
  jobs: {
    elapsed: "{{label}} · {{time}} elapsed",
    summary_one: "{{count}} job · {{time}} elapsed",
    summary_other: "{{count}} jobs · {{time}} elapsed",
  },
};
