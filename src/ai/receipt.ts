// Cloud receipt: proof of exactly what left the device for each draft.
// Shown to the user next to the draft. Contains only redacted text, never real values.
// Pure functions (Web Crypto works in browsers and in Node), so tests run in Node.

export const POLICY_VERSION = 'local-1' // later: the Remote Config template version

export interface ReceiptStep {
  step: 'redaction' | 'cross-check' | 'names' | 'drafting' | 'restore'
  ranOn: string // 'on_device' | 'in_browser' | 'rules' | 'in_cloud'
  detail?: string
}

export interface CloudReceipt {
  /** The exact prompt sent to the cloud (redacted). */
  sentText: string
  /** SHA-256 of sentText, hex. Lets anyone verify the text wasn't changed. */
  sha256: string
  model: string
  policyVersion: string
  sentAt: string
  steps: ReceiptStep[]
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function buildReceipt(
  sentText: string,
  model: string,
  steps: ReceiptStep[],
  sentAt = new Date(),
): Promise<CloudReceipt> {
  return {
    sentText,
    sha256: await sha256Hex(sentText),
    model,
    policyVersion: POLICY_VERSION,
    sentAt: sentAt.toISOString(),
    steps,
  }
}
