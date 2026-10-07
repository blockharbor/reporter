/** Types shared between the main process, preload bridge, and renderer. */

import type { EngagementStatus } from '@reporter/shared';

export interface DesktopSettings {
  serverUrl: string;
  accessKey: string;
  /** Whether a secret key is stored (the secret itself is never sent to the renderer). */
  hasSecret: boolean;
  currentEngagementSlug: string | null;
  /** Capture command template with a `$FILE` placeholder (non-macOS / override). */
  captureCommand: string;
  hotkeys: { captureArea: string; captureWindow: string };
  /** True when the OS secret store is weak (Linux basic_text) — surfaced as a warning. */
  weakSecretStorage: boolean;
  /** False when global hotkeys can't work (Linux/Wayland) — surfaced as a warning. */
  globalShortcutsAvailable: boolean;
}

/** A patch to settings from the renderer. `secret` is write-only. */
export interface SettingsPatch {
  serverUrl?: string;
  accessKey?: string;
  secret?: string;
  currentEngagementSlug?: string | null;
  captureCommand?: string;
  hotkeys?: { captureArea: string; captureWindow: string };
}

export type QueueStatus = 'pending' | 'submitting' | 'submitted' | 'failed';

export interface QueueItem {
  id: string;
  engagementSlug: string;
  contentType: 'image' | 'codeblock' | 'none';
  /** Absolute path to the captured file (image evidence). */
  filePath?: string;
  /** Inline text (codeblock/note). */
  content?: string;
  contentSubtype?: string;
  /** Short, required human title for the evidence. */
  title: string;
  description: string;
  tagIds: number[];
  occurredAt: string;
  /** When set, upload this capture as linked evidence on the given evidence. */
  parentEvidenceUuid?: string;
  status: QueueStatus;
  serverUuid?: string;
  error?: string;
  createdAt: string;
}

export interface EngagementLite {
  slug: string;
  name: string;
  /** Lifecycle status, shown in the compose picker so you don't file into a
   *  finished engagement. Dates live in the web UI, not here. */
  status: EngagementStatus;
}

/** A slim piece of existing evidence, for the "Link to" picker in Compose. */
export interface EvidenceLite {
  uuid: string;
  /** Primary heading for the evidence — what the picker shows. May be empty on
   *  evidence created before titles existed (falls back to description, then type). */
  title: string;
  description: string;
  contentType: string;
  occurredAt: string;
  /** Whether this evidence is withheld from report output. Carried into the
   *  picker because exclusion is inherited: filing a capture under an excluded
   *  parent withholds the new capture too, with its own flag clear, so the tray
   *  has to say so before the link is made. */
  excludeFromReport: boolean;
}

export interface TagLite {
  id: number;
  name: string;
  colorName: string;
}

export interface ConnectionResult {
  ok: boolean;
  user?: string;
  error?: string;
}

/** App + runtime version info shown in the About view. */
export interface AboutInfo {
  productName: string;
  /** App version — the `apps/desktop/package.json` version stamped into installers. */
  version: string;
  /** Short git SHA the build was cut from (`unknown` outside a git checkout). */
  commit: string;
  /** ISO timestamp the bundle was built. */
  buildDate: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
  /** Project homepage / release page. */
  homepage: string;
  /** Server the desktop app is currently pointed at (from settings). */
  serverUrl: string;
}

/** Result of checking the release feed for a newer version. */
export interface UpdateCheckResult {
  status: 'up-to-date' | 'update-available' | 'error' | 'unknown';
  currentVersion: string;
  latestVersion?: string;
  /** Link to the release when an update is available. */
  releaseUrl?: string;
  error?: string;
}

/** Draft passed to the compose window after a capture. */
export interface CaptureDraft {
  contentType: 'image' | 'codeblock' | 'none';
  filePath?: string;
  content?: string;
  /** Data URL for previewing an image draft in the renderer. */
  previewDataUrl?: string;
}
