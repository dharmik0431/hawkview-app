'use client'

import { getApp, getApps, initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'

// Firebase web configuration identifies the public HawkView web client. These
// values are intentionally shipped to every browser by Firebase and are not
// credentials. Keeping them here prevents hosted preview environments from
// silently replacing them with stale build-time environment variables.
const firebaseConfig = {
  apiKey: 'AIzaSyDwzfLY4LzBP59I2toRUT5lC8G1UKC0lEY',
  authDomain: 'hawkview-app.firebaseapp.com',
  projectId: 'hawkview-app',
  appId: '1:670803700763:web:ac7275d7cf04fe888d9cbe',
}

export const isFirebaseConfigured = Object.values(firebaseConfig).every(Boolean)

const app = isFirebaseConfigured
  ? getApps().length
    ? getApp()
    : initializeApp(firebaseConfig)
  : null

export const auth = app ? getAuth(app) : null

