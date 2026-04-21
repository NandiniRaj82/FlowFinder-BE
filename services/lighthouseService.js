'use strict';

/**
 * lighthouseService.js
 *
 * Merged from extension backend (port 3000).
 * Runs Lighthouse audits and sitemap/crawl discovery.
 * Now part of the main backend (port 5000).
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── Run Lighthouse audit ─────────────────────────────────────────────────────
async function runLighthouseAudit(url) {
  const lighthouse = (await import('lighthouse')).default;
  const { launch } = await import('chrome-launcher');

  const chrome = await launch({
    chromeFlags: ['--headless', '--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const options = {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'seo', 'best-practices', 'accessibility'],
      port: chrome.port,
    };

    const result = await lighthouse(url, options);
    const lhr = result.lhr;

    const accessibilityIssues = Object.values(lhr.audits)
      .filter(a => a.score === 0 && a.details?.type === 'table')
      .map(a => {
        let selector = null;
        if (a.details?.items?.length > 0) {
          const first = a.details.items[0];
          selector = first.selector || first.node?.selector || null;
        }
        return {
          id: a.id,
          title: a.title,
          description: a.description,
          selector,
          source: 'lighthouse',
        };
      });

    return {
      scores: {
        performance: Math.round(lhr.categories.performance.score * 100),
        seo: Math.round(lhr.categories.seo.score * 100),
        bestPractices: Math.round(lhr.categories['best-practices'].score * 100),
        accessibility: Math.round(lhr.categories.accessibility.score * 100),
      },
      lighthouseAccessibilityIssues: accessibilityIssues,
    };
  } finally {
    await chrome.kill();
  }
}

// ─── Crawl & sitemap discovery ────────────────────────────────────────────────
async function crawlWebsite(baseUrl, maxPages = 50) {
  const { JSDOM } = await import('jsdom');
  const urlObj = new URL(baseUrl);
  const domain = `${urlObj.protocol}//${urlObj.host}`;
  const discovered = new Set([baseUrl]);
  const visited = new Set();
  const toVisit = [baseUrl];

  while (toVisit.length > 0 && visited.size < maxPages) {
    const currentUrl = toVisit.shift();
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    try {
      const response = await fetch(currentUrl, {
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FlowFinder/1.0)' },
      });

      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) continue;

      const html = await response.text();
      const dom = new JSDOM(html);

      dom.window.document.querySelectorAll('a[href]').forEach(link => {
        try {
          let href = link.href;
          if (href.startsWith('/')) href = `${domain}${href}`;
          else if (!href.startsWith('http')) return;

          const linkUrl = new URL(href);
          if (linkUrl.host !== urlObj.host) return;

          const path = linkUrl.pathname.toLowerCase();
          if (path.match(/\.(jpg|jpeg|png|gif|pdf|zip|mp4|css|js|svg|webp|ico)$/)) return;

          linkUrl.hash = '';
          const cleanUrl = linkUrl.toString();
          if (!discovered.has(cleanUrl)) {
            discovered.add(cleanUrl);
            if (visited.size + toVisit.length < maxPages) toVisit.push(cleanUrl);
          }
        } catch {}
      });
    } catch (err) {
      console.warn(`[Lighthouse] Crawl failed for ${currentUrl}:`, err.message);
    }
  }

  return Array.from(discovered);
}

async function fetchSitemapURLs(baseUrl) {
  const { parseString } = await import('xml2js');
  const { JSDOM } = await import('jsdom');
  const urlObj = new URL(baseUrl);
  const domain = `${urlObj.protocol}//${urlObj.host}`;

  const sitemapCandidates = [
    `${domain}/sitemap.xml`,
    `${domain}/sitemap_index.xml`,
    `${domain}/page-sitemap.xml`,
  ];

  for (const sitemapUrl of sitemapCandidates) {
    try {
      const response = await fetch(sitemapUrl, { timeout: 5000 });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.includes('<urlset') || text.includes('<sitemapindex')) {
        return await new Promise((resolve, reject) => {
          parseString(text, (err, result) => {
            if (err) return reject(err);
            let urls = [];
            if (result?.urlset?.url) {
              urls = result.urlset.url.map(u => u.loc[0]).filter(u => {
                const p = new URL(u).pathname.toLowerCase();
                return !p.match(/\.(jpg|jpeg|png|pdf|css|js|svg|xml)$/);
              });
            }
            resolve({ isSitemapIndex: false, urls });
          });
        });
      }
    } catch {}
  }

  return null;
}

async function getSiteUrls(url, crawlIfNoSitemap = true, maxPages = 50) {
  const result = await fetchSitemapURLs(url);

  if (result?.urls?.length > 0) {
    return { success: true, method: 'sitemap', urls: result.urls };
  }

  if (crawlIfNoSitemap) {
    const urls = await crawlWebsite(url, maxPages);
    return { success: true, method: 'crawl', urls };
  }

  return { success: false, method: 'none', urls: [url] };
}

module.exports = { runLighthouseAudit, getSiteUrls };
