import type { WorkbenchApi } from "@shared/ipc";

declare global {
  interface Window {
    workbench: WorkbenchApi;
  }
}

export {};
