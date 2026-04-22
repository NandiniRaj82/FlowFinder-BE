const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const User = require('../models/user');

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