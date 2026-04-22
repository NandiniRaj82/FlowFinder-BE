'use strict';

const Scan = require('../models/scan');
const FixSession = require('../models/fixSession');
const UserProfile = require('../models/userProfile');
const DesignScan = require('../models/designScan');

/**
 * GET /api/dashboard/stats
 * Returns real aggregated analytics for the authenticated user.
 */
const getDashboardStats = async (req, res) => {
  try {
    const uid = req.user.uid;

    // Run all DB queries in parallel for performance
    const [
      totalScans,
      scansWithErrors,
      totalFixSessions,
      prRaisedCount,
      recentScans,
      recentFixes,
      userProfile,
      errorAgg,
      scoreAgg,
      fixAgg,
    ] = await Promise.all([
      // Total scans
      Scan.countDocuments({ userId: uid }),

      // Scans that had at least 1 error
      Scan.countDocuments({ userId: uid, totalErrors: { $gt: 0 } }),

      // Total fix sessions started
      FixSession.countDocuments({ userId: uid }),

      // PRs actually raised
      FixSession.countDocuments({ userId: uid, status: 'pr_created' }),

      // Recent 6 accessibility scans
      Scan.find({ userId: uid })
        .sort({ createdAt: -1 })
        .limit(6)
        .select('websiteUrl scanType source totalErrors scores status createdAt'),

      // Recent 4 fix sessions
      FixSession.find({ userId: uid })
        .sort({ createdAt: -1 })
        .limit(4)
        .select('repoFullName status totalFilesChanged totalFixesApplied prUrl prNumber branchName createdAt scanId'),

      // GitHub connection status
      UserProfile.findOne({ uid }).select('github.username github.avatarUrl github.connectedAt'),

      // Aggregate total errors across all scans
      Scan.aggregate([
        { $match: { userId: uid } },
        { $group: { _id: null, totalErrors: { $sum: '$totalErrors' } } },
      ]),

      // Average accessibility scores
      Scan.aggregate([
        { $match: { userId: uid, 'scores.accessibility': { $exists: true } } },
        {
          $group: {
            _id: null,
            avgAccessibility: { $avg: '$scores.accessibility' },
            avgPerformance:   { $avg: '$scores.performance' },
            avgSeo:           { $avg: '$scores.seo' },
          },
        },
      ]),

      // Total files fixed and issues fixed across all sessions
      FixSession.aggregate([
        { $match: { userId: uid } },
        {
          $group: {
            _id: null,
            totalFilesFixed:  { $sum: '$totalFilesChanged' },
            totalIssuesFixed: { $sum: '$totalFixesApplied' },
          },
        },
      ]),
    ]);

    const totalErrors      = errorAgg[0]?.totalErrors ?? 0;
    const avgAccessibility = Math.round(scoreAgg[0]?.avgAccessibility ?? 0);
    const avgPerformance   = Math.round(scoreAgg[0]?.avgPerformance ?? 0);
    const avgSeo           = Math.round(scoreAgg[0]?.avgSeo ?? 0);
    const totalFilesFixed  = fixAgg[0]?.totalFilesFixed ?? 0;
    const totalIssuesFixed = fixAgg[0]?.totalIssuesFixed ?? 0;

    // Scan breakdown by source
    const [extensionScans, manualScans, totalDesignScans, recentDesignScans, designScoreAgg] = await Promise.all([
      Scan.countDocuments({ userId: uid, source: 'extension' }),
      Scan.countDocuments({ userId: uid, source: { $ne: 'extension' } }),
      DesignScan.countDocuments({ userId: uid }),
      DesignScan.find({ userId: uid })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('websiteUrl figmaUrl matchScore verdict createdAt'),
      DesignScan.aggregate([
        { $match: { userId: uid } },
        { $group: { _id: null, avgMatchScore: { $avg: '$matchScore' } } },
      ]),
    ]);
    const avgMatchScore = Math.round(designScoreAgg[0]?.avgMatchScore ?? 0);

    // Scans in the last 7 days
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const scansThisWeek = await Scan.countDocuments({ userId: uid, createdAt: { $gte: weekAgo } });

    return res.json({
      success: true,
      stats: {
        // Core metrics
        totalScans,
        scansWithErrors,
        scansThisWeek,
        totalErrors,
        totalFixSessions,
        prRaisedCount,
        totalFilesFixed,
        totalIssuesFixed,

        // Source breakdown
        extensionScans,
        manualScans,

        // Design comparison
        totalDesignScans,
        avgMatchScore,

        // Averages
        avgAccessibility,
        avgPerformance,
        avgSeo,

        // GitHub status
        github: userProfile?.github
          ? {
              connected: true,
              username: userProfile.github.username,
              avatarUrl: userProfile.github.avatarUrl,
              connectedAt: userProfile.github.connectedAt,
            }
          : { connected: false },
      },
      recentScans,
      recentFixes,
      recentDesignScans,
    });
  } catch (err) {
    console.error('[Dashboard] getStats error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getDashboardStats };
