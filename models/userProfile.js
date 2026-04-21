const mongoose = require('mongoose');

/**
 * User Profile — synced from Firebase on first login.
 * Firebase is the source of truth for auth.
 * MongoDB stores extended profile data (GitHub tokens, preferences, etc.)
 */
const UserProfileSchema = new mongoose.Schema({
  // Firebase UID — primary key link
  uid: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  email: {
    type: String,
    required: true,
  },
  displayName: String,
  photoURL: String,

  // GitHub OAuth connection
  github: {
    accessToken: String,       // encrypted
    username: String,
    avatarUrl: String,
    connectedAt: Date,
  },

  // Preferences
  preferences: {
    darkMode: { type: Boolean, default: false },
    defaultFramework: { type: String, default: 'react' },
    emailNotifications: { type: Boolean, default: true },
  },

  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
});

UserProfileSchema.statics.upsertFromFirebase = async function (decodedToken) {
  return this.findOneAndUpdate(
    { uid: decodedToken.uid },
    {
      $set: {
        email: decodedToken.email,
        displayName: decodedToken.name,
        photoURL: decodedToken.picture,
        lastLoginAt: new Date(),
      },
      $setOnInsert: {
        uid: decodedToken.uid,
        createdAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.models.UserProfile || mongoose.model('UserProfile', UserProfileSchema);

