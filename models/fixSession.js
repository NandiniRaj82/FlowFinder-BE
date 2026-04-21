const mongoose = require('mongoose');

const MappedFileSchema = new mongoose.Schema({
  filePath: String,      // e.g. "src/components/Header.tsx"
  content: String,       // original file content
  fixedContent: String,  // AI-generated fixed content
  diff: String,          // unified diff string
  confidence: Number,    // 0-100 mapping confidence
  changes: [{
    line: Number,
    original: String,
    fixed: String,
    reason: String,      // "WCAG 1.1.1 — Missing alt text"
  }],
  accepted: { type: Boolean, default: false },
}, { _id: false });

const FixSessionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },

  // Source of the fixes
  scanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Scan' },
  scanType: { type: String, enum: ['accessibility', 'design'], default: 'accessibility' },
  fixType: { type: String, enum: ['accessibility', 'design'], default: 'accessibility' },
  websiteUrl: String,

  // Target repository
  repoFullName: String,   // "username/repo-name"
  repoDefaultBranch: String,
  framework: String,      // 'react', 'nextjs', 'vue', 'html', etc.

  // Generated fixes
  mappedFiles: [MappedFileSchema],
  totalFilesChanged: { type: Number, default: 0 },
  totalFixesApplied: { type: Number, default: 0 },

  // PR details
  branchName: String,
  prUrl: String,
  prNumber: Number,
  prTitle: String,
  prBody: String,

  // Status
  status: {
    type: String,
    enum: ['pending', 'mapping', 'generating', 'review', 'creating_pr', 'pr_created', 'error'],
    default: 'pending',
  },
  errorMessage: String,

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

FixSessionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.FixSession || mongoose.model('FixSession', FixSessionSchema);
