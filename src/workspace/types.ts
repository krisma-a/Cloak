// Shared types for the case workspace. The data shapes come straight from Pam's AI code,
// so the real functions can be connected later without changing any screen.

import type { DraftResult } from '../ai/draft.ts'
import type { PlaceholderMap } from '../ai/placeholders.ts'
import type { RedactionResult } from '../ai/redact.ts'
import type { AccommodationPlan } from '../ai/restrictionPrompt.ts'
import type { TemplateId } from '../ai/templates.ts'

export type { AccommodationPlan, DraftResult, PlaceholderMap, RedactionResult, TemplateId }

export type StepId = 'paste' | 'review' | 'generate' | 'result'
