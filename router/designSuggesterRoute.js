const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth');
const { redesignWebsite  } = require('../controllers/designSuggesterController');

// POST /api/suggest-designs
router.use((req, res, next) => { res.setTimeout(180000); next(); });
router.post('/', authMiddleware, redesignWebsite);

module.exports = router;