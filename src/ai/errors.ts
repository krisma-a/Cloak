/**
 * Thrown when a send is refused: the guard said no, the settings block it, or no receipt could be
 * saved first. The UI shows it as "blocked", not as a failure.
 */
export class SendBlockedError extends Error {
  override name = 'SendBlockedError'
}

/**
 * Thrown instead of a cloud call while the Remote Config kill switch (cloud_drafts_enabled) is off. Not a refused send:
 * nothing was wrong with the note, and nothing is logged as blocked. The UI shows a calm "paused" notice, not an error.
 */
export class CloudPausedError extends Error {
  override name = 'CloudPausedError'
}
