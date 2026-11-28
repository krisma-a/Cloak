// The cloud-drafting kill switch (Remote Config: cloud_drafts_enabled). Pure, so `npm test` can run it.
//
// draft() asks first and makes no cloud call when drafting is paused. Hiding, review, "what the cloud saw" and
// scanning run on this laptop and don't come through here.

import { CloudPausedError } from './errors.ts'

export const PAUSED_NOTICE = 'Drafting is paused right now. Your notes were still hidden on this device, and nothing was sent.'

type Switch = { cloud_drafts_enabled: boolean }

/** True while the kill switch is off. */
export function cloudDraftsPaused(policy: Switch): boolean {
  return policy.cloud_drafts_enabled === false
}

/** Throws CloudPausedError while paused. */
export function assertCloudDraftsEnabled(policy: Switch): void {
  if (cloudDraftsPaused(policy)) throw new CloudPausedError(PAUSED_NOTICE)
}

/** Runs `call` (the cloud call) only if drafting is on. While paused it is never started. */
export async function whenCloudDraftsEnabled<T>(policy: Switch, call: () => Promise<T>): Promise<T> {
  assertCloudDraftsEnabled(policy)
  return call()
}
