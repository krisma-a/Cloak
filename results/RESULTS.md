# Cloak results on Set B

Run on 2026-11-24. Set B is the holdout set: 60 fake notes with 516 planted private details (seed 9049). Fake data only. Set B was used for scoring only and was never used to tune the redaction code or its prompts.

**Biggest weakness:** nothing catches what Gemini Nano misses: the send guard blocked 0 of 60 notes, so all 11 missed details (1 name, 2 misspelled medical terms, 2 salaries, 2 ages and 4 job or team phrases) would still have been sent to the cloud.

## Update: after the camera tests (2026-11-26)

**The rules changed after the camera tests** (13 photos of fake documents leaked through OCR misspellings, lone surnames
and letter-prefixed IDs), so these numbers come after a fix driven by photo results, not by Set B.

What changed: medical keywords also match OCR typos and cut-off words ("diabet", "sertral") and common medications;
phones may miss a bracket or be glued to a word; IDs like `BSL-5560` / `#SR-11407`; every part of a found name is hidden
everywhere, typos included, with the same placeholder ([src/ai/nameParts.ts](../src/ai/nameParts.ts)). Photos are also
read again after blackout ([src/camera/recheck.ts](../src/camera/recheck.ts)); the eval scores text only, so that
recheck is not in these numbers.

Gemini Nano is not available on the machine used for this run, so "Full Cloak" ran on the **backup engine**
(`browser-model` × 60, in-browser name model + rules). Before and after were run side by side on the same machine (the
"before" is commit `338bb6d`). These are not comparable with the Nano numbers below; Nano was not re-run.

Set A first (to check nothing broke), then Set B once:

| Method | Set A before → after | Set B before → after | Over-redacted (Set B) |
| --- | --- | --- | --- |
| Rules only | 33.2% → **33.6%** (168 → 170 of 506) | 31.8% → **32.6%** (164 → 168 of 516) | 0 → 0 of 182 |
| Full Cloak, backup engine | 80.2% → **81.0%** (406 → 410 of 506) | 79.5% → **80.4%** (410 → 415 of 516) | 0 → 0 of 182 |

No item that was caught before is missed now, on either set. Set B, Full Cloak (backup engine) per category, where it
changed: MEDICAL 22 → 26 of 33 (`mltiple sclerosis`, `epilepssy`, `sertraline 50 mg daily`, `multiple slerosis`),
PERSON 189 → 190 of 199 (`OBI, KAYODE`). The send guard blocked 0 of 60 notes in both runs.

Still missed on Set B, among the kinds this fix targeted: `scciatica`, `sciatica`, `ceilac disease`, `lupuus`, `PTSSD`
(sciatica and celiac are not in the keyword list; lupus and PTSD are too short for typo matching), and reversed or
lower-case names the name model doesn't see (`VILLALOBOS, DANIELA`, `Uchenna gunleye`, `Noor aNsser`). Not changed:
no Set B-only fix was added.

## Update: after strengthening the guard (same day, second run)

What changed (developed on Set A only, then Set B was scored once; raw report in
[set-b-results-after-guard.json](set-b-results-after-guard.json)):

- **Safety net on the Nano path** ([src/ai/safetyNet.ts](../src/ai/safetyNet.ts)): anything a rule or keyword list can
  find is now hidden by code after Nano's pass, instead of only being used to retry or block.
- **New rules** ([src/rules/rules.ts](../src/rules/rules.ts)): ages ("aged 36", "23 years old"), more currencies and
  formats (₹, ₦, lakh, a bare "62k", "64,000 a year", "22.40/hr").
- **Names**: hyphenated names the in-browser name model split ("Min" + "jun") are widened to the whole name; a nickname in
  quotes next to a hidden name is hidden too. **Team phrases** ("the weekend dispatch team") become `[DEPT_n]`.

| Method | Catch rate before → after | Missed | Block rate | Avg on-device | Over-redacted |
| --- | --- | --- | --- | --- | --- |
| Rules only | 27.7% → **31.8%** | 373 → 352 | no blocking | 1.16 ms → 0.77 ms | 0 → 0 of 182 |
| AI only | 88.4% → **89.0%** | 60 → 57 | no blocking | 2.5 s → 2.3 s | 1 → 2 of 182 |
| Full Cloak | 97.9% → **99.0%** | 11 → 5 | 0.0% → 1.7% (1 of 60) | 3.3 s → 2.8 s | 8 → 4 of 182 |

| Category | Full Cloak before (caught / missed) | Full Cloak after |
| --- | --- | --- |
| PERSON | 198 / 1 | 199 / 0 |
| EMPLOYEE_ID | 36 / 0 | 36 / 0 |
| EMAIL | 25 / 0 | 25 / 0 |
| PHONE | 25 / 0 | 24 / 1 |
| ADDRESS | 30 / 0 | 30 / 0 |
| MEDICAL | 31 / 2 | 30 / 3 |
| SALARY | 58 / 2 | 59 / 1 |
| DATE_OF_BIRTH | 11 / 2 | 13 / 0 |
| ROLE | 46 / 1 | 47 / 0 |
| DEPARTMENT | 30 / 3 | 33 / 0 |
| OTHER_ID | 15 / 0 | 15 / 0 |

Full Cloak misses after the change (5):

| Note | Category | Missed item (fake data) | Note blocked? |
| --- | --- | --- | --- |
| B014 | MEDICAL | `mltiple sclerosis` | No |
| B030 | PHONE | `+52 55 000 0169` | No |
| B046 | SALARY | `one hundred thirty-four thousand dollars` | No |
| B051 | MEDICAL | `scciatica` | No |
| B053 | MEDICAL | `multiple slerosis` | No |

**Biggest weakness now:** misspelled medical terms (3 of the 5 remaining misses) still pass every check, because
no rule matches a typo and Set A gave no evidence to tune one on.

Read these numbers with care:
- Set B is less blind than before: its first-run misses were seen before this change. The rules were chosen from Set A's
  misses (which showed the same kinds: ages, salary formats, split names, team phrases), and no Set B-only fix was added
  (no medical typo matching, no wider job-title list).
- Set A and Set B come from the same generator, so rules tuned on Set A's phrasing transfer to Set B more easily than
  they would to real notes. Treat 99.0% as an upper bound.
- Nano varies between runs: the phone miss (B030) was caught in the first run. Set A on the live pipeline: 506 of 506.
- Cloud time was not measured in this run: all 5 cloud drafts failed (free-tier quota, see `CLAUDE.md`).

## Engine used

- Browser: Chrome 157 on macOS, `LanguageModel.availability()` = `available`.
- Full Cloak ran on **Gemini Nano** for all 60 notes (`nano` × 60). It used 1.12 passes per note on average.
- Rules only ran as `rules-only` × 60. AI only ran as `nano` × 60. Nothing was skipped and nothing failed.
- Settings in force (Remote Config values at run time): `redact_salary` = true, `medical_mode` = generalize, `max_retries` = 2, `cloud_model` = gemini-3.6-flash.
- Cloud time was measured on the first 5 notes the guard let through. They sent hidden fake text through the real `draft()` path with no receipts and no send log.

## The three methods

- **Rules only:** fixed rules for emails, phones, IDs, salary and medical keywords. No model.
- **AI only:** one Gemini Nano pass. No name cross-check, no retries, no blocking.
- **Full Cloak:** Gemini Nano, name cross-check, retries, then the send guard that can block a note.

A detail counts as caught when its text is gone from the output. A name also counts as missed if any part of it is still visible.

## Summary

| Method | Catch rate | Caught | Missed | Block rate | Avg on-device time | Avg cloud time | Over-redacted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Rules only | 27.7% | 143 of 516 | 373 | no blocking | 1.16 ms | not measured | 0 of 182 |
| AI only (Gemini Nano, one pass) | 88.4% | 456 of 516 | 60 | no blocking | 2.5 s | not measured | 1 of 182 |
| Full Cloak | 97.9% | 505 of 516 | 11 | 0.0% (0 of 60 notes) | 3.3 s | 53.1 s (5 calls) | 8 of 182 |

"Over-redacted" counts text that should have stayed visible (case numbers, event dates) but was removed.
"Block rate" is the share of notes the send guard refused. Only Full Cloak can block.

## Caught and missed per category

Each cell is caught / missed (catch rate).

| Category | Planted | Rules only | AI only | Full Cloak |
| --- | --- | --- | --- | --- |
| PERSON | 199 | 1 / 198 (0.5%) | 154 / 45 (77.4%) | 198 / 1 (99.5%) |
| EMPLOYEE_ID | 36 | 18 / 18 (50.0%) | 36 / 0 (100.0%) | 36 / 0 (100.0%) |
| EMAIL | 25 | 25 / 0 (100.0%) | 25 / 0 (100.0%) | 25 / 0 (100.0%) |
| PHONE | 25 | 19 / 6 (76.0%) | 24 / 1 (96.0%) | 25 / 0 (100.0%) |
| ADDRESS | 30 | 0 / 30 (0.0%) | 30 / 0 (100.0%) | 30 / 0 (100.0%) |
| MEDICAL | 33 | 22 / 11 (66.7%) | 30 / 3 (90.9%) | 31 / 2 (93.9%) |
| SALARY | 60 | 40 / 20 (66.7%) | 56 / 4 (93.3%) | 58 / 2 (96.7%) |
| DATE_OF_BIRTH | 13 | 3 / 10 (23.1%) | 10 / 3 (76.9%) | 11 / 2 (84.6%) |
| ROLE | 47 | 9 / 38 (19.1%) | 46 / 1 (97.9%) | 46 / 1 (97.9%) |
| DEPARTMENT | 33 | 0 / 33 (0.0%) | 30 / 3 (90.9%) | 30 / 3 (90.9%) |
| OTHER_ID | 15 | 6 / 9 (40.0%) | 15 / 0 (100.0%) | 15 / 0 (100.0%) |
| **All** | 516 | 143 / 373 (27.7%) | 456 / 60 (88.4%) | 505 / 11 (97.9%) |

## Every miss

### Full Cloak (11)

| Note | Category | Missed item (fake data) | Why | Note blocked? |
| --- | --- | --- | --- | --- |
| B001 | DATE_OF_BIRTH | `aged 27` | Still visible | No |
| B008 | PERSON | `Tmo` | Still visible | No |
| B013 | SALARY | `11.1k/mo` | Still visible | No |
| B014 | MEDICAL | `mltiple sclerosis` | Still visible | No |
| B018 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B033 | ROLE | `The youngest payroll analyst on the night warehouse crew` | Still visible | No |
| B033 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B037 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B044 | DATE_OF_BIRTH | `aged 47` | Still visible | No |
| B046 | SALARY | `one hundred thirty-four thousand dollars` | Still visible | No |
| B051 | MEDICAL | `scciatica` | Still visible | No |

### AI only (60)

| Note | Category | Missed item (fake data) | Why | Note blocked? |
| --- | --- | --- | --- | --- |
| B001 | DATE_OF_BIRTH | `aged 27` | Still visible | No |
| B004 | PERSON | `Olumide Ogunleye` | Still visible | No |
| B006 | SALARY | `$107000` | Still visible | No |
| B008 | PERSON | `Tmo` | Still visible | No |
| B008 | SALARY | `₦740,000` | Still visible | No |
| B009 | PERSON | `Wu` | Still visible | No |
| B009 | PERSON | `Q. Huang` | Still visible | No |
| B010 | PERSON | `W. Pruitt` | Still visible | No |
| B011 | PERSON | `Bondarenko` | Still visible | No |
| B012 | PHONE | `+52 55 000 0126` | Still visible | No |
| B012 | PERSON | `Heatther` | Still visible | No |
| B013 | MEDICAL | `type 2 diabetes` | Still visible | No |
| B014 | MEDICAL | `mltiple sclerosis` | Still visible | No |
| B014 | PERSON | `Manosur` | Still visible | No |
| B014 | DEPARTMENT | `the Cebu branch` | Still visible | No |
| B015 | PERSON | `Amaka Ibekwe` | Still visible | No |
| B018 | PERSON | `Maricel Cabading` | Still visible | No |
| B020 | PERSON | `Marites Bauutista` | Still visible | No |
| B020 | PERSON | `Yusuf Farok` | Still visible | No |
| B020 | PERSON | `Bautista` | Still visible | No |
| B020 | PERSON | `Yusuf Farouk` | Still visible | No |
| B022 | PERSON | `Macaraeg` | Still visible | No |
| B023 | PERSON | `Chukwu` | Still visible | No |
| B026 | PERSON | `Courtney Danforth` | Part still visible: `Danforth` | No |
| B028 | PERSON | `Wade Prescott` | Still visible | No |
| B031 | PERSON | `Ochoa` | Still visible | No |
| B032 | PERSON | `Cheng Huang` | Still visible | No |
| B032 | PERSON | `Huang` | Still visible | No |
| B033 | PERSON | `Tariq Qureshi` | Part still visible: `Tariq` | No |
| B033 | ROLE | `The youngest payroll analyst on the night warehouse crew` | Still visible | No |
| B033 | PERSON | `Amaka Ibekwe` | Part still visible: `Amaka` | No |
| B033 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B034 | PERSON | `Prescott` | Still visible | No |
| B034 | PERSON | `Dalia Nasser` | Still visible | No |
| B037 | PERSON | `Phạm` | Still visible | No |
| B037 | PERSON | `Farouk` | Still visible | No |
| B037 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B038 | PERSON | `Ulises Villalobos` | Still visible | No |
| B039 | PERSON | `Chukwu` | Still visible | No |
| B040 | PERSON | `Fuentes` | Still visible | No |
| B041 | PERSON | `Qing Chen` | Still visible | No |
| B041 | PERSON | `Chen` | Still visible | No |
| B042 | PERSON | `Ibarra, Ximena` | Still visible | No |
| B042 | PERSON | `Nasser` | Still visible | No |
| B042 | DATE_OF_BIRTH | `aged 39` | Still visible | No |
| B043 | PERSON | `Chukwu, Uchenna` | Still visible | No |
| B043 | PERSON | `Courtney Danforth` | Still visible | No |
| B043 | SALARY | `$77500` | Still visible | No |
| B044 | PERSON | `Tolentino` | Still visible | No |
| B044 | DATE_OF_BIRTH | `aged 47` | Still visible | No |
| B046 | PERSON | `Tomasz "Tom" Petrenko` | Still visible | No |
| B046 | SALARY | `one hundred thirty-four thousand dollars` | Still visible | No |
| B048 | PERSON | `Tram` | Still visible | No |
| B051 | PERSON | `Ketterman` | Still visible | No |
| B053 | MEDICAL | `multiple slerosis` | Still visible | No |
| B057 | PERSON | `Dizon` | Still visible | No |
| B057 | PERSON | `Ngô Văn Hải` | Still visible | No |
| B057 | PERSON | `Hải` | Still visible | No |
| B059 | PERSON | `Kaayode Obi` | Part still visible: `Kaayode` | No |
| B060 | PERSON | `Jia-li Chen` | Still visible | No |

### Rules only (373)

<details>
<summary>Show the 373 misses</summary>

| Note | Category | Missed item (fake data) | Why | Note blocked? |
| --- | --- | --- | --- | --- |
| B001 | PERSON | `Ada` | Still visible | No |
| B001 | PERSON | `Balogun` | Still visible | No |
| B001 | PERSON | `Qing Chen` | Still visible | No |
| B001 | ROLE | `the youngest claims adjuster at the Tulsa depot` | Still visible | No |
| B001 | DATE_OF_BIRTH | `aged 27` | Still visible | No |
| B002 | PERSON | `Arjun Kulkarni` | Still visible | No |
| B002 | PERSON | `Ketterman` | Still visible | No |
| B002 | PERSON | `Bui` | Still visible | No |
| B002 | ROLE | `the sole dispatcher at the Building C annex` | Still visible | No |
| B002 | DEPARTMENT | `the Tulsa depot` | Still visible | No |
| B002 | ADDRESS | `2370 Calle Luna, Unit 12, Cebu City` | Still visible | No |
| B003 | PERSON | `Maricel "Cel" Dizon` | Still visible | No |
| B003 | EMPLOYEE_ID | `37093` | Still visible | No |
| B003 | PERSON | `Kravchuk` | Still visible | No |
| B003 | PERSON | `Farouk` | Still visible | No |
| B003 | ROLE | `the only swing-shift sous chef` | Still visible | No |
| B004 | PERSON | `FUENTES, ULISES` | Still visible | No |
| B004 | PERSON | `Fuentes, Ulises` | Still visible | No |
| B004 | PERSON | `Olumide Ogunleye` | Still visible | No |
| B005 | PERSON | `Chen Chen` | Still visible | No |
| B005 | PERSON | `Tomasz Shevchenko` | Still visible | No |
| B005 | PERSON | `Mide` | Still visible | No |
| B005 | DEPARTMENT | `the Cebu branch` | Still visible | No |
| B005 | ADDRESS | `1870 Banyan Ct, Lagos` | Still visible | No |
| B005 | PERSON | `Chen` | Still visible | No |
| B006 | PERSON | `Petrenko, Halyna` | Still visible | No |
| B006 | EMPLOYEE_ID | `38141` | Still visible | No |
| B006 | PERSON | `Yuna Jeong` | Still visible | No |
| B006 | SALARY | `₹11 lakh` | Still visible | No |
| B006 | DEPARTMENT | `the weekend dispatch team` | Still visible | No |
| B007 | PERSON | `VILLALOBOS, DANIELA` | Still visible | No |
| B007 | PERSON | `Dani` | Still visible | No |
| B007 | PERSON | `Ochoa` | Still visible | No |
| B007 | PERSON | `Ngô Thị Hương` | Still visible | No |
| B007 | ROLE | `the new hire from Hanoi` | Still visible | No |
| B008 | PERSON | `Macaraeg, Liezl` | Still visible | No |
| B008 | EMPLOYEE_ID | `38671` | Still visible | No |
| B008 | PERSON | `Tmo` | Still visible | No |
| B008 | SALARY | `₦740,000` | Still visible | No |
| B009 | PERSON | `Jia-lii Wu` | Still visible | No |
| B009 | PERSON | `Dong-hyun Choi` | Still visible | No |
| B009 | PERSON | `Qing` | Still visible | No |
| B009 | DEPARTMENT | `the night warehouse crew` | Still visible | No |
| B009 | PERSON | `Wu` | Still visible | No |
| B009 | PERSON | `Q. Huang` | Still visible | No |
| B010 | PERSON | `Trần Thị Yến` | Still visible | No |
| B010 | PERSON | `Hao` | Still visible | No |
| B010 | PERSON | `Wade Pruuitt` | Still visible | No |
| B010 | ADDRESS | `2335 Calle Luna, Apt 4B, Tulsa` | Still visible | No |
| B010 | PERSON | `Trần` | Still visible | No |
| B010 | PERSON | `W. Pruitt` | Still visible | No |
| B011 | ROLE | `The only Punjabi-speaking QA inspector in cold storage` | Still visible | No |
| B011 | PERSON | `Bui, Minh` | Still visible | No |
| B011 | PERSON | `Bondarenko` | Still visible | No |
| B011 | PERSON | `Yusuf Qureshi` | Still visible | No |
| B011 | ROLE | `the only Punjabi-speaking QA inspector in cold storage` | Still visible | No |
| B011 | SALARY | `144.5k` | Still visible | No |
| B012 | PERSON | `Meenakshi Ansari` | Still visible | No |
| B012 | PERSON | `Xóchitl Coontreras` | Still visible | No |
| B012 | PERSON | `Heather Danforth` | Still visible | No |
| B012 | ROLE | `the only early-morning-shift payroll analyst` | Still visible | No |
| B012 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B012 | PHONE | `+52 55 000 0126` | Still visible | No |
| B012 | MEDICAL | `sickle cell disease` | Still visible | No |
| B012 | PERSON | `Ansari` | Still visible | No |
| B012 | PERSON | `Heatther` | Still visible | No |
| B013 | PERSON | `Uises Contreras` | Still visible | No |
| B013 | PERSON | `Chen` | Still visible | No |
| B013 | PERSON | `Tomasz "Tom" Bondarenko` | Still visible | No |
| B013 | SALARY | `11.1k/mo` | Still visible | No |
| B013 | OTHER_ID | `A37909768` | Still visible | No |
| B014 | PERSON | `Lakshmi Kulkarni` | Still visible | No |
| B014 | EMPLOYEE_ID | `74535` | Still visible | No |
| B014 | MEDICAL | `mltiple sclerosis` | Still visible | No |
| B014 | PERSON | `Manosur` | Still visible | No |
| B014 | PERSON | `Noor Qureshi` | Still visible | No |
| B014 | ROLE | `the sole line cook at the Tulsa depot` | Still visible | No |
| B014 | DEPARTMENT | `the Cebu branch` | Still visible | No |
| B014 | ADDRESS | `1045 Mabini St., Lagos` | Still visible | No |
| B015 | PERSON | `Ayesha Subramaniam` | Still visible | No |
| B015 | ROLE | `the only Spanish-speaking CNC machinist in cold storage` | Still visible | No |
| B015 | PERSON | `Amaka Ibekwe` | Still visible | No |
| B015 | ADDRESS | `4971 Harbor View Way, Fresno` | Still visible | No |
| B016 | PERSON | `Trần, Khoa` | Still visible | No |
| B016 | PERSON | `Lâm Thị Yến` | Still visible | No |
| B016 | SALARY | `one hundred thirty-two thousand five hundred dollars` | Still visible | No |
| B016 | MEDICAL | `epilepssy` | Still visible | No |
| B016 | DATE_OF_BIRTH | `61 years old` | Still visible | No |
| B016 | OTHER_ID | `928369141` | Still visible | No |
| B017 | PERSON | `Cheng Zhang` | Still visible | No |
| B017 | PERSON | `Amaka Balougn` | Still visible | No |
| B017 | PERSON | `Yusuf Qureshi` | Still visible | No |
| B017 | ROLE | `the new hire from Guadalajara` | Still visible | No |
| B017 | DEPARTMENT | `the Line 3 packaging team` | Still visible | No |
| B017 | ADDRESS | `4105 Harbor View Way, Apt 4B, Tulsa` | Still visible | No |
| B017 | SALARY | `thirty thousand dollars` | Still visible | No |
| B017 | PERSON | `Zhang` | Still visible | No |
| B017 | PERSON | `Yusuf` | Still visible | No |
| B018 | PERSON | `Prescott, Heather` | Still visible | No |
| B018 | PERSON | `Maricel Cabading` | Still visible | No |
| B018 | SALARY | `140k` | Still visible | No |
| B018 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B018 | ADDRESS | `1947 Orchard Ln, Tulsa` | Still visible | No |
| B018 | DATE_OF_BIRTH | `22 November 1974` | Still visible | No |
| B019 | PERSON | `Qign Wu` | Still visible | No |
| B019 | EMPLOYEE_ID | `81629` | Still visible | No |
| B019 | ROLE | `the youngest dispatcher on the weekend loading dock` | Still visible | No |
| B019 | PERSON | `Jia-li Chen` | Still visible | No |
| B020 | PERSON | `Lâm, Yến` | Still visible | No |
| B020 | EMPLOYEE_ID | `41021` | Still visible | No |
| B020 | PERSON | `Yusuf Farok` | Still visible | No |
| B020 | ROLE | `the only Spanish speaker on the weekend dock team` | Still visible | No |
| B020 | PHONE | `+84 90 000 0179` | Still visible | No |
| B020 | PERSON | `Bautista` | Still visible | No |
| B020 | PERSON | `Yusuf Farouk` | Still visible | No |
| B021 | PERSON | `Cuauhtémoc Ochoa` | Still visible | No |
| B021 | EMPLOYEE_ID | `66742` | Still visible | No |
| B021 | MEDICAL | `ceilac disease` | Still visible | No |
| B021 | PERSON | `Shin` | Still visible | No |
| B021 | PERSON | `Choi` | Still visible | No |
| B021 | DEPARTMENT | `the weekend dispatch team` | Still visible | No |
| B021 | DATE_OF_BIRTH | `24 years old` | Still visible | No |
| B022 | PERSON | `Dionisio "Nonoy" Pangilinan` | Still visible | No |
| B022 | PERSON | `Lâm` | Still visible | No |
| B022 | PERSON | `Macaraeg` | Still visible | No |
| B022 | ADDRESS | `765 Maple Hollow Rd, Mesa` | Still visible | No |
| B022 | SALARY | `₦490,000` | Still visible | No |
| B023 | PERSON | `VO, BAO` | Still visible | No |
| B023 | PERSON | `Chukwwu` | Still visible | No |
| B023 | PERSON | `Bao` | Still visible | No |
| B023 | EMPLOYEE_ID | `69497` | Still visible | No |
| B023 | PERSON | `Dalia Farouk` | Still visible | No |
| B023 | ROLE | `the only swing-shift QA inspector` | Still visible | No |
| B023 | ROLE | `the new hire from Lagos` | Still visible | No |
| B023 | DEPARTMENT | `the weekend dispatch team` | Still visible | No |
| B023 | MEDICAL | `sertraline 50 mg daily` | Still visible | No |
| B023 | PERSON | `Chukwu` | Still visible | No |
| B023 | PERSON | `Farouk` | Still visible | No |
| B024 | PERSON | `Ty` | Still visible | No |
| B024 | PERSON | `Tolentino` | Still visible | No |
| B024 | PERSON | `Lâm Văn Bảo` | Still visible | No |
| B025 | PERSON | `Nacho` | Still visible | No |
| B025 | ROLE | `the sole dispatcher at the Building C annex` | Still visible | No |
| B025 | PERSON | `Courtney Prescott` | Still visible | No |
| B025 | SALARY | `₹4 lakh` | Still visible | No |
| B025 | DEPARTMENT | `the Cebu branch` | Still visible | No |
| B025 | ADDRESS | `406 Harbor View Way, #305, Houston` | Still visible | No |
| B026 | PERSON | `Daniela Quintanilla` | Still visible | No |
| B026 | PERSON | `Rolando Manalo` | Still visible | No |
| B026 | PERSON | `Courtney` | Still visible | No |
| B026 | MEDICAL | `PTSSD` | Still visible | No |
| B026 | OTHER_ID | `P2815147` | Still visible | No |
| B026 | PERSON | `Quintanilla` | Still visible | No |
| B026 | PERSON | `Courtney Danforth` | Still visible | No |
| B027 | PERSON | `Edgardo Cabadng` | Still visible | No |
| B027 | EMPLOYEE_ID | `52452` | Still visible | No |
| B027 | PERSON | `Truong Van Bao` | Still visible | No |
| B027 | SALARY | `8.1k/mo` | Still visible | No |
| B027 | ADDRESS | `4985 Calle Luna, Fresno` | Still visible | No |
| B028 | PERSON | `Dionisio Manalo` | Still visible | No |
| B028 | PERSON | `Wade Prescott` | Still visible | No |
| B028 | DEPARTMENT | `the Line 3 packaging team` | Still visible | No |
| B028 | MEDICAL | `sciatica` | Still visible | No |
| B028 | ADDRESS | `3922 Harbor View Way, #305, Cebu City` | Still visible | No |
| B029 | PERSON | `Tolentino, Marites` | Still visible | No |
| B029 | PERSON | `Jeong` | Still visible | No |
| B029 | PERSON | `Haalyna Petrenko` | Still visible | No |
| B029 | ADDRESS | `3543 Camia St., Houston` | Still visible | No |
| B029 | OTHER_ID | `993989671` | Still visible | No |
| B030 | PERSON | `Daniela Quintanilla` | Still visible | No |
| B030 | PERSON | `Bautista` | Still visible | No |
| B030 | PERSON | `Pruitt` | Still visible | No |
| B030 | ROLE | `the only Spanish-speaking forklift lead in cold storage` | Still visible | No |
| B030 | DEPARTMENT | `the weekend dispatch team` | Still visible | No |
| B030 | PHONE | `+52 55 000 0169` | Still visible | No |
| B030 | SALARY | `12.2k/mo` | Still visible | No |
| B031 | PERSON | `Shin` | Still visible | No |
| B031 | PERSON | `Uchenna gunleye` | Still visible | No |
| B031 | PERSON | `Ximmena` | Still visible | No |
| B031 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B031 | SALARY | `104.5k` | Still visible | No |
| B031 | PERSON | `Ochoa` | Still visible | No |
| B032 | PERSON | `Dong-hyun Seo` | Still visible | No |
| B032 | PERSON | `Amaka Ibekwe` | Still visible | No |
| B032 | EMPLOYEE_ID | `54528` | Still visible | No |
| B032 | PERSON | `Cheng Huang` | Still visible | No |
| B032 | DEPARTMENT | `the Tulsa depot` | Still visible | No |
| B032 | DEPARTMENT | `the weekend dispatch team` | Still visible | No |
| B032 | DATE_OF_BIRTH | `13 January 1961` | Still visible | No |
| B032 | PERSON | `Seo` | Still visible | No |
| B032 | PERSON | `Huang` | Still visible | No |
| B033 | PERSON | `Tariq Qureshi` | Still visible | No |
| B033 | ROLE | `The youngest payroll analyst on the night warehouse crew` | Still visible | No |
| B033 | PERSON | `Pham, Mai` | Still visible | No |
| B033 | PERSON | `Amaka Ibekwe` | Still visible | No |
| B033 | DEPARTMENT | `the Tulsa depot` | Still visible | No |
| B033 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B033 | PHONE | `+84 90 000 0121` | Still visible | No |
| B033 | PERSON | `Qureshi` | Still visible | No |
| B033 | PERSON | `Ibekwe` | Still visible | No |
| B034 | ROLE | `The sole front-desk coordinator at the Cebu branch` | Still visible | No |
| B034 | PERSON | `Trần, Trâm` | Still visible | No |
| B034 | PERSON | `Prescott` | Still visible | No |
| B034 | PERSON | `Dalia Nasser` | Still visible | No |
| B034 | ROLE | `the sole front-desk coordinator at the Cebu branch` | Still visible | No |
| B034 | ADDRESS | `4465 Maple Hollow Rd, Apt 17, Houston` | Still visible | No |
| B035 | PERSON | `Liezl Sarmiento` | Still visible | No |
| B035 | EMPLOYEE_ID | `42571` | Still visible | No |
| B035 | ROLE | `the new hire from Hanoi` | Still visible | No |
| B035 | PERSON | `Yusuf Farouk` | Still visible | No |
| B035 | ADDRESS | `431 Orchard Ln, Houston` | Still visible | No |
| B035 | SALARY | `one hundred seven thousand dollars` | Still visible | No |
| B036 | PERSON | `Oluwaseun "Seun" Balougn` | Still visible | No |
| B036 | EMPLOYEE_ID | `78798` | Still visible | No |
| B036 | ROLE | `the newest front-desk coordinator on the night warehouse crew` | Still visible | No |
| B036 | PERSON | `Dali Nasser` | Still visible | No |
| B036 | DEPARTMENT | `the weekend dispatch team` | Still visible | No |
| B036 | ADDRESS | `1720 Harbor View Way, Apt 17, Quezon City` | Still visible | No |
| B037 | ROLE | `The only Spanish-speaking loan officer on the weekend loading dock` | Still visible | No |
| B037 | PERSON | `Ketterman, Courrtney` | Still visible | No |
| B037 | PERSON | `Phạm` | Still visible | No |
| B037 | PERSON | `Farouk` | Still visible | No |
| B037 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B037 | ADDRESS | `170 Rizal Ave., Cebu City` | Still visible | No |
| B038 | PERSON | `Tariq Farouk` | Still visible | No |
| B038 | PERSON | `Ulises Villalobos` | Still visible | No |
| B038 | SALARY | `₦230,000` | Still visible | No |
| B038 | DEPARTMENT | `the night warehouse crew` | Still visible | No |
| B038 | ADDRESS | `3356 Calle Luna, #305, San Jose` | Still visible | No |
| B039 | PERSON | `MENON, VENKATESH` | Still visible | No |
| B039 | PERSON | `Menon` | Still visible | No |
| B039 | PERSON | `Ketterman` | Still visible | No |
| B039 | PERSON | `Chukwu` | Still visible | No |
| B039 | ROLE | `the only Spanish speaker on the night warehouse crew` | Still visible | No |
| B039 | ADDRESS | `4875 Orchard Ln, Quezon City` | Still visible | No |
| B040 | PERSON | `Subramaniam` | Still visible | No |
| B040 | PERSON | `Dong-hun Seo` | Still visible | No |
| B040 | PERSON | `Ximena` | Still visible | No |
| B040 | ADDRESS | `208 Banyan Ct, Tulsa` | Still visible | No |
| B040 | PERSON | `Fuentes` | Still visible | No |
| B041 | PERSON | `Tomasz Kravchuk` | Still visible | No |
| B041 | PERSON | `Trần Thị Yến` | Still visible | No |
| B041 | PERSON | `Qing Chen` | Still visible | No |
| B041 | DEPARTMENT | `the Tulsa depot` | Still visible | No |
| B041 | ROLE | `the sole claims adjuster at the Building C annex` | Still visible | No |
| B041 | DEPARTMENT | `the Cebu branch` | Still visible | No |
| B041 | ADDRESS | `2433 Maple Hollow Rd, Apt 17, Cebu City` | Still visible | No |
| B041 | SALARY | `₹11.5 lakh` | Still visible | No |
| B041 | MEDICAL | `lupuus` | Still visible | No |
| B041 | PERSON | `Kravchuk` | Still visible | No |
| B041 | PERSON | `Chen` | Still visible | No |
| B042 | ROLE | `The new hire from Chennai` | Still visible | No |
| B042 | PERSON | `Ibarra, Ximena` | Still visible | No |
| B042 | PERSON | `Nasser` | Still visible | No |
| B042 | PERSON | `Menon` | Still visible | No |
| B042 | ROLE | `the new hire from Chennai` | Still visible | No |
| B042 | PHONE | `+52 55 000 0161` | Still visible | No |
| B042 | DATE_OF_BIRTH | `aged 39` | Still visible | No |
| B042 | OTHER_ID | `P9032854` | Still visible | No |
| B043 | PERSON | `Chukwu, Uchenna` | Still visible | No |
| B043 | PERSON | `Courtney Danforth` | Still visible | No |
| B043 | ADDRESS | `3729 Banyan Ct, Mesa` | Still visible | No |
| B043 | DATE_OF_BIRTH | `47 years old` | Still visible | No |
| B044 | PERSON | `CHEN, ZHI-HAO` | Still visible | No |
| B044 | ROLE | `The longest-serving dispatcher in the ICU` | Still visible | No |
| B044 | MEDICAL | `a herniated disc` | Still visible | No |
| B044 | PERSON | `Chen, Zhi-hao` | Still visible | No |
| B044 | PERSON | `Tolentino` | Still visible | No |
| B044 | PERSON | `Tran Thi Huong` | Still visible | No |
| B044 | DATE_OF_BIRTH | `aged 47` | Still visible | No |
| B045 | PERSON | `BÙI, TRÂM` | Still visible | No |
| B045 | PERSON | `Bùi, Trâm` | Still visible | No |
| B045 | EMPLOYEE_ID | `55003` | Still visible | No |
| B045 | PERSON | `Olumide Ogunleye` | Still visible | No |
| B045 | DEPARTMENT | `the night warehouse crew` | Still visible | No |
| B045 | ADDRESS | `4858 Mabini St., Tulsa` | Still visible | No |
| B046 | PERSON | `Oluwaseun Chukwu` | Still visible | No |
| B046 | ROLE | `the sole claims adjuster at the Tulsa depot` | Still visible | No |
| B046 | PERSON | `Tomasz "Tom" Petrenko` | Still visible | No |
| B046 | SALARY | `one hundred thirty-four thousand dollars` | Still visible | No |
| B046 | OTHER_ID | `A94495600` | Still visible | No |
| B047 | PERSON | `Noor aNsser` | Still visible | No |
| B047 | EMPLOYEE_ID | `76216` | Still visible | No |
| B047 | ROLE | `the only swing-shift payroll analyst` | Still visible | No |
| B047 | PERSON | `Tomasz Bondarenko` | Still visible | No |
| B047 | DEPARTMENT | `the Tulsa depot` | Still visible | No |
| B047 | ADDRESS | `734 Mabini St., Mesa` | Still visible | No |
| B048 | PERSON | `MANSOUR, DALIA` | Still visible | No |
| B048 | PERSON | `Tram` | Still visible | No |
| B048 | PERSON | `Dalia Mansour` | Still visible | No |
| B048 | EMPLOYEE_ID | `30626` | Still visible | No |
| B048 | PERSON | `Heather` | Still visible | No |
| B048 | ADDRESS | `4945 Ashgrove Dr, Quezon City` | Still visible | No |
| B049 | PERSON | `Babatunde Obi` | Still visible | No |
| B049 | PERSON | `Cheng Huang` | Still visible | No |
| B049 | PERSON | `Courtney Danforth` | Still visible | No |
| B049 | DEPARTMENT | `the cold-storage unit` | Still visible | No |
| B049 | ROLE | `the new hire from Cebu` | Still visible | No |
| B049 | ADDRESS | `668 Unity Blvd, Mesa` | Still visible | No |
| B049 | PERSON | `Obi` | Still visible | No |
| B049 | PERSON | `Courtney` | Still visible | No |
| B050 | PERSON | `Shevchenko` | Still visible | No |
| B050 | PERSON | `Venkatesh "Venky" Kulkarni` | Still visible | No |
| B050 | PERSON | `Trần Văn Khoa` | Still visible | No |
| B050 | DEPARTMENT | `the night warehouse crew` | Still visible | No |
| B050 | DEPARTMENT | `the Cebu branch` | Still visible | No |
| B050 | PHONE | `+91 98 000 0130` | Still visible | No |
| B050 | SALARY | `₦470,000` | Still visible | No |
| B050 | PERSON | `Trần` | Still visible | No |
| B051 | PERSON | `Ayesha Reddy` | Still visible | No |
| B051 | MEDICAL | `scciatica` | Still visible | No |
| B051 | PERSON | `Jeong` | Still visible | No |
| B051 | PERSON | `Ketterman` | Still visible | No |
| B051 | ROLE | `the only Spanish speaker on the weekend dock team` | Still visible | No |
| B051 | OTHER_ID | `954284939` | Still visible | No |
| B052 | PERSON | `Ayesha Menon` | Still visible | No |
| B052 | EMPLOYEE_ID | `71786` | Still visible | No |
| B052 | PERSON | `Ibarra` | Still visible | No |
| B052 | PERSON | `Nasser` | Still visible | No |
| B052 | ROLE | `the only Spanish-speaking sous chef on Line 3` | Still visible | No |
| B053 | PERSON | `Shevchenko, Piotr` | Still visible | No |
| B053 | PERSON | `Uchenna Adeyemi` | Still visible | No |
| B053 | SALARY | `₹8.5 lakh` | Still visible | No |
| B053 | MEDICAL | `multiple slerosis` | Still visible | No |
| B053 | ADDRESS | `3281 Orchard Ln, Tulsa` | Still visible | No |
| B054 | PERSON | `Nasser` | Still visible | No |
| B054 | PERSON | `Meneakshi Gill` | Still visible | No |
| B054 | PERSON | `Piotr Petrenko` | Still visible | No |
| B054 | DEPARTMENT | `the Line 3 packaging team` | Still visible | No |
| B054 | DEPARTMENT | `the Cebu branch` | Still visible | No |
| B054 | ADDRESS | `3653 Ashgrove Dr, #305, Quezon City` | Still visible | No |
| B054 | SALARY | `3.8k/mo` | Still visible | No |
| B054 | DATE_OF_BIRTH | `18 March 1986` | Still visible | No |
| B054 | OTHER_ID | `P8870756` | Still visible | No |
| B054 | PERSON | `Piotr` | Still visible | No |
| B055 | PERSON | `Courtney Danforth` | Still visible | No |
| B055 | PERSON | `Heather Prescott` | Still visible | No |
| B055 | PERSON | `Bui Thi Huong` | Still visible | No |
| B055 | ROLE | `the sole forklift lead at the Cebu branch` | Still visible | No |
| B055 | ADDRESS | `2822 Harbor View Way, Apt 17, Fresno` | Still visible | No |
| B055 | PERSON | `Danforth` | Still visible | No |
| B055 | PERSON | `Huong` | Still visible | No |
| B056 | PERSON | `Dionisio "Nonoy" Pangilinan` | Still visible | No |
| B056 | ROLE | `The longest-serving loan officer in Building C` | Still visible | No |
| B056 | PERSON | `Bondarenko, Piotr` | Still visible | No |
| B056 | EMPLOYEE_ID | `31302` | Still visible | No |
| B056 | PERSON | `Tariq Qureshi` | Still visible | No |
| B056 | DEPARTMENT | `the Line 3 packaging team` | Still visible | No |
| B056 | ROLE | `the longest-serving loan officer in Building C` | Still visible | No |
| B056 | PERSON | `Pangilinan` | Still visible | No |
| B057 | PERSON | `Dizon` | Still visible | No |
| B057 | ROLE | `The new hire from Chennai` | Still visible | No |
| B057 | PERSON | `Qureshi, Tariq` | Still visible | No |
| B057 | EMPLOYEE_ID | `83493` | Still visible | No |
| B057 | PERSON | `Ngô Văn Hải` | Still visible | No |
| B057 | ROLE | `the only early-morning-shift QA inspector` | Still visible | No |
| B057 | ROLE | `the new hire from Chennai` | Still visible | No |
| B057 | ADDRESS | `3622 Camia St., Apt 17, Quezon City` | Still visible | No |
| B057 | SALARY | `148.5k` | Still visible | No |
| B057 | OTHER_ID | `A32352558` | Still visible | No |
| B057 | PERSON | `Hải` | Still visible | No |
| B058 | PERSON | `Danforth, Heather` | Still visible | No |
| B058 | PERSON | `Jia-li "Jia" Wu` | Still visible | No |
| B058 | DEPARTMENT | `the weekend dispatch team` | Still visible | No |
| B059 | PERSON | `OBI, KAYODE` | Still visible | No |
| B059 | PERSON | `Kaayode Obi` | Still visible | No |
| B059 | PERSON | `Menon` | Still visible | No |
| B059 | PERSON | `Adaeze Balogun` | Still visible | No |
| B059 | DATE_OF_BIRTH | `58 years old` | Still visible | No |
| B060 | PERSON | `Choi, Yuna` | Still visible | No |
| B060 | PERSON | `Jia-li Chen` | Still visible | No |
| B060 | DEPARTMENT | `the Tulsa depot` | Still visible | No |
| B060 | ADDRESS | `1747 Harbor View Way, Tulsa` | Still visible | No |

</details>

## Limits of this run

- One run on one machine. Gemini Nano output can vary from run to run, so treat the AI numbers as one sample.
- Cloud time is an average of 5 calls, so it is rough.
- The scoring only checks that the planted text is gone. It does not check whether the cloud draft was any good.

## Reproduce

```bash
npm run dev
```

Open `/eval` in desktop Chrome with Gemini Nano available, tick "Also time the cloud draft" (5 notes), click Run eval, then Download JSON. The raw report is in [set-b-results.json](set-b-results.json).
