'use strict';
const mongoose = require('mongoose');

/**
 * RedesignHistory — persists every Website Redesigner result.
 * Mirrors DesignScan pattern: stores full results so users can revisit.
 */
const RedesignHistorySchema = new mongoose.Schema({
  userId:         { type: String, required: true, index: true },
  websiteUrl:     { type: String, required: true },
  styleName:      { type: String, default: '' },
  style:          { type: String, default: '' },   // style key e.g. 'minimal', 'bold'
  framework:      { type: String, default: 'html' },
  frameworkLabel: { type: String, default: '' },

  // The generated HTML preview (full code)
  previewHtml:    { type: String, default: '' },

  isSaved:        { type: Boolean, default: false },

  createdAt:      { type: Date, default: Date.now, index: true },
});

// Compound index for fast user history
RedesignHistorySchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.RedesignHistory || mongoose.model('RedesignHistory', RedesignHistorySchema);
