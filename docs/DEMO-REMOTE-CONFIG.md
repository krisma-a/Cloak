# Demo: flip a setting live with Firebase Remote Config

Four settings can change without a redeploy. The app fetches them when the page loads and keeps
them live: publish a change in the Firebase console and it applies in a few seconds, no reload.

| Key | Type | Default | What it changes |
|---|---|---|---|
| `redact_salary` | boolean | `true` | `false` leaves pay visible. The leak check stops flagging it. Nothing else changes. |
| `medical_mode` | string | `generalize` | `block` refuses to send any note that has a medical detail. `generalize` hides it and turns it into work restrictions. |
| `max_retries` | number | `2` | How many times on-device redaction retries before it blocks (0 to 5). Only matters with Gemini Nano. |
| `cloud_model` | string | `gemini-3.6-flash` | The cloud Gemini model that writes drafts. Shown on the receipt. |

A value that is missing keeps its default. A value that is present but wrong fails toward MORE
privacy (`redact_salary` becomes `true`, `medical_mode` becomes `block`); numbers are clamped and an
invalid model name is ignored. The app logs a warning in the browser console for each.

## Before the demo (once)

Create the four parameters in the console (2 minutes):

1. Firebase console, project **cloak** (`cloak-594c8`), left menu, **Remote Config** (under Run).
2. **Add parameter** for each row above: name, data type, default value. **Save**.
3. Click **Publish changes** (top right), then **Publish changes** again to confirm.

Or from a terminal, using the template in this repo:

```bash
firebase remoteconfig:get                   # read-only: see what is already published
firebase deploy --only remoteconfig         # publishes remoteconfig.template.json
```

Deploy replaces the whole published template with the file. A parameter that exists only in the
console is removed, so look at the `get` output first.

## During the demo: flip a value

1. Open the app (or `/smoke.html`, which shows a **Live settings** box) and press F12 for the console.
2. In the Firebase console, **Remote Config**, click the pencil next to the parameter.
3. Change **Default value** (for example `medical_mode` to `block`). **Save**.
4. Click **Publish changes**, then confirm. Saving alone does nothing.
5. Within a few seconds the console prints `[policy] updated: medical_mode: generalize -> block`
   and the **Live settings** box changes. No reload.
6. Redact a note, then write the draft. A stricter setting also re-checks a note you already redacted.

If the box says `live updates: polling`, changes take up to 30 s. Press **Fetch now** to force it.

Good flips to show:

- `redact_salary` `false`, then **Hide private details**: the salary stays visible, everything else is hidden. Flip it back.
- `medical_mode` `block`, then **Write the draft**: "Not sent: this note has medical details and medical mode is block". Nothing leaves the laptop.
- `cloud_model`, with the real AI connected: the receipt names the new model.

Flip a setting **before** you click Hide private details, so the redaction uses it. In demo mode
(`DEMO_MODE = true`) `redact_salary` and `medical_mode` work too, because the rules and the guard
are the real code. `cloud_model` and `max_retries` only matter once the real AI is connected.

## After the demo

Remote Config, the clock icon (version history), **Roll back** to the previous version. Or set the
values back by hand and publish.

## If a flip does not show up

- Did you click **Publish changes**? Saving is not enough.
- Is the page `source: defaults` and `last fetch: never`? Remote Config could not load. Check the
  console for a `[policy]` warning, and that `.env.local` exists.
- Fetch errors: the Firebase web API key must allow the Remote Config and Installations APIs if it is restricted.
- Under the hood: `src/policy.ts` (values and rules), `src/remoteConfig.ts` (fetch and live updates).
