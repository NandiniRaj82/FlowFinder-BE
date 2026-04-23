const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth');
const { redesignWebsite } = require('../controllers/designSuggesterController');
const RedesignHistory = require('../models/redesignHistory');

router.use((req, res, next) => { res.setTimeout(600000); next(); }); // 10 minutes

// POST /api/redesign — generate redesigns (existing SSE endpoint)
router.post('/', authMiddleware, redesignWebsite);

// GET /api/redesign/history — fetch user's redesign history (metadata only, no previewHtml for speed)
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const scans = await RedesignHistory.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('-previewHtml') // exclude heavy HTML for listing
      .lean();
    res.json({ history: scans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/redesign/:id — fetch a single redesign with full code
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const entry = await RedesignHistory.findOne({ _id: req.params.id, userId }).lean();
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json({ entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/redesign/:id/save — toggle saved status
router.patch('/:id/save', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const entry = await RedesignHistory.findOne({ _id: req.params.id, userId });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    entry.isSaved = !entry.isSaved;
    await entry.save();
    res.json({ isSaved: entry.isSaved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/redesign/:id — delete a redesign
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const result = await RedesignHistory.deleteOne({ _id: req.params.id, userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;