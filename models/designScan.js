'use strict';
const mongoose = require('mongoose');

/**
 * DesignScan — persists every Match Design comparison.
 * Each scan stores full results so users can revisit without re-processing.
 */
const MismatchSchema = new mongoose.Schema({
  issueNumber: Number,
  category: String,
  severity: String,
  title: String,
  description: String,
  location: String,
  figmaValue: String,
  liveValue: String,
  boundingBox: {
    x: Number, y: Number,
    width: Number, height: Number,
  },
  property: String,
  delta: Number,
  matchConfidence: Number,
}, { _id: false });

const DesignScanSchema = new mongoose.Schema({
  userId:    { type: String, required: true, index: true },
  websiteUrl: { type: String, required: true },
  figmaUrl:   { type: String, required: true },

  // Scores & analysis
  matchScore:        Number,
  projectedScore:    Number,
  pixelMatchPercent: Number,
  layoutDivergence:  Number,
  verdict:           { type: String, enum: ['excellent','good','partial','divergent','unrelated'] },
  verdictDetail:     String,
  sectionScores:     [Number],   // 10-element array
  worstSection:      mongoose.Schema.Types.Mixed,
  totalIssues:       { type: Number, default: 0 },
  mismatches:        [MismatchSchema],

  // Screenshots stored as base64 strings
  // For high-scale, migrate to S3 presigned URLs
  websiteScreenshotBase64: String,
  figmaScreenshotBase64:   String,
  diffImageBase64:          String,

  status: {
    type: String,
    enum: ['complete', 'error'],
    default: 'complete',
  },
  errorMessage: String,

  createdAt: { type: Date, default: Date.now, index: true },
});

// Compound index for fast user history
DesignScanSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.DesignScan || mongoose.model('DesignScan', DesignScanSchema);
