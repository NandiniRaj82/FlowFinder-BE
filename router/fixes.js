const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { generateFixes, createFixPR, getFixSession, listFixSessionsByScan } = require('../controllers/fixController');

router.post('/generate', auth, generateFixes);
router.get('/by-scan/:scanId', auth, listFixSessionsByScan);  // must be before /:sessionId
router.post('/:sessionId/create-pr', auth, createFixPR);
router.get('/:sessionId', auth, getFixSession);

module.exports = router;
