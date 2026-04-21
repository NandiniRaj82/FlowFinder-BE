const { getAuth } = require('../config/firebase');

/**
 * Firebase Auth Middleware
 * Replaces the old JWT-based auth.
 * Verifies the Firebase ID token sent in the Authorization header.
 * Attaches { uid, email, name } to req.user.
 *
 * The frontend sends: Authorization: Bearer <firebase-id-token>
 */
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No authentication token provided.',
      });
    }

    const firebaseAuth = getAuth();
    if (!firebaseAuth) {
      return res.status(503).json({
        success: false,
        message: 'Firebase Auth is not configured. Please add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH to backend/.env',
        code: 'FIREBASE_NOT_CONFIGURED',
      });
    }

    // Verify with Firebase Admin
    const decodedToken = await firebaseAuth.verifyIdToken(token);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      name: decodedToken.name || decodedToken.email?.split('@')[0] || 'User',
      picture: decodedToken.picture || null,
    };

    next();
  } catch (error) {
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please sign in again.',
        code: 'TOKEN_EXPIRED',
      });
    }
    if (error.code === 'auth/argument-error' || error.code === 'auth/id-token-revoked') {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token.',
        code: 'INVALID_TOKEN',
      });
    }
    console.error('[Auth Middleware] Error:', error.message);
    res.status(401).json({
      success: false,
      message: 'Authentication failed.',
    });
  }
};

module.exports = authMiddleware;