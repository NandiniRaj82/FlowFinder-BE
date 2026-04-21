const admin = require('firebase-admin');
const path = require('path');

let firebaseApp;

const initFirebase = () => {
  if (firebaseApp) return firebaseApp;
  if (admin.apps.length) { firebaseApp = admin.apps[0]; return firebaseApp; }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  let credential;

  try {
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      credential = admin.credential.cert(serviceAccount);
    } else if (serviceAccountPath) {
      // eslint-disable-next-line import/no-dynamic-require
      // Resolve relative to backend root (parent of config/), not the cwd
      const absolutePath = serviceAccountPath.startsWith('.')
        ? path.resolve(__dirname, '..', serviceAccountPath)
        : serviceAccountPath;
      const serviceAccount = require(absolutePath);
      credential = admin.credential.cert(serviceAccount);
    } else {
      console.warn('[Firebase] ⚠  No service account configured — running in unauthenticated mode.');
      console.warn('[Firebase]    Add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH to .env');
      console.warn('[Firebase]    Auth-protected routes will reject all requests until this is configured.');
      // Skip Firebase init — auth middleware will return 503 instead of crashing
      return null;
    }
  } catch (err) {
    console.error('[Firebase] Failed to load service account:', err.message);
    console.warn('[Firebase]    Running without Firebase Auth. Protected routes will return 503.');
    return null;
  }

  firebaseApp = admin.initializeApp({
    credential,
    projectId: process.env.FIREBASE_PROJECT_ID || 'flowfinder',
  });

  console.log('[Firebase] Admin SDK initialized ✓');
  return firebaseApp;
};

const getAuth = () => {
  if (!firebaseApp) initFirebase();
  if (!firebaseApp) return null;
  return admin.auth();
};

module.exports = { initFirebase, getAuth };

