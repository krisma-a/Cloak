// Firebase setup for Cloak: app, App Check, Auth, Firestore, and AI Logic.
// Config comes from .env.local (VITE_* values). Nothing secret lives in this file.

import { initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import { getAuth, signInAnonymously, type User } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai'

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
if (recaptchaSiteKey) {
  initializeAppCheck(app, {
    // Classic reCAPTCHA v3 keys can no longer be created, so we use Fraud Defense
    // (formerly reCAPTCHA Enterprise).
    provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
    isTokenAutoRefreshEnabled: true,
  })
} else {
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

// Pin a 3.x cloud model (Gemini 2.5 requests get rerouted from Dec 1).
// Later this value moves to Remote Config so it can change without a redeploy.
export const CLOUD_MODEL: string = import.meta.env.VITE_CLOUD_MODEL ?? 'gemini-3.6-flash'

// Redaction: raw text must never leave the laptop, so on-device only.
// If Gemini Nano is missing, the call fails and the app falls back to Strict mode.
export function getRedactionModel() {
  return getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE })
}

// Tagging and tone rewrite: input is already redacted, so cloud fallback is safe.
export function getTaggingModel() {
  return getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: { model: CLOUD_MODEL },
  })
}

// Drafting: long outputs need the bigger cloud model. Input is redacted text only.
export function getDraftingModel() {
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: { model: CLOUD_MODEL },
  })
}
