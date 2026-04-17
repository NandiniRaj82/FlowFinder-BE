const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth');
const { redesignWebsite } = require('../controllers/designSuggesterController');

router.use((req, res, next) => { res.setTimeout(600000); next(); }); // 10 minutes

// POST /api/redesign
router.post('/', authMiddleware, redesignWebsite);

module.exports = router;