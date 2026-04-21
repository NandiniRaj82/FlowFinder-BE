const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { generateFixes, createFixPR, getFixSession } = require('../controllers/fixController');

router.post('/generate', auth, generateFixes);
router.post('/:sessionId/create-pr', auth, createFixPR);
router.get('/:sessionId', auth, getFixSession);

module.exports = router;
