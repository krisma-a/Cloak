# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cloak: a Chrome web app that helps HR generalists at 50–500 person companies write case summaries,
investigation write-ups and manager emails without private details leaving the laptop. Built for the
Firebase AI Logic #BuildHybridAI hackathon (deadline Nov 30, 2026). Constraints: free Firebase tiers
only, **fake data only** (never put a real case note, name or ID in code, tests, fixtures or logs).
Stack: Vite + React 19 + TypeScript, Firebase JS SDK (`firebase/ai`, App Check, Auth).

## Commands

```bash
npm run dev          # Vite on :5173. App at /, dev-only test page at /smoke.html (not in the build)
npm test             # node --test "src/**/*.test.ts"
node --test src/ai/placeholders.test.ts                                   # one file
node --test --test-name-pattern="restores originals" src/ai/placeholders.test.ts   # one test
npx tsc -b           # type-check (also part of `npm run build`)
npm run lint         # oxlint (the smoke.tsx only-export-components warning is known)
npm run build        # tsc -b && vite build -> dist/
npm run gen:cases    # regenerate data/cases/set-a.json and set-b.json (fake notes + answer keys)
```

Tests and scripts run directly on Node's TypeScript type-stripping (developed on Node 26, no build
step). So: no `enum`, no constructor parameter properties (`erasableSyntaxOnly`), and relative imports
end in `.ts`. `tsconfig.app.json` excludes `*.test.ts`, so `tsc -b` does **not** type-check tests.

Cloud and on-device calls need `.env.local` (git-ignored; ask a teammate). Variables read in
`src/firebase.ts`: `VITE_FIREBASE_*`, `VITE_RECAPTCHA_SITE_KEY`, optional `VITE_APPCHECK_DEBUG_TOKEN`
and `VITE_CLOUD_MODEL`. `npm test` needs none of it.

## Architecture

**The pipeline (the product's whole point).** Raw note → redact on this device → fixed-rule leak
re-check → send guard → cloud drafts from placeholder text only → restore real values on this device.
The placeholder map (`PlaceholderMap`: `originals` + `lookup`) lives in memory only; it is never
stored, logged or sent. Firestore rules exist but no code uses Firestore (Remote Config template is empty).

**Pure vs Firebase split — the key convention.** Anything importing `../firebase` (`redact.ts`,
`restrict.ts`, `tag.ts`, `draft.ts`, `smoke.tsx`) cannot run under `node --test` (it uses
`import.meta.env`). So logic lives in pure siblings and the Firebase files stay thin: prompts/schemas/
parsing in `redactPrompt.ts` and `restrictionPrompt.ts`, `caseType.ts`, guard logic in `guard.ts`,
templates in `templates.ts`. Put new logic in a pure file and test it; only the model call goes in the
Firebase file.

**Model modes** (`src/firebase.ts`): redaction = `ONLY_ON_DEVICE` (must never fall back to cloud),
tagging/tone = `PREFER_ON_DEVICE`, drafting = `ONLY_IN_CLOUD`. All calls go through
`generateLogged()` in `inference.ts`, which logs the label and `inferenceSource` only — never prompt or
reply text. Cloud model is pinned in `CLOUD_MODEL`.

**Three redaction engines** (`redact.ts`): `nano` (Gemini Nano; best; retries up to `MAX_RETRIES`, then
`blocked`), `browser-model` (in-browser name model in `browserModel.ts` + rules), `rules-only`. Rules can't
find names, so `RedactionResult.names` is `'unchecked'` for `rules-only` and the guard blocks sending
until the user lists names or confirms none (`guard.ts`). The weaker engines set `needsCarefulReview`.

**Placeholders** (`placeholders.ts`): the model only *finds* entities; code does the replacing so the same
thing always gets the same placeholder. Category name ≠ placeholder prefix (`PREFIX` table: `PERSON`→
`EMPLOYEE`, `MEDICAL`→`MEDICAL_DETAIL`, `DEPARTMENT`→`DEPT`, `DATE_OF_BIRTH`→`DOB`, `EMPLOYEE_ID` and
`OTHER_ID`→`ID`). `restore()` accepts reformatted placeholders (case, spacing, markdown escapes) but leaves
look-alikes that aren't in the map alone. Role+team phrases are split into `[ROLE_n] in the [DEPT_n]`.

**Health details invariant.** `HEALTH_PREFIXES` (`MEDICAL_DETAIL`, `FAMILY_MEDICAL`) are withheld
(`[withheld]`) in **every** template (29 CFR 1630.14(c)(1): medical info stays out of case files and
manager emails). If you add a health-related category, add its prefix to `HEALTH_PREFIXES`. The
accommodation (manager) template has `input: 'restrictions'`: its cloud prompt is built by
`buildManagerPrompt()` from the user-approved work restrictions only — no case notes, no diagnosis.
`restrict.ts` (Nano) suggests restrictions; `restrictionPrompt.ts` rejects ones that name a health detail,
a person or a number; `accommodationBlockReason()` re-checks at send time.

**Drafting** (`draft.ts`) is the only code path that talks to the cloud: `sendBlockReason()` (approved,
status ok, names checked, fresh leak re-check) → prompt → `generateLogged` → `checkDraft()` → `restore()`
with the template's `withhold` list → receipt (exact text sent + SHA-256). It throws `SendBlockedError` when
refused; callers should treat that as a normal "blocked" state, not a crash.

**Front end.** `src/App.tsx` is a 4-step flow (paste → check details → write draft → result) with screens
in `src/workspace/`. Screens import AI **only** through `src/workspace/ai.ts`, which currently re-exports
`fakeAi.ts` (`DEMO_MODE = true`, nothing real is called). The comment block in `ai.ts` says exactly how to
switch to the real `src/ai` functions. `review.ts` holds the review screen's pure logic: `base` is the
redaction with every detail still a placeholder, `kept` is what the user chose to leave visible, and what
is sent is `outgoing(base, kept)`, not `base`. `redactNotes()` must run from a button click (Chrome only
starts the Nano download after a click).

**Test data.** `scripts/generate-cases.ts` writes 120 deterministic fake notes (seeded; Set A/B use disjoint
name pools) with a planted-item answer key whose `type` values are the app's `Category` names. Output must
stay byte-identical for the same seed. The generated sets are not yet scored against redaction, and the
answer key lists a role phrase as one `ROLE` item although redaction now splits it into ROLE + DEPARTMENT.

## Gotchas

- Gemini Nano has never run on the dev machines. The Claude desktop app's built-in browser reports
  `LanguageModel.availability()` = `unavailable`; test Nano in real Chrome (148+, enough disk/GPU/RAM).
  Without Nano everything falls back and the manager-email restrictions must be typed by hand.
- `docs/READING-GUIDE.md` is a reading order for the backend (written before the front end landed).
- The team is two people working in parallel on the AI/backend layer (`src/ai`, `src/rules`) and the front
  end (`src/App.tsx`, `src/workspace`). They prefer short answers with exact commands to copy.
