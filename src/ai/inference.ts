// One wrapper for every model call, so each one logs where it really ran.
// Logs only the label and inferenceSource ("on_device" or "in_cloud"), never the prompt or reply.

import type { GenerativeModel } from 'firebase/ai'

export interface Generated {
  text: string
  /** Where the SDK says this call ran. "unknown" if the SDK didn't report it. */
  source: string
}

export async function generateLogged(label: string, model: GenerativeModel, prompt: string): Promise<Generated> {
  const result = await model.generateContent(prompt)
  const source = result.response.inferenceSource ?? 'unknown'
  console.info(`[inference] ${label}: ${source}`)
  return { text: result.response.text().trim(), source }
}
