'use strict';

const Scan = require('../models/scan');
const UserProfile = require('../models/userProfile');

/**
 * POST /api/scans
 * Create a new scan (called by extension or manual upload flow)
 */
const createScan = async (req, res) => {
  try {
    const { websiteUrl, scanType = 'page', source = 'extension', errors = [], scores = {} } = req.body;

    if (!websiteUrl) {
      return res.status(400).json({ success: false, message: 'websiteUrl is required.' });
    }

    // Ensure user profile exists
    await UserProfile.upsertFromFirebase(req.user);

    const scan = await Scan.create({
      userId: req.user.uid,
      websiteUrl,
      scanType,
      source,
      errors,
      scores,
      totalErrors: errors.length,
      status: 'complete',
    });

    return res.status(201).json({ success: true, scan });
  } catch (err) {
    console.error('[ScanController] createScan:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/scans
 * List scans for the authenticated user, newest first
 */
const getScans = async (req, res) => {
  try {
    const { page = 1, limit = 20, url } = req.query;
    const filter = { userId: req.user.uid };
    if (url) filter.websiteUrl = { $regex: url, $options: 'i' };

    const [scans, total] = await Promise.all([
      Scan.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .select('-errors') // exclude heavy errors array in list view
        .lean(),
      Scan.countDocuments(filter),
    ]);

    res.json({ success: true, scans, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[ScanController] getScans:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/scans/:id
 * Get full scan details including all errors
 */
const getScanById = async (req, res) => {
  try {
    const scan = await Scan.findOne({ _id: req.params.id, userId: req.user.uid }).lean();
    if (!scan) return res.status(404).json({ success: false, message: 'Scan not found.' });
    res.json({ success: true, scan });
  } catch (err) {
    console.error('[ScanController] getScanById:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/scans/:id
 */
const deleteScan = async (req, res) => {
  try {
    const result = await Scan.deleteOne({ _id: req.params.id, userId: req.user.uid });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, message: 'Scan not found.' });
    res.json({ success: true, message: 'Scan deleted.' });
  } catch (err) {
    console.error('[ScanController] deleteScan:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { createScan, getScans, getScanById, deleteScan };
