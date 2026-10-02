import type { settings as ko } from "../ko/settings";
import type { DeepPartial } from "../types";

export const settings: DeepPartial<typeof ko> = {
  general: {
    title: "General",
    description: "Appearance, notifications, the browser, and how Claude and Codex run.",
  },
  update: {
    title: "Updates",
    description: "Compares this app with the latest release on GitHub. If you installed with Homebrew, you can update right here.",
    currentVersion: "Current version",
    idle: "Not checked yet.",
    checking: "Checking…",
    available: "A new version is available: {{version}}",
    latest: "You're on the latest version.",
    notBrew: "This app wasn't installed with Homebrew, so download the DMG from the release page.",
    upgrading: "Updating to {{version}}… This can take a minute or two.",
    done: "Updated to {{version}}. Restart to open the new version.",
    checkFailed: "Couldn't check for updates: {{error}}",
    notes: "What's new",
    releasePage: "Release page",
    relaunch: "Restart",
    run: "Update",
    check: "Check for updates",
  },
  language: {
    title: "Language",
    description: "The language used in the app. Menus and some messages may still appear in Korean.",
    options: {
      system: { label: "Match system", hint: "Follows the macOS language setting." },
      ko: { label: "한국어", hint: "Always use Korean." },
      en: { label: "English", hint: "Always use English." },
    },
  },
  theme: {
    title: "Appearance",
    description: "Doesn't apply to websites shown in the in-app browser.",
    options: {
      system: { label: "Match system", hint: "Changes with the macOS appearance." },
      light: { label: "Light", hint: "Always use a light background." },
      dark: { label: "Dark", hint: "Always use a dark background." },
    },
  },
  notify: {
    options: {
      always: { label: "Always", hint: "Sends a macOS notification when a response finishes. Click it to jump to that tab." },
      unfocused: { label: "Only when I'm away", hint: "Notifies you when you're in another app or another chat tab." },
      off: { label: "Off", hint: "No notification when a response finishes. Approval requests still notify you." },
    },
  },
  link: {
    options: {
      ask: { label: "Ask every time", hint: "Choose where to open each link. Turn on \"Remember\" in the chooser to reuse your choice." },
      app: { label: "In-app browser", hint: "Opens in a browser tab in the right panel." },
      external: { label: "Default browser", hint: "Opens in the macOS default browser." },
    },
  },
  warm: {
    options: {
      active: { label: "The tab I'm viewing", hint: "Starts Claude or Codex ahead of time when you open or switch to a tab, so the first response is faster." },
      off: { label: "Off", hint: "Starts when you send a message. Uses less memory while idle, but the first response takes longer to begin." },
    },
  },
};
