const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { runLighthouseAudit, getSiteUrls } = require('../services/lighthouseService');

/**
 * POST /api/lighthouse/audit
 * Run a Lighthouse audit on a URL (merged from extension backend port 3000)
 */
router.post('/audit', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const result = await runLighthouseAudit(url);
    res.json(result);
  } catch (err) {
    console.error('[Lighthouse] Audit error:', err);
    res.status(500).json({ error: 'Lighthouse audit failed', message: err.message });
  }
});

/**
 * POST /api/lighthouse/sitemap
 * Discover all URLs of a site via sitemap or crawl
 */
router.post('/sitemap', async (req, res) => {
  const { url, crawlIfNoSitemap = true, maxCrawlPages = 50 } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const result = await getSiteUrls(url, crawlIfNoSitemap, maxCrawlPages);
    res.json(result);
  } catch (err) {
    console.error('[Lighthouse] Sitemap error:', err);
    res.status(500).json({ error: 'Sitemap fetch failed', message: err.message });
  }
});

module.exports = router;
