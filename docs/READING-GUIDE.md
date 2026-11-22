# Reading guide: how Cloak's backend works

For the teammate who will build the front end. You do not need an AI assistant: this guide gives
you a reading order, what to look for in each file, and ways to run the code to see it work.
Plan on about 4 to 5 hours, in three sittings. Read the backend first; the front end only calls it.

---

## 0. Set up (10 minutes)

```bash
git pull
npm install
npm test          # should end with: fail 0   (79 tests passed when this was written)
npm run dev       # then open http://localhost:5173/smoke.html
```

- `npm test` needs nothing else. The tests never touch Firebase.
- The smoke page and anything that calls the cloud need the `.env.local` file. It is not on
  GitHub on purpose (Git ignores `*.local`). Ask your teammate to send it privately.
- Fake data only. Never paste a real case note anywhere.

**TypeScript in 2 minutes.** `import`/`export` share code between files. `interface` and `type`
describe the shape of data and disappear when the code runs. `async`/`await` means "wait for this
slow thing (a model) to finish". `x?: string` means optional. The `.ts` in import paths is on
purpose. Every file starts with a comment that says what the file is for: read that first.

---

## 1. The big idea (5 minutes)

Cloak helps an HR person write case summaries without private details leaving their laptop.

```
raw case note  (never leaves the laptop)
   |  1. REDACT   find private details, swap each for a placeholder like [EMPLOYEE_1]
   |  2. CHECK    fixed rules re-scan the result for anything still visible
   |  3. GUARD    approved? names checked? still clean?  if not, STOP
   |  4. DRAFT    cloud Gemini writes from the placeholder text only
   |  5. RESTORE  real values are put back, on the laptop, then forgotten
   v
final draft + a receipt that proves exactly what was sent
```

Words you will see everywhere:

| Word | Meaning |
|---|---|
| **entity** | One private thing found in the text: `{ text: "Maria Santos", category: "PERSON" }` |
| **placeholder** | What replaces it: `[EMPLOYEE_1]`. The same person always gets the same one. |
| **map** (`PlaceholderMap`) | The in-memory table `[EMPLOYEE_1]` to `Maria Santos`. Never saved or sent. |
| **engine** | The tool that finds entities: `nano`, `browser-model` or `rules-only` |
| **guard** | The check that refuses to send when something is unsafe |
| **withhold** | Placeholders that must NOT be restored in some drafts (they become `[withheld]`) |
| **receipt** | Record of the exact text sent, its hash, the model and where each step ran |

The three engines (the **Engine** dropdown on the smoke page):

- **Gemini Nano**: Chrome's built-in model. Best. Only on capable laptops.
- **In-browser model**: a small name-finding model that runs in the page, plus fixed rules. Any browser.
- **Rules only**: fixed patterns and a medical word list. Cannot find names, so the user must list them.
- **Auto** picks the best one that works.

---

## 2. Reading order

Read in this order. Each file builds on the one before it. "Run it" lines are optional but are the
fastest way to understand.

### Part A. Pure logic (runs in Node, has tests, no Firebase). About 2 hours.

| # | File | Lines | What it does | Look for |
|---|---|---|---|---|
| 1 | `src/rules/rules.ts` | 101 | `findLeaks(text)`: fixed patterns for SSN, email, phone, salary, ids, "the only ..." phrases | The `PATTERNS` list, the `INDIRECT` regex, why a match containing `[` is skipped |
| 2 | `src/ai/placeholders.ts` | 309 | Swap entities for placeholders (`applyEntities`) and back (`restore`) | `PREFIX` table, `applyEntities` top to bottom, `restore`, `findPlaceholders` |
| 3 | `src/ai/ruleEntities.ts` | 43 | Turns rule matches and medical words into entities for the backup engines | `MEDICAL_TERMS` |
| 4 | `src/ai/guard.ts` | 59 | The send guard and the "names unchecked" logic | `sendBlockReason`, `redactionBlockReason` |
| 5 | `src/ai/templates.ts` | 146 | The three draft types, what each may restore, the manager-email prompt | `withhold`, `input`, `buildManagerPrompt`, `checkDraft` |
| 6 | `src/ai/receipt.ts` | 43 | Proof of what was sent | `buildReceipt` |
| 7 | `src/ai/redactPrompt.ts` | 97 | The prompt and JSON schema for Gemini Nano's redaction | `INSTRUCTIONS`, `ENTITY_SCHEMA`, `parseEntities` |
| 8 | `src/ai/restrictionPrompt.ts` | 204 | Turns medical details into work restrictions, plus the safety checks | `restrictionProblem`, `cleanRestrictions`, `accommodationBlockReason` |
| 9 | `src/ai/browserModel.ts` | 117 | Skim only. Loads the in-browser name model; returns people and places | The top comment |

**How to read a file with its test.** Open `src/ai/placeholders.ts` and `src/ai/placeholders.test.ts`
side by side. Read one test, then find the function it calls. Tests are small worked examples
with the right answers written in.

**Run one test file:**
```bash
node --test src/ai/placeholders.test.ts
```
**Try it yourself.** Make a file `scratch.ts` in the project folder (do not commit it):
```ts
import { applyEntities, restore } from './src/ai/placeholders.ts'
import { findLeaks } from './src/rules/rules.ts'

const note = 'Joy is the only woman on the night warehouse crew. Salary $68,500.'
const { text, map } = applyEntities(note, [
  { text: 'Joy', category: 'PERSON' },
  { text: 'the only woman on the night warehouse crew', category: 'ROLE' },
])
console.log(text)            // what the cloud would see
console.log(map.originals)   // what stays on the laptop
console.log(restore(text, map))
console.log(findLeaks(text)) // what the rules still catch (the salary)
```
```bash
node scratch.ts
```
Change the note and the entities and run it again. Break a test on purpose (edit an expected
string) and read the failure message, then change it back.

**Check yourself after Part A:**
1. Why does `applyEntities` replace the longest strings first?
2. Why does the leak check skip any match that already contains a `[`?
3. What turns a placeholder into `[withheld]`?
4. What does `names: 'unchecked'` mean, and what stops it from being sent?

### Part B. Code that talks to models (needs Firebase and a browser). About 1.5 hours.

| # | File | Lines | What it does | Look for |
|---|---|---|---|---|
| 10 | `src/firebase.ts` | 95 | Starts Firebase: App Check, anonymous sign-in, and the three models | The three `get...Model` functions and their `InferenceMode` |
| 11 | `src/ai/inference.ts` | 17 | One wrapper for every model call; logs where it ran | `generateLogged` |
| 12 | `src/ai/redact.ts` | 237 | The redaction controller: picks an engine, retries, falls back | `redactWithNano` (the retry loop), `redactWithoutNano`, `prepareRedaction`, `redact` |
| 13 | `src/ai/restrict.ts` | 63 | On-device step that suggests work restrictions | `deriveRestrictions` |
| 14 | `src/ai/draft.ts` | 88 | **The only place anything goes to the cloud** | The order: guard, build prompt, generate, check, restore, receipt |
| 15 | `src/ai/tag.ts`, `src/ai/caseType.ts` | 51, 10 | Case tagging and tone rewrite (small tasks) | `tagCaseType`, `rewriteTone` |

The three models in `src/firebase.ts`:

| Job | Function | Mode | Why |
|---|---|---|---|
| Find private details | `getRedactionModel` | `ONLY_ON_DEVICE` | Raw text must never reach the cloud, even if the on-device model fails |
| Tag case type, tone rewrite | `getTaggingModel` | `PREFER_ON_DEVICE` | Input is already redacted, so a cloud fallback is safe |
| Write drafts | `getDraftingModel` | `ONLY_IN_CLOUD` | Long output needs the bigger model; input is redacted only |

Not used by the code yet: Firestore (`firestore.rules` exists, nothing reads or writes it) and
Remote Config (`remoteconfig.template.json` is empty). Do not look for them in `src/ai`.

**Run it.** On the smoke page, open the browser console (F12). Every model call prints
`[inference] <label>: on_device` or `in_cloud`. It never prints the text.

**Check yourself after Part B:**
1. Which one function can send data to the cloud? What must be true first?
2. What happens if Nano misses a name? (Look at `redactWithNano`.)
3. If Nano crashes halfway, what does `redact` do?
4. Why is redaction `ONLY_ON_DEVICE` but tagging `PREFER_ON_DEVICE`?

### Part C. The front end that exists. About 30 minutes.

| File | What it is |
|---|---|
| `smoke.html` and `src/smoke.tsx` | A developer-only test page. **Your best example of how the front end calls the backend.** |
| `src/main.tsx`, `src/App.tsx`, `index.html` | The real app entry. `src/App.tsx` is still the untouched Vite starter. |

Read `src/smoke.tsx` top to bottom and follow each button to the backend function it calls:
`redactNote`, `hideTypedNames`, `findRestrictions`, `draftNote`. The real screens will call the
same functions in the same order.

### Part D. Test data. Skim only.

`scripts/generate-cases.ts` writes 120 fake notes with answer keys to `data/cases/`. Read its top
comment and the `CaseNote` type. Do not read all 798 lines. Run it with `npm run gen:cases`.

---

## 3. Follow one note start to finish

Trace this in the code with the smoke page open:

1. **Click "4. Redact note"** calls `prepareRedaction()` then `redact()` in `src/ai/redact.ts`.
2. The engine finds entities. Rules come from `src/ai/ruleEntities.ts` and `src/rules/rules.ts`.
3. `applyEntities()` in `src/ai/placeholders.ts` swaps each entity for a placeholder and fills the map.
4. `findLeaks()` re-checks. Anything left means `status: 'blocked'`.
5. The page shows "what the cloud would see". If `names` is `unchecked`, the names box appears (`src/ai/guard.ts`).
6. **Click "5. Approve & draft"** calls `draft()` in `src/ai/draft.ts`.
7. `sendBlockReason()` runs first. If it returns a message, nothing is sent.
8. `buildDraftPrompt()` (or `buildManagerPrompt()` for a manager email) makes the text sent to the cloud.
9. The cloud answers. `checkDraft()` flags invented placeholders and withheld details.
10. `restore()` puts real values back, on the laptop. `buildReceipt()` records what was sent.

---

## 4. Function cheat sheet for building screens

In the order a screen flow would call them:

| Step | Call | Returns |
|---|---|---|
| Pick engine (from a button click) | `prepareRedaction(onProgress?, 'auto')` in `src/ai/redact.ts` | `{ engine, note? }` |
| Redact | `redact(text, { engine })` | `RedactionResult`: `status`, `redactedText`, `map`, `names`, `needsCarefulReview`, `leaks` |
| Names box (rules-only) | `splitNames`, `hideNames`, `confirmNoNames` in `src/ai/guard.ts` | a new `RedactionResult` |
| Restrictions (manager email) | `deriveRestrictions(redaction)` in `src/ai/restrict.ts` | `{ items, dropped, source, note? }` |
| Check a restriction plan | `accommodationBlockReason(plan, map, redactedText)` | a message, or `null` if fine |
| Draft | `draft(redaction, templateId, { approved: true, accommodation? })` in `src/ai/draft.ts` | `{ draftWithPlaceholders, restoredDraft, warnings, receipt }` |
| Tag / tone | `tagCaseType(redaction)`, `rewriteTone(redaction, tone)` in `src/ai/tag.ts` | a case type / rewritten text |

Screen rules the backend assumes:
- Show `needsCarefulReview` loudly: the weaker engines can miss things.
- Only enable "Approve & draft" after the user has seen the redacted text. Pass `approved: true` only then.
- `draft()` throws `SendBlockedError` when the guard refuses. Show its message; it is not a crash.
- Never store or log the map, the raw note, or `restoredDraft`.

---

## 5. Answers to the check-yourself questions

Part A: (1) So "Maria Santos" is replaced as one piece before "Maria" alone, which would
leave "Santos" behind. (2) A match with `[` in it is already partly hidden by a placeholder, so
it is not a leak. (3) `restore()` with that placeholder's prefix in the `withhold` list.
(4) The rules-only engine cannot find names; the guard blocks sending until the user lists the
names or confirms there are none.

Part B: (1) `draft()` in `src/ai/draft.ts`; `sendBlockReason()` must return `null`. (2) The
in-browser name model cross-checks, the leak check runs, misses go back to Nano with up to 2
retries, and if something still leaks the result is `blocked`. (3) It falls back to the
in-browser model, then to rules only, and records why. (4) A failed redaction must never
fall back to the cloud with raw text, but tagging only ever sees redacted text.

---

## 6. What is not built yet (so you are not confused)

- The real front end: `src/App.tsx` is the Vite starter. Only the smoke page works.
- Gemini Nano itself has never run on our machines. The prompts for it are untested on the real model.
- Firestore and Remote Config are set up in `firebase.json` but nothing in `src/` uses them yet.
- `tagCaseType` and `rewriteTone` are not on any page.
- The generated case sets are not scored against redaction yet.
- The restriction step and its legal rationale (29 CFR 1630.14) are explained at the top of
  `src/ai/restrictionPrompt.ts`. It is not legal advice.
