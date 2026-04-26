'use strict';
const puppeteer = require('puppeteer');
const axios = require('axios');

const FREEZE_CSS = `*,*::before,*::after{
  animation-duration:0.001ms!important;animation-delay:-1ms!important;
  transition-duration:0.001ms!important;transition-delay:0ms!important;
  scroll-behavior:auto!important;}`;

/* ─── Figma: extract frame dimensions + node tree + screenshot ────────── */
function extractFigmaFileKey(url) {
  const m = url.match(/figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9]+)/);
  if (!m) throw new Error('Invalid Figma URL.');
  return m[1];
}
function extractFigmaNodeId(url) {
  try {
    const id = new URL(url).searchParams.get('node-id');
    return id ? id.replace(/-/g, ':') : null;
  } catch { return null; }
}

async function ingestFigma(figmaUrl, figmaToken) {
  const fileKey = extractFigmaFileKey(figmaUrl);
  let nodeId = extractFigmaNodeId(figmaUrl);

  // Resolve node ID if not in URL
  if (!nodeId) {
    try {
      const r = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
        headers: { 'X-Figma-Token': figmaToken }, timeout: 60000,
      });
      const frame = r.data.document.children[0]?.children?.[0];
      if (!frame) throw new Error('No frames found in Figma file.');
      nodeId = frame.id;
    } catch (e) {
      if (e.response?.status === 404) throw new Error('Figma file not found. Check the URL is correct and the token has access.');
      if (e.response?.status === 403) throw new Error('Figma token does not have access to this file.');
      throw e;
    }
  }

  // Get node tree with full details
  let nodesResp;
  try {
    nodesResp = await axios.get(
      `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
      { headers: { 'X-Figma-Token': figmaToken }, timeout: 60000 }
    );
  } catch (e) {
    if (e.response?.status === 404) throw new Error('Figma node not found. The node-id in the URL may be invalid.');
    throw e;
  }
  const nodeDoc = nodesResp.data.nodes[nodeId]?.document;
  if (!nodeDoc) throw new Error('Could not fetch Figma node tree.');

  // Extract frame dimensions
  const frameBbox = nodeDoc.absoluteBoundingBox;
  const frameWidth = frameBbox ? Math.round(frameBbox.width) : 1440;
  const frameHeight = frameBbox ? Math.round(frameBbox.height) : 900;

  // Export PNG at scale=1 (100% — matches what browser renders at 1:1 pixel ratio)
  let exportUrl;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await axios.get(
        `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=1`,
        { headers: { 'X-Figma-Token': figmaToken }, timeout: 60000 }
      );
      exportUrl = r.data.images[nodeId];
      if (exportUrl) break;
      throw new Error('Empty export URL');
    } catch (e) {
      if (i < 3) await new Promise(r => setTimeout(r, 4000));
      else throw e;
    }
  }

  const dl = await axios.get(exportUrl, { responseType: 'arraybuffer', timeout: 120000 });
  const figmaBuf = Buffer.from(dl.data);

  console.log(`[Ingestion] Figma frame: ${frameWidth}×${frameHeight}px`);
  return { figmaBuf, nodeDoc, frameWidth, frameHeight };
}

/* ─── Live Site: viewport-synced screenshot + DOM extraction ─────────── */
async function ingestLiveSite(url, viewportWidth, viewportHeight) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // Force 100% zoom / no scaling
        '--force-device-scale-factor=1',
        '--high-dpi-support=1',
      ],
    });
    const page = await browser.newPage();

    // CRITICAL: Match Figma frame WIDTH exactly.
    // Use a STANDARD window height (900px) — NOT the Figma frame height.
    // The Figma frame height may be 4000-8000px which forces the page to render
    // in "giant viewport" mode, causing layout shifts and scale differences.
    // fullPage:true in the screenshot still captures the full scrollable page.
    const targetWidth = Math.max(320, Math.min(viewportWidth, 2560));
    const windowHeight = 900; // Standard desktop browser height

    await page.setViewport({
      width: targetWidth,
      height: windowHeight,
      deviceScaleFactor: 1, // Ensure no HiDPI scaling — renders at exactly 1:1 pixel ratio
    });

    // Freeze animations before page loads
    await page.evaluateOnNewDocument(css => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = css;
        document.head.prepend(s);
      });
    }, FREEZE_CSS);

    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    } catch {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await page.addStyleTag({ content: FREEZE_CSS });
    await page.evaluate(() => document.fonts.ready).catch(() => {});

    // Reveal hidden/lazy elements
    await page.evaluate(() => {
      document.querySelectorAll(
        '[data-aos],[data-animate],.aos-init,.fade-up,.fade-in,.hidden,.invisible,[style*="opacity: 0"]'
      ).forEach(el => {
        el.style.cssText += ';opacity:1!important;visibility:visible!important;transform:none!important';
      });
      document.querySelectorAll('img[loading="lazy"],img[data-src]').forEach(img => {
        if (img.dataset.src) img.src = img.dataset.src;
        img.removeAttribute('loading');
      });
    });

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      let pos = 0;
      while (pos < document.body.scrollHeight) {
        window.scrollTo(0, pos);
        pos += 400;
        await new Promise(r => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 2000));

    // Phase 1 Data Extraction: DOM traversal payload
    // Note: DOM positions are relative to the page origin (scrollY added)
    // and are in the same pixel space as the viewport width we set.
    const domElements = await page.evaluate(() => {
      const TAGS = 'h1,h2,h3,h4,h5,h6,p,a,button,nav,header,footer,section,main,article,ul,li,ol,input,textarea,select,form,img,svg,span,div,label,figure,figcaption,blockquote,table,th,td';
      const results = [];
      document.querySelectorAll(TAGS).forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        if (rect.top > 15000) return;
        const cs = window.getComputedStyle(el);
        // Skip truly invisible
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (parseFloat(cs.opacity) < 0.05) return;

        // Build a useful CSS selector
        let selector = el.tagName.toLowerCase();
        if (el.id) selector += `#${el.id}`;
        else if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
          if (cls) selector += `.${cls}`;
        }

        // Get direct text only (not children)
        let directText = '';
        for (const node of el.childNodes) {
          if (node.nodeType === 3) directText += node.textContent;
        }
        const text = directText.trim() || (el.textContent || '').trim();

        results.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          classes: (typeof el.className === 'string' ? el.className : '').trim(),
          ariaLabel: el.getAttribute('aria-label') || '',
          dataTestId: el.getAttribute('data-testid') || '',
          text: text.slice(0, 200),
          selector,
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          styles: {
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            fontSize: cs.fontSize,
            fontFamily: cs.fontFamily,
            fontWeight: cs.fontWeight,
            lineHeight: cs.lineHeight,
            padding: cs.padding,
            margin: cs.margin,
            borderRadius: cs.borderRadius,
            border: cs.border,
            borderColor: cs.borderColor,
            borderWidth: cs.borderWidth,
            boxShadow: cs.boxShadow,
            opacity: cs.opacity,
            display: cs.display,
          },
        });
      });
      return results;
    });

    // Full-page screenshot — captures entire scrollable page at deviceScaleFactor:1
    const screenshotBuf = await page.screenshot({ type: 'png', fullPage: true });

    console.log(`[Ingestion] Live site: ${domElements.length} DOM elements extracted`);
    return { screenshotBuf, domElements };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { ingestFigma, ingestLiveSite };
