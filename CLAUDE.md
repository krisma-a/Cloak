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
npm run dev          # Vite on :5173. App at /, hidden eval page at /eval and usage dashboard at /usage (unlinked, in the build), dev-only test page at /smoke.html (not in the build)
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
and `VITE_CLOUD_MODEL` (only the built-in default for `cloud_model`; Remote Config overrides it). `npm test` needs none of it.

## Architecture

**The pipeline (the product's whole point).** Raw note → redact on this device → fixed-rule leak
re-check → send guard → cloud drafts from placeholder text only → restore real values on this device.
The placeholder map (`PlaceholderMap`: `originals` + `lookup`) lives in memory only; it is never
stored, logged or sent. Firestore holds only the counts-only send log (see **Send log**); the Remote Config template is empty.

**Pure vs Firebase split — the key convention.** Anything importing `../firebase` (`redact.ts`,
`restrict.ts`, `tag.ts`, `draft.ts`, `smoke.tsx`) cannot run under `node --test` (it uses
`import.meta.env`). So logic lives in pure siblings and the Firebase files stay thin: prompts/schemas/
parsing in `redactPrompt.ts` and `restrictionPrompt.ts`, `caseType.ts`, guard logic in `guard.ts`,
templates in `templates.ts`. Put new logic in a pure file and test it; only the model call goes in the
Firebase file.

**Model modes** (`src/firebase.ts`): redaction = `ONLY_ON_DEVICE` (must never fall back to cloud),
tagging/tone = `PREFER_ON_DEVICE`, drafting = `ONLY_IN_CLOUD`. All calls go through
`generateLogged()` in `inference.ts`, which logs the label and `inferenceSource` only — never prompt or
reply text. The cloud model is the Remote Config setting `cloud_model` (see Runtime settings). Cloud calls on
Gemini 3.x send `thinkingLevel: LOW` (`cloudConfig.ts`, pure): about 4× fewer tokens, same text sent.

**Three redaction engines** (`redact.ts`): `nano` (Gemini Nano; best; retries up to `max_retries`, then
`blocked`), `browser-model` (in-browser name model in `browserModel.ts` + rules), `rules-only`. Rules can't
find names, so `RedactionResult.names` is `'unchecked'` for `rules-only` and the guard blocks sending
until the user lists names or confirms none (`guard.ts`). The weaker engines set `needsCarefulReview`.

**Safety net** (`safetyNet.ts`, pure): on the Nano path, after Nano's pass and the name cross-check, everything a rule
or keyword list can find (incl. ages, more salary formats, team phrases, quoted nicknames, split hyphenated names) is
HIDDEN by code, not just used to retry/block. Tuned on Set A only; Set B stays the holdout (see `results/RESULTS.md`).

**Usage tracking** (`usage.ts` pure, `usageStore.ts` Firestore): `generateLogged()` saves one record per model call to
`usageEvents/{id}`: label, model, where it ran, token counts (Nano's are estimated, ~4 chars/token) and the paid-tier
price (`PRICES`, dated `PRICE_VERSION`; on-device = $0). No text, no user id, so any signed-in visitor can read them.
Best effort, never awaited. The hidden `/usage` page (`src/usage/`) is a live dashboard over them (Firestore `onSnapshot`).
`firestore.rules` must match `usage.ts` (`usage.test.ts` checks); the /eval page marks its calls `origin: 'eval'`.

**Placeholders** (`placeholders.ts`): the model only *finds* entities; code does the replacing so the same
thing always gets the same placeholder. Category name ≠ placeholder prefix (`PREFIX` table: `PERSON`→
`EMPLOYEE`, `MEDICAL`→`MEDICAL_DETAIL`, `DEPARTMENT`→`DEPT`, `DATE_OF_BIRTH`→`DOB`, `EMPLOYEE_ID` and
`OTHER_ID`→`ID`). `restore()` accepts reformatted placeholders (case, spacing, markdown escapes) but leaves
look-alikes that aren't in the map alone. Replacing, the note-spelling lookup and the KNOWN leak check all skip text inside
placeholders (`maskPlaceholders()`), and a bare placeholder name a model echoes back ("PHONE_1") is never an entity: otherwise
a form label like "Employee" turned `[EMPLOYEE_1]` into `[[ROLE_1]_1]` and dropped the name from the map. Role+team phrases are split into `[ROLE_n] in the [DEPT_n]`.

**Runtime settings (Firebase Remote Config).** `src/policy.ts` (pure) defines four settings: `redact_salary`,
`medical_mode` (`generalize` | `block`), `max_retries` (0–5), `cloud_model`. Code reads them with `getPolicy()` at
the moment it runs; never cache the result. `src/remoteConfig.ts` fetches on load (started from `main.tsx` via a
lazy import, so failure leaves the built-in defaults) and keeps them live with `onConfigUpdate`. Unreadable values
fail toward more privacy. `redact_salary=false` is honoured in `findLeaks()` and for Nano's SALARY answers only;
work restrictions always reject money (`findLeaks(..., { ignorePolicy: true })`). `medical_mode=block` is
enforced in `redactionBlockReason()` (guard.ts), so it covers drafting, tagging and tone. Template:
`remoteconfig.template.json`; demo steps: `docs/DEMO-REMOTE-CONFIG.md`. Tests that change a setting must
`resetPolicy()` afterwards.

**Local receipts.** `receiptLog.ts` (pure) wraps every model call (`draft()`, `tagCaseType()`, `rewriteTone()`)
in `recordedCall()`: a `pending` receipt (exact sent text, SHA-256, model, settings fingerprint, time) is written
BEFORE the call, then finished with the call's `inferenceSource`. If the receipt can't be saved, the call is not
made (`SendBlockedError`). Stored only in IndexedDB via `receiptStore.ts`, never in localStorage, Firestore or logs.
The web SDK does not expose the Remote Config template version, so receipts carry a fingerprint of the four values.

**Send log.** One record per send in Firestore at `users/{uid}/sendLogs/{id}`: counts per category, blocked or not,
settings version (the Remote Config fingerprint), model, where each step ran, user id. **Never any text.**
`sendLog.ts` (pure) builds the record by rebuilding it from fixed lists, so nothing it is handed can end up in it
(`buildSendLog()`), validates it (`validateSendLog()`) and makes the CSV (`sendLogsToCsv()`); `sendLogStore.ts` is the
thin Firestore part (`saveSendLog`, `fetchMySendLogs`, `downloadMySendLogsCsv`). `draft()` saves it best-effort and never
waits on it; a refused send is logged as `blocked`. Pass `logSend: null` to `draft()` to log nothing (the eval does).
`firestore.rules` allows only that exact shape, only for the owner, create and read only (no update or delete). Its lists and
patterns must match `sendLog.ts`; `sendLog.test.ts` reads the rules file and fails if they drift. If you add a placeholder
prefix, step or place, change both. The rules have not been run in the Firestore emulator (it needs Java); deploy with
`firebase deploy --only firestore:rules`.

**Eval page (`/eval`).** `src/eval/`: `score.ts` + `runner.ts` are pure (tested in Node, including the regex pipeline run on
all of Set B); `pipelines.ts` builds the three real pipelines (regex only, one Gemini Nano pass, full Cloak with retries and
the send guard); `EvalPage.tsx` is the UI. An item counts as caught when its text is gone from the output; a name also counts as
missed if any part of it is still visible. It loads only `data/cases/set-b.json` (fake data), exports a JSON report, and can
time the cloud draft for a few notes (opt-in; sends hidden fake text through `draft()` with no receipts or send log).

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
in `src/workspace/`. Screens import AI **only** through `src/workspace/ai.ts`. Its `redactNotes()` is the REAL
on-device redaction (`prepareRedaction` + `redact`, loaded lazily so Firebase stays out of the first screen); restrictions
and drafting are still the placeholders from `fakeAi.ts` (`DEMO_MODE = true`: nothing is sent anywhere). The comment block in
`ai.ts` says how to switch those to the real `src/ai` functions. `redactNotes()` must run from a button click (Chrome only
starts the Nano download after a click). `aiStatus.ts` (pure, tested) turns what it reports (which model is loading,
download progress, which engine is ready) into the header pill ("Private AI ready" / "Downloading private AI…" /
"Basic checks") and the loading card's label. Progress arrives only while Chrome is really downloading; a model already on
the laptop goes straight to "ready". The first-time Nano download is about 4 GB, so the loading card offers "Use basic
checks for now": `redactNotes()` then stops waiting, checks with the backup engine, and lets the Nano download finish in the
background (`nanoInBackground`; later checks use the basic engine until it ends, because Chrome reports progress to the
first caller only). The pill shows a spinner cue meanwhile, then "Private AI ready", and the next check uses Nano. `review.ts` holds the review screen's pure logic: `base` is the
redaction with every detail still a placeholder, `kept` is what the user chose to leave visible, and what
is sent is `outgoing(base, kept)`, not `base`. "Hide as Other" can take the person's own label (`customPrefix()`: "Client" →
`[CLIENT_1]`, letters only, ≤ 20; refused if it repeats a hidden detail, `labelGivesAway()`). Custom prefixes aren't in
`PLACEHOLDER_PREFIXES`, so the send log simply doesn't count them.

**Scan a document** (`src/workspace/StepScan.tsx`, imports only `scanAi.ts`). OCR (`src/camera/ocr.ts`, Tesseract.js, own
files) and blackout are real and on-device. `src/camera/blackoutPlan.ts` (pure, tested) matches every hidden string to OCR
words (look-alikes 0/O, 1/l folded, across line breaks); found only in the text → whole line blacked + review; found nowhere,
or boxes outside the image → `blocked` (nothing painted, page can't be downloaded). Words under 60 confidence trigger a
"check closely" note (no outlines on the picture); more than 15% of them → the copy is still made but marked `unclear`, and the result screen warns that details
may have been missed and it's risky to share or draft from. A photo always reaches the result screen (original + copy, or why
there's no copy). While the camera is live, one frosted pane covers the text on the video (`previewLines()` → `textLines()`
→ `textRegion()`; OCR only, no redaction, so nothing private can show or be missed). `useFrostPane` glides it every frame
with `stepRegion()`: edges grow fast (~0.1 s) and shrink slowly (~0.45 s). Only real words count (`isRealWord()`: confidence
≥ 60, two+ letters/digits, at least 3 words), so junk "words" OCR finds in faces don't pull the blur onto a person. It rests over
the middle until the first look, holds 1.2 s when text drops out, then fades out (no page in view, no blur). The photo gets the full check, then only private details stay hidden. The capture screen warns
when the setup is less safe than Chrome with the private AI (`browserAdvice()`: other browser, phone, or no Nano), offers a
Camera chooser when there are 2+ cameras (`cameraChoices()`, choice kept in localStorage `cloak.cameraId`), and a "Use your
phone as the camera" pop-up (`<dialog>`) with two ways: a QR code that opens Cloak on the phone (drawn by `qr.ts`, our own
encoder: byte mode, level M, versions 1–10, so no outside QR service or library; on localhost it points at cloak.web.app), and
the safer "use it as this laptop's camera" (Continuity Camera / Phone Link + Find my phone camera, which waits up to 10 s
for the phone and picks a phone-named camera or one that wasn't there before, `pickPhoneCamera()`; on a miss it lists the
cameras it can see). Never the phone's camera
app. The QR only opens the site: no pairing or streaming between devices (that would need a relay). The result screen is one picture with a wipe handle (copy left, original right) plus a "What's hidden" list. **Hide more** on the result screen lets the person black out what Cloak skipped: click a word (`wordAt()` on the stored OCR words)
or drag a box (`boxFromCorners()`); boxes are painted onto the copy at once (so downloads have them), listed as "Hidden by you",
undoable (the copy before hand-made boxes is kept in `baseRef`), and the words under them become `[HIDDEN]` in the text sent for
drafting (`draftTextWithout()`). The live preview takes the camera's own shape (`--ratio`), as tall as the space left (the safety
note sits below it), with an upright Letter outline (`paperGuide()`). When a phone's camera appears (a nearby iPhone via Continuity Camera, Phone Link…), a small prompt over the preview asks "Use phone camera instead?" (`phoneCameraToOffer()`: not on a phone, not already in use, once per camera per page visit after "Not now"). "Draft a report" opens a review-first pop-up (what stays vs what is sent), then hands the page text
(cleaned of OCR noise by `draftTextFromOcr()`; memory only) to the normal note pipeline: hidden on this laptop → check-details screen → report type → send guard. `blackout.ts` adds the real redaction (`redactNotes()`, so the Basic-checks choice applies) and canvas. Only
`redactedText` may ever be sent; never the image. Uploading a PDF draws each page (up to 30, ~150 dpi) with pdf.js in `src/camera/pdf.ts` (`pdfjs-dist`,
Apache-2.0; its worker, standard fonts and JBIG2/JPEG 2000/colour wasm are served from our own `/pdf/` files by
`scripts/vitePdfAssets.ts`, never a CDN) and sends the pictures through the same OCR and blackout as a photo;
password-protected, too-long and damaged PDFs get their own messages (`PdfScanError`, `pdfProblem()`). HEIC photos get
their own message (Chrome can't open them). The redacted-PDF writer is `redactedPdf.ts`. Auto-capture
(`useAutoCapture`, `stepAutoCapture()`): once real text is steady and readable for 1.5 s the photo is taken by itself, with a
"Hold still…" ring and an on/off switch (localStorage `cloak.autoCapture`). The finished draft downloads as a PDF made by
`textPdf.ts` (our own writer: US Letter, built-in Helvetica, no outside library); the phone pop-up opens on the camera list.

**Specs notice** (`specs.ts` pure, `SpecsNotice.tsx`, shown from `App.tsx`): a one-time pop-up ("Cloak runs best on…") for
slower or unsupported setups: not Chrome, Chrome without Nano, a phone, under 4 cores or under 8 GB reported memory (with Nano
ready, only cores/memory count, and it offers "Use basic checks"). A spec sheet compares Chrome's built-in AI requirements
(Win 10/11, macOS 13+, Linux, Chromebook Plus; GPU > 4 GB or 16 GB RAM + 4 cores; 22 GB free) with this device; disk and
exact memory say "can't tell". Dismissal is kept in localStorage `cloak.specsSeen` (bump `SEEN_VERSION` to show it again).

**Drafting mode and usage** (`workspace/ai.ts`, `draftCost.ts`, `UsageDialog.tsx`, `ModeDialog.tsx`). Drafting is **Demo** (fakeAi.ts, nothing sent; the
default) or **Real AI** (`ai/draft.ts`): switch it with the Demo / Real AI switch under the heading of the "Write the draft" screen (`DraftingMode.tsx`), the header chip (opens its own small `ModeDialog`), or with `?ai=real` / `?ai=demo` in the address
(kept in localStorage `cloak.realAi`); flip `DEFAULT_REAL_AI` in ai.ts to make Real the default. `generateLogged()` now returns the
call's `usage` (token counts + paid-tier price), `draft()` puts it on `DraftResult.usage`, and the screens show an estimate
before sending (`estimateDraftCost()`), the cost after, and the header's **Usage** pop-up (last draft's itemised receipt, drafts, tokens and cost on this laptop, monthly planner). A numbers-only history of drafts stays in
localStorage `cloak.draftCosts` (demo drafts are listed but never counted as spend). First real draft (2026-11-25): 250 in,
119 out, **622 thinking** tokens = $0.0059 on the paid tier, 80% of it thinking: thinking is the main cost lever.

**Test data.** `scripts/generate-cases.ts` writes 120 deterministic fake notes (seeded; Set A/B use disjoint
name pools) with a planted-item answer key whose `type` values are the app's `Category` names. Output must
stay byte-identical for the same seed. The generated sets are not yet scored against redaction, and the
answer key lists a role phrase as one `ROLE` item although redaction now splits it into ROLE + DEPARTMENT.

## Gotchas

- Gemini Nano has never run on the dev machines. The Claude desktop app's built-in browser reports
  `LanguageModel.availability()` = `unavailable`; test Nano in real Chrome (148+, enough disk/GPU/RAM).
  Without Nano everything falls back and the manager-email restrictions must be typed by hand.
- On `/eval` without Nano, "on-device model only" is skipped (never faked) and "full Cloak" runs on the backup name model,
  which is labelled in the results. Nano numbers need real Chrome.
- The cloud draft takes about 15–60 s on the free tier, and the wait is Google's server, not tokens or our code
  (on 2026-11-24 a one-word reply took 62 s). The free-tier quota is per project, so everyone using the hosted
  app shares it; a few calls a minute already returned 429.
- `docs/READING-GUIDE.md` is a reading order for the backend (written before the front end landed).
- The team is two people working in parallel on the AI/backend layer (`src/ai`, `src/rules`) and the front
  end (`src/App.tsx`, `src/workspace`). They prefer short answers with exact commands to copy.
