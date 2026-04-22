const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const User = require('../models/user');
const UserProfile = require('../models/userProfile');

/* ── GET /api/users/figma-token ── returns whether Figma token is connected */
router.get('/figma-token', authMiddleware, async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ uid: req.user.uid }).select('figma');
    return res.json({
      connected: !!profile?.figma?.accessToken,
      connectedAt: profile?.figma?.connectedAt,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ── POST /api/users/figma-token ── save/update user's Figma personal token */
router.post('/figma-token', authMiddleware, async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken?.trim()) {
      return res.status(400).json({ success: false, message: 'accessToken is required.' });
    }
    await UserProfile.findOneAndUpdate(
      { uid: req.user.uid },
      { $set: { 'figma.accessToken': accessToken.trim(), 'figma.connectedAt': new Date() } },
      { upsert: true }
    );
    return res.json({ success: true, message: 'Figma token saved.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* ── DELETE /api/users/figma-token ── remove Figma token */
router.delete('/figma-token', authMiddleware, async (req, res) => {
  try {
    await UserProfile.findOneAndUpdate(
      { uid: req.user.uid },
      { $unset: { figma: 1 } }
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});


router.get('/profile', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('-password');
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.status(200).json({
            success: true,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

router.put('/profile', authMiddleware, async (req, res) => {
    try {
        const { fullName } = req.body;

        if (!fullName || fullName.trim().length < 2) {
            return res.status(400).json({
                success: false,
                message: 'Full name must be at least 2 characters long'
            });
        }

        const user = await User.findByIdAndUpdate(
            req.user.userId,
            { fullName: fullName.trim() },
            { new: true }
        ).select('-password');

        res.status(200).json({
            success: true,
            message: 'Profile updated successfully',
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

module.exports = router;