'use strict';
const puppeteer = require('puppeteer');
const axios = require('axios');
const { Jimp } = require('jimp');   // v1 named export
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

/* ─── URL helpers ────────────────────────────────────────────────────────── */
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
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function cssColorToHex(css) {
  if (!css || css === 'transparent' || css.includes('rgba(0, 0, 0, 0)')) return null;
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? rgbToHex(+m[1], +m[2], +m[3]) : null;
}
function colorDist(a, b) {
  try {
    const h2r = h => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const [r1, g1, b1] = h2r(a), [r2, g2, b2] = h2r(b);
    return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
  } catch { return 0; }
}

/* ─── Layer 1: Animation-frozen full-page screenshot ────────────────────── */
const FREEZE_CSS = `*,*::before,*::after{
  animation-duration:0.001ms!important;animation-delay:-1ms!important;
  transition-duration:0.001ms!important;transition-delay:0ms!important;
  scroll-behavior:auto!important;}`;

async function freezeAndScreenshot(url) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

    // Inject freeze CSS before page runs any JS
    await page.evaluateOnNewDocument(css => {
      Object.defineProperty(document, '__ffFreeze', { value: true });
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style'); s.textContent = css;
        document.head.prepend(s);
      });
    }, FREEZE_CSS);

    try { await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 }); }
    catch { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }

    await page.addStyleTag({ content: FREEZE_CSS });
    await page.evaluate(() => document.fonts.ready).catch(() => { });

    // Force intersection-observer hidden elements to show
    await page.evaluate(() => {
      document.querySelectorAll('[data-aos],[data-animate],.aos-init,.fade-up,.fade-in,.hidden,.invisible,[style*="opacity: 0"]').forEach(el => {
        el.style.cssText += ';opacity:1!important;visibility:visible!important;transform:none!important';
      });
      // Force lazy images
      document.querySelectorAll('img[loading="lazy"],img[data-src]').forEach(img => {
        if (img.dataset.src) img.src = img.dataset.src;
        img.removeAttribute('loading');
      });
    });

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      let pos = 0;
      while (pos < document.body.scrollHeight) {
        window.scrollTo(0, pos); pos += 400;
        await new Promise(r => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 2000));

    return await page.screenshot({ type: 'png', fullPage: true }); // returns Buffer
  } finally { if (browser) await browser.close(); }
}

/* ─── Layer 2A: Extract live CSS from DOM ───────────────────────────────── */
async function extractLiveStyles(url) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(css => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style'); s.textContent = css; document.head.prepend(s);
      });
    }, FREEZE_CSS);
    try { await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 }); }
    catch { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    await page.evaluate(() => document.fonts.ready).catch(() => { });
    await page.evaluate(() => {
      document.querySelectorAll('[data-aos],[data-animate],.aos-init,.fade-up,.fade-in,.hidden,.invisible').forEach(el => {
        el.style.cssText += ';opacity:1!important;visibility:visible!important;transform:none!important';
      });
    });
    await new Promise(r => setTimeout(r, 2000));

    return await page.evaluate(() => {
      const TAGS = 'h1,h2,h3,h4,h5,h6,p,a,button,nav,header,footer,section,main,article,ul,li,input,form,img,span,div';
      const results = [];
      document.querySelectorAll(TAGS).forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        if (rect.top > 12000) return;
        const cs = window.getComputedStyle(el);
        results.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 80),
          rect: { x: Math.round(rect.left), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
          styles: {
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            fontSize: cs.fontSize,
            fontFamily: cs.fontFamily,
            fontWeight: cs.fontWeight,
            lineHeight: cs.lineHeight,
            padding: cs.padding,
            borderRadius: cs.borderRadius,
            border: cs.border,
            boxShadow: cs.boxShadow,
          }
        });
      });
      return results;
    });
  } finally { if (browser) await browser.close(); }
}

/* ─── Layer 2B: Figma PNG + design tokens ───────────────────────────────── */
async function fetchFigmaData(figmaUrl, figmaToken) {
  const fileKey = extractFigmaFileKey(figmaUrl);
  let targetNodeId = extractFigmaNodeId(figmaUrl);

  if (!targetNodeId) {
    for (let i = 1; i <= 2; i++) {
      try {
        console.log(`[MatchDesign] Figma metadata attempt ${i}/2`);
        const r = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, { headers: { 'X-Figma-Token': figmaToken }, timeout: 60000 });
        const frame = r.data.document.children[0]?.children?.[0];
        if (!frame) throw new Error('No frames found.');
        targetNodeId = frame.id; break;
      } catch (e) {
        if (i < 2) await new Promise(r => setTimeout(r, 3000)); else throw e;
      }
    }
  } else { console.log(`[MatchDesign] Using node-id: ${targetNodeId}`); }

  let exportUrl;
  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`[MatchDesign] Figma export attempt ${i}/3`);
      const r = await axios.get(
        `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(targetNodeId)}&format=png&scale=1`,
        { headers: { 'X-Figma-Token': figmaToken }, timeout: 60000 }
      );
      exportUrl = r.data.images[targetNodeId];
      if (exportUrl) break; throw new Error('Empty URL');
    } catch (e) {
      if (i < 3) await new Promise(r => setTimeout(r, 5000)); else throw e;
    }
  }

  const dl = await axios.get(exportUrl, { responseType: 'arraybuffer', timeout: 120000 });
  const figmaBuf = Buffer.from(dl.data);

  // Fetch node design tokens
  let figmaNodes = [];
  try {
    const nr = await axios.get(
      `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(targetNodeId)}`,
      { headers: { 'X-Figma-Token': figmaToken }, timeout: 60000 }
    );
    const doc = nr.data.nodes[targetNodeId]?.document;
    if (doc) figmaNodes = flattenFigmaNodes(doc);
  } catch (e) { console.log('[MatchDesign] Node tree skipped:', e.message); }

  return { figmaBuf, figmaNodes };
}

function flattenFigmaNodes(node, out = []) {
  if (!node) return out;
  const n = { id: node.id, name: node.name, type: node.type, box: node.absoluteBoundingBox || null };
  if (node.fills) {
    const f = node.fills.find(f => f.type === 'SOLID' && f.visible !== false);
    if (f?.color) { const { r, g, b } = f.color; n.fillColor = rgbToHex(r * 255, g * 255, b * 255); }
  }
  if (node.style) {
    n.fontSize = node.style.fontSize; n.fontWeight = node.style.fontWeight;
    n.fontFamily = node.style.fontFamily; n.lineHeight = node.style.lineHeightPx;
  }
  if (node.type === 'TEXT') n.text = node.characters;
  if (node.cornerRadius != null) n.cornerRadius = node.cornerRadius;
  out.push(n);
  (node.children || []).forEach(c => flattenFigmaNodes(c, out));
  return out;
}

/* ─── Layer 2C: CSS vs Figma token comparison ───────────────────────────── */
function compareStyles(liveEls, figmaNodes, pgW, pgH) {
  const issues = [], seen = new Set();
  let num = 1;

  const toPct = box => box ? {
    x: Math.max(0, Math.round((box.x / pgW) * 100)),
    y: Math.max(0, Math.round((box.y / pgH) * 100)),
    width: Math.min(100, Math.round((box.width / pgW) * 100)),
    height: Math.min(40, Math.max(2, Math.round((box.height / pgH) * 100))),
  } : { x: 0, y: 0, width: 100, height: 5 };

  const closest = (box) => {
    if (!box) return null;
    let best = null, bd = Infinity;
    for (const el of liveEls) {
      const dx = (el.rect.x + el.rect.width / 2) - (box.x + box.width / 2);
      const dy = (el.rect.y + el.rect.height / 2) - (box.y + box.height / 2);
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = el; }
    }
    return bd < 350 ? best : null;
  };

  for (const fn of figmaNodes) {
    if (!fn.box || ['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'DOCUMENT', 'CANVAS'].includes(fn.type)) continue;
    const el = closest(fn.box);
    if (!el) continue;
    const bx = toPct(fn.box);

    // Color
    if (fn.fillColor) {
      const lc = cssColorToHex(el.styles.backgroundColor) || cssColorToHex(el.styles.color);
      if (lc && lc !== fn.fillColor) {
        const d = colorDist(fn.fillColor, lc);
        const key = `color_${fn.fillColor}_${lc}`;
        if (d > 30 && !seen.has(key)) {
          seen.add(key);
          issues.push({
            issueNumber: num++, category: 'Colors',
            severity: d > 120 ? 'critical' : d > 60 ? 'major' : 'minor',
            title: `Color mismatch — ${fn.name || fn.type}`,
            description: `Fill color in Figma design differs from live site.`,
            location: fn.name || `${fn.type} at (${fn.box.x | 0},${fn.box.y | 0})`,
            figmaValue: fn.fillColor, liveValue: lc, boundingBox: bx
          });
        }
      }
    }

    // Font size
    if (fn.fontSize && el.styles.fontSize) {
      const lp = parseFloat(el.styles.fontSize), fp = fn.fontSize;
      const key = `fs_${fp}_${lp}`;
      if (Math.abs(lp - fp) > 2 && !seen.has(key)) {
        seen.add(key);
        issues.push({
          issueNumber: num++, category: 'Typography',
          severity: Math.abs(lp - fp) > 8 ? 'major' : 'minor',
          title: `Font size mismatch — ${fn.name || fn.type}`,
          description: `Font size differs between Figma (${fp}px) and live site (${lp}px).`,
          location: fn.name || `Text at (${fn.box.x | 0},${fn.box.y | 0})`,
          figmaValue: `${fp}px`, liveValue: `${lp}px`, boundingBox: bx
        });
      }
    }

    // Font weight
    if (fn.fontWeight && el.styles.fontWeight) {
      const lw = parseInt(el.styles.fontWeight), fw = fn.fontWeight;
      const key = `fw_${fw}_${lw}`;
      if (Math.abs(lw - fw) >= 100 && !seen.has(key)) {
        seen.add(key);
        issues.push({
          issueNumber: num++, category: 'Typography',
          severity: 'minor',
          title: `Font weight mismatch — ${fn.name || fn.type}`,
          description: `Font weight differs: Figma uses ${fw}, live site uses ${lw}.`,
          location: fn.name || `Element at (${fn.box.x | 0},${fn.box.y | 0})`,
          figmaValue: `${fw}`, liveValue: `${lw}`, boundingBox: bx
        });
      }
    }

    // Border radius
    if (fn.cornerRadius != null && el.styles.borderRadius) {
      const lr = parseFloat(el.styles.borderRadius), fr = fn.cornerRadius;
      const key = `br_${fr}_${lr}`;
      if (Math.abs(lr - fr) > 2 && !seen.has(key)) {
        seen.add(key);
        issues.push({
          issueNumber: num++, category: 'Borders',
          severity: 'minor',
          title: `Border radius mismatch — ${fn.name || fn.type}`,
          description: `Corner radius: Figma is ${fr}px, live site is ${lr}px.`,
          location: fn.name || `Element at (${fn.box.x | 0},${fn.box.y | 0})`,
          figmaValue: `${fr}px`, liveValue: `${lr}px`, boundingBox: bx
        });
      }
    }

    // Missing text
    if (fn.text && fn.text.length > 2) {
      const liveText = (el.text || '').toLowerCase();
      const figText = fn.text.toLowerCase().slice(0, 60);
      if (!liveText.includes(figText.slice(0, 20)) && figText.length > 5) {
        const key = `txt_${figText.slice(0, 20)}`;
        if (!seen.has(key)) {
          seen.add(key);
          issues.push({
            issueNumber: num++, category: 'Content',
            severity: 'major',
            title: `Content mismatch — ${fn.name || 'text node'}`,
            description: `Text in Figma not found on live site.`,
            location: fn.name || `Text at (${fn.box.x | 0},${fn.box.y | 0})`,
            figmaValue: `"${fn.text.slice(0, 60)}"`, liveValue: `"${(el.text || '(not found)').slice(0, 60)}"`,
            boundingBox: bx
          });
        }
      }
    }
  }
  return issues;
}

/* ─── Layer 3: Pixel diff using pixelmatch ───────────────────────────────── */
async function runPixelDiff(livePngBuf, figmaBuf) {
  const parsePng = buf => new Promise((res, rej) => { const p = new PNG(); p.parse(buf, (e, d) => e ? rej(e) : res(d)); });

  const livePng = await parsePng(livePngBuf);
  let figmaPng;
  try { figmaPng = await parsePng(figmaBuf); }
  catch {
    // Figma image might not be a valid PNG — convert via Jimp
    const j = await Jimp.fromBuffer(figmaBuf);
    const pngBuf = await j.getBuffer('image/png');
    figmaPng = await parsePng(pngBuf);
  }

  const W = Math.min(livePng.width, figmaPng.width, 1440);
  const H = Math.min(livePng.height, figmaPng.height, 5000);

  // Resize both images to same W×H using Jimp v1 API
  const toRGBA = async (pngData, w, h) => {
    const rawBuf = Buffer.from(PNG.sync.write(pngData));
    const j = await Jimp.fromBuffer(rawBuf);
    j.resize({ w, h });                    // v1: resize takes an object
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const hex = j.getPixelColor(x, y); // returns RGBA int
        buf[i] = (hex >>> 24) & 0xff;
        buf[i + 1] = (hex >>> 16) & 0xff;
        buf[i + 2] = (hex >>> 8) & 0xff;
        buf[i + 3] = hex & 0xff;
      }
    }
    return buf;
  };

  const [liveRGBA, figmaRGBA] = await Promise.all([toRGBA(livePng, W, H), toRGBA(figmaPng, W, H)]);
  const diffBuf = Buffer.alloc(W * H * 4);
  const numDiff = pixelmatch(liveRGBA, figmaRGBA, diffBuf, W, H, { threshold: 0.15, includeAA: false });
  const matchPct = Math.max(0, Math.min(100, Math.round((1 - numDiff / (W * H)) * 100)));

  const diffPng = new PNG({ width: W, height: H });
  diffBuf.copy(diffPng.data);
  const diffBase64 = PNG.sync.write(diffPng).toString('base64');

  const clusters = clusterDiffRegions(diffBuf, W, H);
  return { matchPct, diffBase64, clusters, W, H };
}

/* ─── Cluster diff pixels → bounding boxes ──────────────────────────────── */
function clusterDiffRegions(diffBuf, W, H) {
  const BLOCK = 40; // group pixels into 40px blocks
  const cols = Math.ceil(W / BLOCK), rows = Math.ceil(H / BLOCK);
  const blocks = new Uint8Array(cols * rows);

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (diffBuf[i] > 100 && diffBuf[i + 1] < 50) { // red pixel = diff
      const bx = Math.floor(x / BLOCK), by = Math.floor(y / BLOCK);
      blocks[by * cols + bx] = 1;
    }
  }

  const clusters = [];
  const visited = new Uint8Array(cols * rows);
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
    if (!blocks[by * cols + bx] || visited[by * cols + bx]) continue;
    // Simple flood fill
    const queue = [[bx, by]], inCluster = [[bx, by]];
    visited[by * cols + bx] = 1;
    while (queue.length) {
      const [cx, cy] = queue.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        if (visited[ny * cols + nx] || !blocks[ny * cols + nx]) continue;
        visited[ny * cols + nx] = 1; queue.push([nx, ny]); inCluster.push([nx, ny]);
      }
    }
    if (inCluster.length < 2) continue; // skip tiny single-block diffs
    const minBX = Math.min(...inCluster.map(c => c[0]));
    const maxBX = Math.max(...inCluster.map(c => c[0]));
    const minBY = Math.min(...inCluster.map(c => c[1]));
    const maxBY = Math.max(...inCluster.map(c => c[1]));
    clusters.push({
      x: Math.round(((minBX * BLOCK) / W) * 100),
      y: Math.round(((minBY * BLOCK) / H) * 100),
      width: Math.min(100, Math.round((((maxBX - minBX + 1) * BLOCK) / W) * 100)),
      height: Math.min(40, Math.max(2, Math.round((((maxBY - minBY + 1) * BLOCK) / H) * 100))),
    });
  }
  return clusters.slice(0, 20); // cap at 20 pixel regions
}

/* ─── Merge CSS + pixel issues into final mismatch list ─────────────────── */
function buildMismatches(cssIssues, pixelClusters, startNum) {
  const pixelIssues = pixelClusters.map((box, i) => ({
    issueNumber: startNum + i,
    category: 'Layout',
    severity: 'major',
    title: `Visual difference in region #${i + 1}`,
    description: `Pixel comparison detected a visual difference in this region. Check colors, spacing, or missing/extra elements.`,
    location: `Page region at ~${box.y}% from top`,
    figmaValue: 'See Figma design',
    liveValue: 'See live site',
    boundingBox: box,
  }));
  return [...cssIssues, ...pixelIssues];
}

/* ─── Score ──────────────────────────────────────────────────────────────── */
function computeScores(matchPct, cssIssueCount) {
  // Blend pixel score with CSS penalty
  const cssPenalty = Math.min(30, cssIssueCount * 3);
  const matchScore = Math.max(0, Math.min(100, Math.round(matchPct - cssPenalty)));
  return { matchScore, projectedScore: 100 };
}

/* ─── Main handler ───────────────────────────────────────────────────────── */
const matchDesign = async (req, res) => {
  const { websiteUrl, figmaUrl } = req.body;
  if (!websiteUrl || !figmaUrl)
    return res.status(400).json({ success: false, message: 'Both website URL and Figma URL are required.' });

  const figmaToken = process.env.FIGMA_API_TOKEN;
  if (!figmaToken)
    return res.status(500).json({ success: false, message: 'FIGMA_API_TOKEN not set in .env' });

  try {
    console.log('[MatchDesign] Step 1/4 — Animation-frozen screenshot:', websiteUrl);
    const [livePngBuf, liveStyles] = await Promise.all([
      freezeAndScreenshot(websiteUrl),
      extractLiveStyles(websiteUrl),
    ]);

    console.log('[MatchDesign] Step 2/4 — Fetching Figma data:', figmaUrl);
    const { figmaBuf, figmaNodes } = await fetchFigmaData(figmaUrl, figmaToken);

    console.log('[MatchDesign] Step 3/4 — Pixel diff comparison...');
    const { matchPct, diffBase64, clusters, W, H } = await runPixelDiff(livePngBuf, figmaBuf);

    console.log('[MatchDesign] Step 4/4 — CSS token comparison...');
    // Estimate page height from live screenshot buffer
    const livePng = PNG.sync.read(livePngBuf);
    const cssIssues = compareStyles(liveStyles, figmaNodes, 1440, livePng.height || 5000);

    const allMismatches = buildMismatches(cssIssues, clusters, cssIssues.length + 1);
    // Re-number everything
    allMismatches.forEach((m, i) => { m.issueNumber = i + 1; });

    const { matchScore, projectedScore } = computeScores(matchPct, cssIssues.length);
    console.log(`[MatchDesign] Done. Pixel match: ${matchPct}%, Final score: ${matchScore}%, Issues: ${allMismatches.length}`);

    return res.status(200).json({
      success: true,
      mismatches: allMismatches,
      totalIssues: allMismatches.length,
      matchScore,
      projectedScore,
      pixelMatchPercent: matchPct,
      websiteUrl,
      figmaUrl,
      websiteScreenshotBase64: livePngBuf.toString('base64'),
      figmaScreenshotBase64: figmaBuf.toString('base64'),
      diffImageBase64: diffBase64,
    });

  } catch (error) {
    console.error('[MatchDesign] Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Comparison failed.' });
  }
};

module.exports = { matchDesign };