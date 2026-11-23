/**
 * Thrown when a send is refused: the guard said no, the settings block it, or no receipt could be
 * saved first. The UI shows it as "blocked", not as a failure.
 */
export class SendBlockedError extends Error {
  override name = 'SendBlockedError'
}
