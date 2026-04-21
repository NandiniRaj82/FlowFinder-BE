const mongoose = require('mongoose');

const ErrorItemSchema = new mongoose.Schema({
  type: String,
  title: String,
  message: String,
  impact: { type: String, enum: ['critical', 'serious', 'moderate', 'minor', 'unknown'] },
  selector: String,
  source: { type: String, enum: ['lighthouse', 'axe', 'extension', 'manual'] },
  sourceUrl: String,
  wcagCriteria: String,
  pages: [String],
}, { _id: false });

const ScanSchema = new mongoose.Schema({
  // Owner
  userId: { type: String, required: true, index: true }, // Firebase UID

  // What was scanned
  websiteUrl: { type: String, required: true },
  scanType: {
    type: String,
    enum: ['page', 'site'],
    default: 'page',
  },
  source: {
    type: String,
    enum: ['extension', 'manual', 'api'],
    default: 'extension',
  },

  // Results
  errors: [ErrorItemSchema],
  scores: {
    performance: Number,
    accessibility: Number,
    bestPractices: Number,
    seo: Number,
  },
  totalErrors: { type: Number, default: 0 },

  // Status
  status: {
    type: String,
    enum: ['pending', 'complete', 'error'],
    default: 'complete',
  },

  // GitHub fix tracking
  fixSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FixSession' },

  createdAt: { type: Date, default: Date.now, index: true },
});

// Index for fast user scan history
ScanSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.Scan || mongoose.model('Scan', ScanSchema);

