const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { matchDesign } = require('../controllers/matchDesignController');

/**
 * POST /api/match-design
 * Compare live website screenshot vs Figma design using Gemini Vision
 */
router.post('/', authMiddleware, matchDesign);

module.exports = router;