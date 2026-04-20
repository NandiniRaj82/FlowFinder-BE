const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { matchDesign } = require('../controllers/matchDesignController');

/**
 * POST /api/match-design
 * Compare live website screenshot vs Figma design using Gemini Vision
 * Timeout: 5 minutes (screenshot + Figma export + Gemini Vision can be slow)
 */
router.post('/', authMiddleware, (req, res, next) => {
  res.setTimeout(300000);
  next();
}, matchDesign);

module.exports = router;