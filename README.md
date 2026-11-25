# Cloak

Write HR case summaries and manager emails with AI, without names, health details or pay leaving your laptop.

![Cloak screenshot](docs/screenshot.png)
<!-- Screenshot placeholder: add docs/screenshot.png -->

Live: [cloak.web.app](https://cloak.web.app). Best in desktop Chrome. Built for the Firebase AI Logic #BuildHybridAI hackathon.

## Run it in 3 commands

```bash
npm install
cp .env.example .env.local   # then fill in your Firebase web app config
npm run dev
```

Open http://localhost:5173. `npm test` needs no config.

## How it works

| Step | Where it runs | Why |
| --- | --- | --- |
| Paste the case notes | On device | The raw note never leaves the browser. |
| Hide private details (Gemini Nano + a rule safety net) | On device (`ONLY_ON_DEVICE`) | Names, health details and pay must never reach the cloud. Slow laptops can pick "Basic checks only". |
| Leak re-check and send guard | On device | Refuses to send if a known detail is still visible. |
| You review every hidden detail | On device | A person makes the final call. |
| Tag the case type, rewrite the tone | On device first (`PREFER_ON_DEVICE`) | The text is already hidden, so the cloud is a safe fallback. |
| Write the draft | Cloud, Gemini 3.6 Flash (`ONLY_IN_CLOUD`) | Longer writing needs a bigger model. It only sees placeholders like `[EMPLOYEE_1]`. |
| Put the real names back | On device | The placeholder map stays in memory and is never sent. |

Hidden pages: [`/eval`](https://cloak.web.app/eval) scores redaction on fake notes, and [`/usage`](https://cloak.web.app/usage) is a live board of tokens and cost per model call.

## Firebase products used

| Product | What it does here | Files |
| --- | --- | --- |
| AI Logic (hybrid inference) | Gemini Nano on device for redaction, Gemini in the cloud for drafting | [src/firebase.ts](src/firebase.ts), [src/ai/redact.ts](src/ai/redact.ts), [src/ai/draft.ts](src/ai/draft.ts), [src/ai/tag.ts](src/ai/tag.ts) |
| App Check | Only the real app can call the AI (reCAPTCHA Enterprise) | [src/firebase.ts](src/firebase.ts) |
| Auth | Anonymous sign-in, no account needed | [src/firebase.ts](src/firebase.ts) |
| Firestore | Counts-only send log and usage records, never any text | [src/ai/sendLogStore.ts](src/ai/sendLogStore.ts), [src/ai/usageStore.ts](src/ai/usageStore.ts), [firestore.rules](firestore.rules) |
| Remote Config | Privacy settings and the cloud model, changed live without a redeploy | [src/remoteConfig.ts](src/remoteConfig.ts), [src/policy.ts](src/policy.ts), [remoteconfig.template.json](remoteconfig.template.json) |
| Hosting | Serves the app | [firebase.json](firebase.json) |

## Results

Set B: 60 fake notes, 516 planted private details, Gemini Nano in Chrome 157. Full details in [results/RESULTS.md](results/RESULTS.md).

| Method | Catch rate | Missed | Block rate | Avg on-device time |
| --- | --- | --- | --- | --- |
| Rules only | 31.8% | 352 | no blocking | 0.77 ms |
| AI only (one Gemini Nano pass) | 89.0% | 57 | no blocking | 2.3 s |
| Full Cloak | **99.0%** | 5 | 1.7% (1 of 60) | 2.8 s |

The cloud draft took 53 s on average (5 calls, free tier). The 99.0% is optimistic: the rules were tuned on Set A, but both sets come from the same generator.

## Known limits

- **Gemini Nano needs desktop Chrome** on a capable laptop. Other browsers, phones and weaker laptops get basic checks, which catch less.
- **Unusual names and misspellings slip through.** Short or odd names and misspelled health terms ("mltiple sclerosis") are the most common misses. Always review before sending.
- **Handwriting isn't supported.** Scanning reads printed text with Tesseract.js on the device. Handwritten notes need typing.
- **The backup engine isn't Firebase.** Basic checks use a small name model that runs in the page (Transformers.js) plus rules.
- **The free tier is slow and shared.** The cloud draft can take up to a minute, and a busy day can hit the quota (429).
- **In the app, drafting and scanning are still demos** (`DEMO_MODE` in `src/workspace/ai.ts`, `SCAN_DEMO` in `src/workspace/scanAi.ts`). The real cloud draft runs on `/eval`.

## Fake data only

Every note, name and number in this repo is made up (`data/cases/`, tests, fixtures). Never add real case notes.

## License and name

The code is Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

The Cloak name and logo are not licensed under Apache-2.0 and may not be used for other products without permission.
