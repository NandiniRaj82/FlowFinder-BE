const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { createScan, getScans, getScanById, deleteScan } = require('../controllers/scanController');

router.post('/', auth, createScan);
router.get('/', auth, getScans);
router.get('/:id', auth, getScanById);
router.delete('/:id', auth, deleteScan);

module.exports = router;
