// Firebase setup for Cloak: app, App Check, Auth, Firestore, and AI Logic.
// Config comes from .env.local (VITE_* values). Nothing secret lives in this file.

import { initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import { getAuth, signInAnonymously, type User } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  type OnDeviceParams,
} from 'firebase/ai'
import { cloudGenerationConfig } from './ai/cloudConfig.ts'
import { getPolicy, setPolicyDefaults } from './policy.ts'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

export const app = initializeApp(firebaseConfig)

// --- App Check -------------------------------------------------------------
// Proves requests come from our app. Locally, the debug flag makes Firebase print
// a debug token in the browser console; add it under App Check > Manage debug tokens.
// Must run before any Firebase AI, Auth or Firestore call.
// A fixed token (VITE_APPCHECK_DEBUG_TOKEN in .env.local) means you register it once and
// it works in every browser. Without it, Firebase makes a new random token per browser.
if (import.meta.env.DEV) {
  ;(self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
    import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true
}
const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY
// Exported so the smoke test can time token fetches. Undefined when no site key is set.
export const appCheck = recaptchaSiteKey
  ? initializeAppCheck(app, {
      // Classic reCAPTCHA v3 keys can no longer be created, so we use Fraud Defense
      // (formerly reCAPTCHA Enterprise).
      provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    })
  : undefined
if (!appCheck) {
  console.warn('App Check is off: set VITE_RECAPTCHA_SITE_KEY in .env.local')
}

// --- Auth ------------------------------------------------------------------
export const auth = getAuth(app)

// Signs the visitor in anonymously (no account needed) and returns the user.
// Throws auth/operation-not-allowed if Anonymous sign-in is not enabled in the console.
export async function ensureSignedIn(): Promise<User> {
  await auth.authStateReady() // wait for any saved session to load first
  if (auth.currentUser) return auth.currentUser
  const credential = await signInAnonymously(auth)
  return credential.user
}

// --- Firestore -------------------------------------------------------------
export const db = getFirestore(app)

// --- AI Logic (hybrid inference) -------------------------------------------
const ai = getAI(app, { backend: new GoogleAIBackend() })

// The cloud model is the Remote Config setting cloud_model (src/policy.ts), so it can change without
// a redeploy. Keep it on a 3.x model (Gemini 2.5 requests get rerouted from Dec 1).
// VITE_CLOUD_MODEL only sets the built-in default, used until Remote Config answers or if it never does.
if (import.meta.env.VITE_CLOUD_MODEL) setPolicyDefaults({ cloud_model: import.meta.env.VITE_CLOUD_MODEL })

/** The cloud model in force right now. */
export function cloudModel(): string {
  return getPolicy().cloud_model
}

// Redaction: raw text must never leave the laptop, so on-device only.
// If Gemini Nano is missing, the call fails and the app falls back to Strict mode.
// onDeviceParams lets callers pass a JSON schema (promptOptions.responseConstraint).
export function getRedactionModel(onDeviceParams?: OnDeviceParams) {
  return getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams })
}

// Tagging and tone rewrite: input is already redacted, so cloud fallback is safe.
export function getTaggingModel() {
  const model = cloudModel()
  return getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: { model, generationConfig: cloudGenerationConfig(model) },
  })
}

// Drafting: long outputs need the bigger cloud model. Input is redacted text only.
// Pass the model name when the caller also records it (the receipt), so both always agree.
// Thinking is set to LOW on Gemini 3.x (cloudConfig.ts): far fewer tokens, same text sent.
export function getDraftingModel(model: string = cloudModel()) {
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: { model, generationConfig: cloudGenerationConfig(model) },
  })
}
