const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const {
  matchDesign, generateDesignFix,
  getDesignHistory, getDesignScan, deleteDesignScan,
} = require('../controllers/matchDesignController');

/** POST /api/match-design — run comparison */
router.post('/', authMiddleware, (req, res, next) => {
  res.setTimeout(300000); next();
}, matchDesign);

/** POST /api/match-design/fix — generate code fixes */
router.post('/fix', authMiddleware, generateDesignFix);

/** GET /api/match-design/history — user's past scans (no screenshots) */
router.get('/history', authMiddleware, getDesignHistory);

/** GET /api/match-design/:scanId — full scan with screenshots */
router.get('/:scanId', authMiddleware, getDesignScan);

/** DELETE /api/match-design/:scanId — delete a scan */
router.delete('/:scanId', authMiddleware, deleteDesignScan);

module.exports = router;