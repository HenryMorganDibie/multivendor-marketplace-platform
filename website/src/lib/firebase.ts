"use client";

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { getStorage, connectStorageEmulator } from "firebase/storage";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from "firebase/app-check";

// Emulator mode — set NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true to run this
// app against the same local Firebase Emulator Suite the acceptance test
// scripts use (`firebase emulators:start ... --project demo-the platform`),
// with no real Firebase project or credentials required at all. This is
// the fastest path for anyone to actually run and click through the app.
const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === "true";

const firebaseConfig = USE_EMULATOR
  ? { apiKey: "demo", projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "demo-the platform" }
  : {
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    };

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const functions = getFunctions(firebaseApp);
export const storage = getStorage(firebaseApp);

// Fast-refresh in dev re-runs this module, and connect*Emulator() throws
// if called twice on the same instance — guard with a global flag.
declare global {
  // eslint-disable-next-line no-var
  var __the platformEmulatorConnected: boolean | undefined;
}
if (USE_EMULATOR && typeof window !== "undefined" && !globalThis.__the platformEmulatorConnected) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  globalThis.__the platformEmulatorConnected = true;
}

// App Check runs in monitor mode on the backend (appCheck.ts) until
// the client confirms enforcement — initializing it here is harmless even
// before a site key is configured; requests just proceed without a token,
// which the backend logs but does not block (see functions/src/utils/appCheck.ts).
if (!USE_EMULATOR && typeof window !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY) {
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaV3Provider(process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

export function callable<Req = Record<string, unknown>, Res = unknown>(name: string) {
  return httpsCallable<Req, Res>(functions, name);
}
