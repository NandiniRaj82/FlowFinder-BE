'use strict';
const puppeteer = require('puppeteer');
const axios = require('axios');
const { Jimp } = require('jimp');   // v1 named export
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const DesignScan = require('../models/designScan');
const UserProfile = require('../models/userProfile');

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
        // No hard cap — extract styles for the full page
        if (rect.top > 30000) return;
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
    height: Math.min(90, Math.max(2, Math.round((box.height / pgH) * 100))),
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
    return bd < 600 ? best : null;
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

/* ─── Layer 3: Chunked pixel diff — full height, no gaps ────────────────── */
// CRITICAL FIX: we use MAX(liveH, figmaH) as the comparison height.
// Whichever image is shorter is padded with a contrasting fill (magenta) so
// every pixel of the taller image gets compared instead of being silently dropped.
const CHUNK_H = 2000;  // pixels per strip — keeps RAM constant
const PAD_FILL = [255, 0, 255, 255]; // magenta = guaranteed diff pixel

async function runPixelDiff(livePngBuf, figmaBuf) {
  const parsePng = buf => new Promise((res, rej) => { const p = new PNG(); p.parse(buf, (e, d) => e ? rej(e) : res(d)); });

  const livePng = await parsePng(livePngBuf);
  let figmaPng;
  try { figmaPng = await parsePng(figmaBuf); }
  catch {
    const j = await Jimp.fromBuffer(figmaBuf);
    const pngBuf = await j.getBuffer('image/png');
    figmaPng = await parsePng(pngBuf);
  }

  const W = Math.min(livePng.width, figmaPng.width, 1440);
  // Use MAX height — the shorter image is padded so no pixels are skipped
  const liveH = livePng.height;
  const figmaH = figmaPng.height;
  const H = Math.max(liveH, figmaH);
  const layoutDivergence = Math.round((Math.abs(liveH - figmaH) / H) * 100);

  console.log(`[MatchDesign] Pixel diff: ${W}x${H}px (live=${liveH}px figma=${figmaH}px) in ${Math.ceil(H / CHUNK_H)} chunk(s)`);

  // Extract RGBA strip — pads with PAD_FILL if strip extends beyond image height
  const getStrip = async (pngData, yStart, yEnd, targetW) => {
    const stripH = yEnd - yStart;
    const actualH = Math.max(0, Math.min(pngData.height - yStart, stripH)); // real pixels available
    const buf = Buffer.alloc(targetW * stripH * 4, 0);

    if (actualH > 0) {
      // Write PNG to buffer then use Jimp to crop+resize only the real section
      const rawBuf = Buffer.from(PNG.sync.write(pngData));
      const j = await Jimp.fromBuffer(rawBuf);
      j.crop({ x: 0, y: yStart, w: Math.min(pngData.width, targetW + 10), h: actualH });
      j.resize({ w: targetW, h: actualH }); // resize ONLY the real part

      for (let y = 0; y < actualH; y++) {
        for (let x = 0; x < targetW; x++) {
          const i = (y * targetW + x) * 4;
          const hex = j.getPixelColor(x, y);
          buf[i]     = (hex >>> 24) & 0xff;
          buf[i + 1] = (hex >>> 16) & 0xff;
          buf[i + 2] = (hex >>>  8) & 0xff;
          buf[i + 3] =  hex         & 0xff;
        }
      }
    }

    // Pad the remaining rows with contrasting color (guaranteed diff)
    for (let y = actualH; y < stripH; y++) {
      for (let x = 0; x < targetW; x++) {
        const i = (y * targetW + x) * 4;
        buf[i] = PAD_FILL[0]; buf[i+1] = PAD_FILL[1]; buf[i+2] = PAD_FILL[2]; buf[i+3] = PAD_FILL[3];
      }
    }
    return buf;
  };

  let totalDiffPixels = 0;
  const allClusters = [];
  const diffStrips = [];
  // Section heatmap: 10 vertical bands, each gets a match %
  const SECTIONS = 10;
  const sectionDiffPixels = new Array(SECTIONS).fill(0);
  const sectionTotalPixels = new Array(SECTIONS).fill(0);

  for (let yStart = 0; yStart < H; yStart += CHUNK_H) {
    const yEnd = Math.min(yStart + CHUNK_H, H);
    const stripH = yEnd - yStart;

    const [liveRGBA, figmaRGBA] = await Promise.all([
      getStrip(livePng, yStart, yEnd, W),
      getStrip(figmaPng, yStart, yEnd, W),
    ]);

    const diffBuf = Buffer.alloc(W * stripH * 4);
    const numDiff = pixelmatch(liveRGBA, figmaRGBA, diffBuf, W, stripH, {
      threshold: 0.12,  // more sensitive than before
      includeAA: false,
      alpha: 0.1,
    });
    totalDiffPixels += numDiff;

    // Accumulate section heatmap
    for (let row = 0; row < stripH; row++) {
      const absY = yStart + row;
      const sectionIdx = Math.min(SECTIONS - 1, Math.floor((absY / H) * SECTIONS));
      for (let col = 0; col < W; col++) {
        const i = (row * W + col) * 4;
        sectionTotalPixels[sectionIdx]++;
        // pixelmatch marks diff pixels with non-zero alpha in the output
        if (diffBuf[i + 3] > 10 || (diffBuf[i] > 100 && diffBuf[i+1] < 50)) {
          sectionDiffPixels[sectionIdx]++;
        }
      }
    }

    // Collect clusters from this strip, offset y back to full-image coordinates
    const stripClusters = clusterDiffRegions(diffBuf, W, stripH);
    for (const c of stripClusters) {
      const absYPct = Math.round(((yStart + (c.y / 100) * stripH) / H) * 100);
      const absHPct = Math.max(1, Math.round((c.height / 100) * (stripH / H) * 100));
      allClusters.push({ ...c, y: absYPct, height: absHPct });
    }

    const diffPngStrip = new PNG({ width: W, height: stripH });
    diffBuf.copy(diffPngStrip.data);
    diffStrips.push({ y: yStart, strip: diffPngStrip });
  }

  const matchPct = Math.max(0, Math.min(100, Math.round((1 - totalDiffPixels / (W * H)) * 100)));

  // Per-section match scores (10 bands, top→bottom)
  const sectionScores = sectionTotalPixels.map((total, i) =>
    total === 0 ? 100 : Math.max(0, Math.min(100, Math.round((1 - sectionDiffPixels[i] / total) * 100)))
  );

  // Assemble output diff image (cap at 6000px height for payload)
  const outH = Math.min(H, 6000);
  const fullDiffPng = new PNG({ width: W, height: outH });
  for (const { y, strip } of diffStrips) {
    if (y >= outH) break;
    const copyH = Math.min(strip.height, outH - y);
    strip.data.copy(fullDiffPng.data, y * W * 4, 0, copyH * W * 4);
  }
  const diffBase64 = PNG.sync.write(fullDiffPng).toString('base64');

  // Merge adjacent clusters (prevent cluster explosion on totally different pages)
  const mergedClusters = mergeClusters(allClusters);

  return { matchPct, diffBase64, clusters: mergedClusters.slice(0, 50), W, H, sectionScores, layoutDivergence };
}

// Merge clusters that are vertically AND horizontally overlapping (within 2% proximity)
function mergeClusters(clusters) {
  if (clusters.length === 0) return [];
  const sorted = [...clusters].sort((a, b) => a.y - b.y);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    // Only merge if vertically close AND horizontally overlapping
    const vertClose = cur.y <= last.y + last.height + 2;
    const horizOverlap = cur.x < last.x + last.width + 5 && cur.x + cur.width > last.x - 5;
    if (vertClose && horizOverlap) {
      const newBottom = Math.max(last.y + last.height, cur.y + cur.height);
      last.x = Math.min(last.x, cur.x);
      last.width = Math.min(100, Math.max(last.x + last.width, cur.x + cur.width) - last.x);
      last.height = newBottom - last.y;
    } else {
      merged.push({ ...cur });
    }
  }
  // Cap any oversized cluster — split into smaller pieces if needed
  const capped = [];
  for (const c of merged) {
    if (c.width > 55 && c.height > 25) {
      // Split into 2 halves vertically
      const half = Math.floor(c.height / 2);
      capped.push({ x: c.x, y: c.y, width: c.width, height: half });
      capped.push({ x: c.x, y: c.y + half, width: c.width, height: c.height - half });
    } else {
      // Cap dimensions
      capped.push({ ...c, width: Math.min(55, c.width), height: Math.min(25, c.height) });
    }
  }
  return capped;
}

/* ─── Cluster diff pixels → bounding boxes ──────────────────────────────── */
function clusterDiffRegions(diffBuf, W, H) {
  const BLOCK = 60; // larger blocks = more isolated, tighter clusters
  const MAX_CLUSTER_BLOCKS = 80; // prevent one cluster from swallowing the page
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
    // Flood fill with size limit
    const queue = [[bx, by]], inCluster = [[bx, by]];
    visited[by * cols + bx] = 1;
    while (queue.length && inCluster.length < MAX_CLUSTER_BLOCKS) {
      const [cx, cy] = queue.shift();
      // 4-directional only (not 8-dir) — prevents diagonal cascade
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        if (visited[ny * cols + nx] || !blocks[ny * cols + nx]) continue;
        if (inCluster.length >= MAX_CLUSTER_BLOCKS) break;
        visited[ny * cols + nx] = 1; queue.push([nx, ny]); inCluster.push([nx, ny]);
      }
    }
    if (inCluster.length < 1) continue;
    const minBX = Math.min(...inCluster.map(c => c[0]));
    const maxBX = Math.max(...inCluster.map(c => c[0]));
    const minBY = Math.min(...inCluster.map(c => c[1]));
    const maxBY = Math.max(...inCluster.map(c => c[1]));
    clusters.push({
      x: Math.round(((minBX * BLOCK) / W) * 100),
      y: Math.round(((minBY * BLOCK) / H) * 100),
      width: Math.min(55, Math.round((((maxBX - minBX + 1) * BLOCK) / W) * 100)),
      height: Math.min(25, Math.max(1, Math.round((((maxBY - minBY + 1) * BLOCK) / H) * 100))),
    });
  }
  return clusters;
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

/* ─── Score + structural analysis ───────────────────────────────────────── */
function computeScores(matchPct, cssIssueCount, layoutDivergence = 0, sectionScores = []) {
  const cssPenalty = Math.min(30, cssIssueCount * 3);
  const matchScore = Math.max(0, Math.min(100, Math.round(matchPct - cssPenalty)));

  // Honest projected score: we can only fix CSS/style issues, not layout restructuring
  // If the pages are structurally divergent, projected improvement is bounded
  const structuralDivergence = layoutDivergence + (matchPct < 30 ? 40 : matchPct < 50 ? 20 : 0);
  const fixable = Math.min(cssPenalty + 10, 100 - matchScore); // realistic fixable margin
  const projectedScore = Math.min(100, Math.round(matchScore + fixable));

  // Classification
  let verdict, verdictDetail;
  if (matchScore >= 85) {
    verdict = 'excellent';
    verdictDetail = 'Minor polish needed — colours or spacing are slightly off.';
  } else if (matchScore >= 65) {
    verdict = 'good';
    verdictDetail = 'Several style mismatches detected. CSS fixes should bring this close to design.';
  } else if (matchScore >= 40) {
    verdict = 'partial';
    verdictDetail = 'Significant differences found. Some sections match; others need layout work.';
  } else if (matchScore >= 15) {
    verdict = 'divergent';
    verdictDetail = 'Pages are structurally very different. This likely requires a layout redesign, not just CSS fixes.';
  } else {
    verdict = 'unrelated';
    verdictDetail = 'These pages appear to be completely different designs. Pixel similarity is near 0%. A full redesign is needed.';
  }

  // Worst-performing section (for actionable callout)
  let worstSection = null;
  if (sectionScores.length > 0) {
    const minScore = Math.min(...sectionScores);
    const minIdx = sectionScores.indexOf(minScore);
    worstSection = { sectionIndex: minIdx, matchPct: minScore, label: sectionLabel(minIdx, sectionScores.length) };
  }

  return { matchScore, projectedScore, verdict, verdictDetail, worstSection };
}

function sectionLabel(idx, total) {
  const pct = Math.round((idx / total) * 100);
  if (pct < 10) return 'Top (Hero / Header)';
  if (pct < 25) return 'Upper section';
  if (pct < 45) return 'Mid-upper section';
  if (pct < 55) return 'Middle';
  if (pct < 70) return 'Mid-lower section';
  if (pct < 85) return 'Lower section';
  return 'Bottom (Footer)';
}

/* ─── Main handler ───────────────────────────────────────────────────────── */
const matchDesign = async (req, res) => {
  const { websiteUrl, figmaUrl } = req.body;
  if (!websiteUrl || !figmaUrl)
    return res.status(400).json({ success: false, message: 'Both website URL and Figma URL are required.' });

  // Resolve Figma token: user's own token takes priority over env
  const uid = req.user?.uid;
  let figmaToken = process.env.FIGMA_API_TOKEN;
  try {
    const profile = await UserProfile.findOne({ uid }).select('figma.accessToken');
    if (profile?.figma?.accessToken) figmaToken = profile.figma.accessToken;
  } catch { /* use env fallback */ }

  if (!figmaToken)
    return res.status(400).json({ success: false, message: 'No Figma token configured. Add yours in Settings.' });

  try {
    console.log('[MatchDesign] Step 1/4 — Screenshot:', websiteUrl);
    const [livePngBuf, liveStyles] = await Promise.all([
      freezeAndScreenshot(websiteUrl),
      extractLiveStyles(websiteUrl),
    ]);

    console.log('[MatchDesign] Step 2/4 — Fetching Figma:', figmaUrl);
    const { figmaBuf, figmaNodes } = await fetchFigmaData(figmaUrl, figmaToken);

    console.log('[MatchDesign] Step 3/4 — Pixel diff...');
    const { matchPct, diffBase64, clusters, W, H, sectionScores, layoutDivergence } = await runPixelDiff(livePngBuf, figmaBuf);

    console.log('[MatchDesign] Step 4/4 — CSS tokens...');
    const livePng = PNG.sync.read(livePngBuf);
    const cssIssues = compareStyles(liveStyles, figmaNodes, 1440, livePng.height || 5000);

    const allMismatches = buildMismatches(cssIssues, clusters, cssIssues.length + 1);
    allMismatches.forEach((m, i) => { m.issueNumber = i + 1; });

    const { matchScore, projectedScore, verdict, verdictDetail, worstSection } =
      computeScores(matchPct, cssIssues.length, layoutDivergence, sectionScores);

    console.log(`[MatchDesign] Done. Pixel: ${matchPct}%, Score: ${matchScore}% (${verdict}), Issues: ${allMismatches.length}`);

    // ── Persist scan to DB (async, don't block response) ──────────────────
    const websiteB64 = livePngBuf.toString('base64');
    const figmaB64   = figmaBuf.toString('base64');
    let savedScanId = null;
    try {
      const saved = await DesignScan.create({
        userId: uid,
        websiteUrl, figmaUrl,
        matchScore, projectedScore, pixelMatchPercent: matchPct,
        layoutDivergence, verdict, verdictDetail, sectionScores, worstSection,
        totalIssues: allMismatches.length, mismatches: allMismatches,
        websiteScreenshotBase64: websiteB64,
        figmaScreenshotBase64: figmaB64,
        diffImageBase64: diffBase64,
        status: 'complete',
      });
      savedScanId = saved._id;
    } catch (dbErr) {
      console.error('[MatchDesign] DB save failed (non-fatal):', dbErr.message);
    }

    return res.status(200).json({
      success: true,
      scanId: savedScanId,
      mismatches: allMismatches,
      totalIssues: allMismatches.length,
      matchScore, projectedScore, verdict, verdictDetail,
      pixelMatchPercent: matchPct, layoutDivergence, sectionScores, worstSection,
      websiteUrl, figmaUrl,
      websiteScreenshotBase64: websiteB64,
      figmaScreenshotBase64: figmaB64,
      diffImageBase64: diffBase64,
    });

  } catch (error) {
    console.error('[MatchDesign] Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Comparison failed.' });
  }
};

/* ─── GET /api/match-design/history ─────────────────────────────────────── */
const getDesignHistory = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const scans = await DesignScan.find({ userId: uid })
      .sort({ createdAt: -1 })
      .limit(30)
      .select('-websiteScreenshotBase64 -figmaScreenshotBase64 -diffImageBase64 -mismatches');
    return res.json({ success: true, scans });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ─── GET /api/match-design/:scanId ──────────────────────────────────────── */
const getDesignScan = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const scan = await DesignScan.findOne({ _id: req.params.scanId, userId: uid });
    if (!scan) return res.status(404).json({ success: false, message: 'Scan not found.' });
    return res.json({ success: true, scan });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ─── DELETE /api/match-design/:scanId ───────────────────────────────────── */
const deleteDesignScan = async (req, res) => {
  try {
    const uid = req.user?.uid;
    await DesignScan.deleteOne({ _id: req.params.scanId, userId: uid });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
   generateDesignFix
   POST /api/match-design/fix
   Body: { mismatches, websiteUrl, repoFullName, githubToken }
   Maps design mismatches to source files and generates CSS/style fix diffs
──────────────────────────────────────────────────────────────────────────────*/
const { GoogleGenerativeAI } = require('@google/generative-ai');
const FixSession = require('../models/FixSession');
const { getUserOctokit } = require('./githubController');

/* ─── Framework detection ─────────────────────────────────────────────────── */
function detectFrameworkFromTree(tree, pkgJson) {
  const paths = tree.map(f => f.path.toLowerCase());
  const deps = { ...(pkgJson?.dependencies || {}), ...(pkgJson?.devDependencies || {}) };
  const hasTailwind = !!deps.tailwindcss || paths.some(p => p.includes('tailwind.config'));
  const hasBootstrap = !!deps.bootstrap;
  const hasStyled = !!deps['styled-components'] || !!deps['@emotion/styled'];
  if (paths.some(p => p.includes('next.config'))) return hasTailwind ? 'nextjs-tailwind' : hasStyled ? 'nextjs-styled' : 'nextjs-css';
  if (paths.some(p => p.endsWith('.vue'))) return 'vue';
  if (paths.some(p => p.endsWith('.svelte'))) return 'svelte';
  if (hasTailwind) return 'react-tailwind';
  if (hasBootstrap) return 'react-bootstrap';
  return 'css';
}

/* ─── File selection — scoring approach (mirrors fixController.selectFilesToFetch) ── */
function selectFilesForDesignFix(tree, framework) {
  const SKIP = /(node_modules|\.git|\.next|dist|build|out|__pycache__|\.cache)\//i;
  const SOURCE_EXT = /\.(jsx?|tsx?|html?|vue|svelte|css|scss|sass|less)$/i;
  const blobs = tree
    .filter(f => f.type === 'blob' && SOURCE_EXT.test(f.path) && !SKIP.test(f.path))
    .map(f => ({ path: f.path, size: f.size }));

  const scored = blobs.map(f => {
    let score = 0;
    const p = f.path.toLowerCase();

    // Component / page files — highest relevance
    if (p.includes('component')) score += 20;
    if (p.includes('page'))      score += 18;
    if (p.includes('layout'))    score += 18;
    if (p.includes('header') || p.includes('nav') || p.includes('footer')) score += 15;
    if (p.includes('hero') || p.includes('banner') || p.includes('section')) score += 12;
    if (p.includes('card') || p.includes('button') || p.includes('sidebar')) score += 10;
    if (p.includes('form') || p.includes('input') || p.includes('modal'))  score += 8;
    if (p.includes('home') || p.includes('landing') || p.includes('main')) score += 15;
    if (p.includes('app'))       score += 10;
    if (p.includes('index'))     score += 8;

    // Style files — always relevant for design fixes
    if (p.endsWith('.css') || p.endsWith('.scss') || p.endsWith('.sass') || p.endsWith('.less')) score += 20;
    if (p.includes('global') || p.includes('style') || p.includes('theme')) score += 18;
    if (p.includes('variable') || p.includes('_var'))  score += 12;
    if (p.includes('tailwind.config'))                 score += 25;
    if (p.includes('module.css') || p.includes('module.scss')) score += 15;

    // Extension bonuses
    if (p.endsWith('.tsx') || p.endsWith('.jsx')) score += 10;
    if (p.endsWith('.vue') || p.endsWith('.svelte')) score += 10;

    // Penalize test/story files
    if (p.includes('.test.') || p.includes('.spec.') || p.includes('.stories.')) score -= 40;
    if (p.includes('__test') || p.includes('__mock')) score -= 40;

    // Prefer smaller files (faster to process, fit in token window)
    if (f.size && f.size < 15000) score += 5;
    if (f.size && f.size > 80000) score -= 10;

    return { ...f, score };
  });

  return scored
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40) // match fixController's limit
    .map(f => f.path);
}

/* ─── Diff generator ─────────────────────────────────────────────────────── */
function generateDesignDiff(original, fixed, filePath) {
  if (original === fixed) return '';
  const origLines = original.split('\n'), fixedLines = fixed.split('\n');
  const diff = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let i = 0, j = 0;
  while (i < origLines.length || j < fixedLines.length) {
    if (origLines[i] === fixedLines[j]) { diff.push(` ${origLines[i]}`); i++; j++; }
    else {
      if (i < origLines.length) diff.push(`-${origLines[i++]}`);
      if (j < fixedLines.length) diff.push(`+${fixedLines[j++]}`);
    }
  }
  return diff.join('\n');
}

/* ─── Fuzzy replace (from fixController) ─────────────────────────────────── */
function fuzzyReplace(fileContent, originalCode, fixedCode) {
  if (fileContent.includes(originalCode)) return fileContent.replace(originalCode, fixedCode);
  const origLines = originalCode.split('\n').map(l => l.trim()).filter(l => l);
  if (!origLines.length) return fileContent;
  const lines = fileContent.split('\n');
  for (let i = 0; i <= lines.length - origLines.length; i++) {
    const slice = lines.slice(i, i + origLines.length).map(l => l.trim()).filter(l => l);
    if (slice.join('\n') === origLines.join('\n')) {
      const indent = lines[i].match(/^(\s*)/)[1];
      const fixedLines = fixedCode.split('\n').map((l, idx) => idx === 0 ? l : indent + l.trim());
      return [...lines.slice(0, i), ...fixedLines, ...lines.slice(i + origLines.length)].join('\n');
    }
  }
  return fileContent;
}

const MAX_FULL_FILE = 40000; // chars — match sourceMapper limit

const FRAMEWORK_HINTS = {
  'nextjs-tailwind':  'Next.js + Tailwind CSS. Fix via tailwind.config.js theme values, globals.css, or updating className strings in .tsx/.jsx files.',
  'react-tailwind':   'React + Tailwind CSS. Fix via tailwind.config.js theme values or className strings in JSX.',
  'nextjs-styled':    'Next.js + styled-components/emotion. Fix the styled component definitions.',
  'nextjs-css':       'Next.js + CSS Modules. Fix .module.css files and globals.css.',
  'vue':              'Vue.js project. Fix <style> sections of .vue SFCs or separate CSS files.',
  'svelte':           'Svelte project. Fix <style> sections of .svelte files.',
  'react-bootstrap':  'React + Bootstrap. Fix SCSS variable overrides (_variables.scss).',
  'css':              'Plain CSS/SCSS project. Fix CSS/SCSS files directly.',
};

/* ─── Per-mismatch: find best candidate file ─────────────────────────────── */
function findBestFileForMismatch(mismatch, repoFiles) {
  const loc = (mismatch.location || '').toLowerCase();
  const cat = (mismatch.category || '').toLowerCase();
  const desc = (mismatch.description || '').toLowerCase();
  const figVal = (mismatch.figmaValue || '').toLowerCase();

  const candidates = repoFiles.map(f => {
    const p = f.filePath.toLowerCase();
    const c = f.content.toLowerCase();
    let score = 0;

    // Category-based: style issues → CSS/SCSS, content → JSX/HTML
    if (['colors', 'typography', 'spacing', 'borders', 'shadows'].includes(cat)) {
      if (p.endsWith('.css') || p.endsWith('.scss') || p.includes('global') || p.includes('style')) score += 15;
      if (p.includes('tailwind.config')) score += 10;
    }
    if (cat === 'content') {
      if (p.endsWith('.tsx') || p.endsWith('.jsx') || p.endsWith('.html') || p.endsWith('.vue')) score += 15;
    }

    // Location-based matching (e.g., "Header", "Hero", "Footer")
    const locWords = loc.replace(/[^a-zA-Z]/g, ' ').split(' ').filter(w => w.length > 2);
    for (const w of locWords) {
      if (p.includes(w)) score += 20;
      if (c.includes(w)) score += 5;
    }

    // If figmaValue contains a color hex, check if the file has it or similar
    if (figVal && figVal.startsWith('#')) {
      if (c.includes(figVal)) score += 10;
    }

    // Content text match for content issues
    if (cat === 'content' && mismatch.liveValue) {
      const live = mismatch.liveValue.replace(/^"|"$/g, '').slice(0, 40);
      if (live.length > 5 && c.includes(live.toLowerCase())) score += 25;
    }

    return { filePath: f.filePath, score };
  });

  return candidates.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

/* ─── Per-mismatch Gemini fix call ───────────────────────────────────────── */
async function geminiFixDesignMismatch(mismatch, fileData, framework, websiteUrl, model) {
  const { filePath, content } = fileData;
  const isLarge = content.length > MAX_FULL_FILE;
  const frameworkHint = FRAMEWORK_HINTS[framework] || 'Fix the relevant files.';

  const mismatchDesc = `Category: ${mismatch.category}
Severity: ${mismatch.severity}
Description: ${mismatch.description}
Location: ${mismatch.location || 'N/A'}
Figma value: ${mismatch.figmaValue || 'N/A'}
Live site value: ${mismatch.liveValue || 'N/A'}`;

  let prompt;
  if (!isLarge) {
    prompt = `You are a senior frontend engineer fixing a design mismatch.

Framework: ${frameworkHint}
Live site: ${websiteUrl}

DESIGN MISMATCH:
${mismatchDesc}

SOURCE FILE: ${filePath}
\`\`\`
${content}
\`\`\`

TASK:
1. Fix this specific design mismatch in the file above.
2. For style issues: fix colors, fonts, spacing, border-radius, shadows, sizing.
3. For Tailwind: update className strings or tailwind.config theme values.
4. For Content mismatches: update hard-coded static text to match Figma. Only change truly static text.
5. Make ONLY the minimal changes needed. Do NOT refactor or change anything else.
6. Return the COMPLETE file with your fix applied.

Respond ONLY with this JSON (no markdown, no text outside JSON):
{
  "bestFile": "${filePath}",
  "confidence": 0-100,
  "fullFixedContent": "COMPLETE FIXED FILE CONTENT — all lines",
  "changeDescription": "one-line summary of what changed"
}`;
  } else {
    // Snippet approach for large files
    const lines = content.split('\n');
    const searchTerms = (mismatch.location || '').replace(/[^a-zA-Z]/g, ' ').split(' ').filter(w => w.length > 3);
    let focusLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (searchTerms.some(t => lines[i].toLowerCase().includes(t.toLowerCase()))) { focusLine = i; break; }
    }
    const start = Math.max(0, focusLine - 80);
    const end = Math.min(lines.length, focusLine + 120);
    const snippet = lines.slice(start, end).join('\n');

    prompt = `You are a senior frontend engineer fixing a design mismatch.

Framework: ${frameworkHint}

DESIGN MISMATCH:
${mismatchDesc}

FILE: ${filePath} (large file — showing lines ${start + 1}–${end} of ${lines.length})
\`\`\`
${snippet}
\`\`\`

Fix this mismatch. Return ONLY this JSON:
{
  "bestFile": "${filePath}",
  "confidence": 0-100,
  "originalCode": "exact lines to replace (copy verbatim)",
  "fixedCode": "the replacement lines",
  "changeDescription": "one-line summary"
}`;
  }

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn(`[DesignFix] Gemini call failed for ${filePath}:`, err.message);
    return null;
  }
}

/* ─── Main handler ───────────────────────────────────────────────────────── */
const generateDesignFix = async (req, res) => {
  const { mismatches, websiteUrl, repoFullName } = req.body;
  if (!mismatches?.length || !repoFullName)
    return res.status(400).json({ success: false, message: 'mismatches and repoFullName are required.' });

  try {
    const uid = req.user?.uid;
    const octokit = await getUserOctokit(uid);
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const [owner, repo] = repoFullName.split('/');

    // ── Step 1: Get repo tree + detect framework ────────────────────────────
    const { data: repoMeta } = await octokit.rest.repos.get({ owner, repo });
    const branch = repoMeta.default_branch;
    const { data: treeData } = await octokit.rest.git.getTree({ owner, repo, tree_sha: branch, recursive: 'true' });

    let pkgJson = null;
    try {
      const { data: pkg } = await octokit.rest.repos.getContent({ owner, repo, path: 'package.json' });
      pkgJson = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf-8'));
    } catch { /* optional */ }

    const framework = detectFrameworkFromTree(treeData.tree, pkgJson);
    console.log(`[DesignFix] Framework: ${framework}, Repo: ${repoFullName}`);

    // ── Step 2: Select and fetch files (scoring approach, up to 40) ─────────
    const filePaths = selectFilesForDesignFix(treeData.tree, framework);
    if (!filePaths.length) return res.status(400).json({ success: false, message: 'No relevant source files found.' });
    console.log(`[DesignFix] Selected ${filePaths.length} files to fetch`);

    const fetched = await Promise.allSettled(filePaths.map(async path => {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
      return { filePath: path, content: Buffer.from(data.content, 'base64').toString('utf-8') };
    }));
    const repoFiles = fetched.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!repoFiles.length) return res.status(400).json({ success: false, message: 'Could not fetch any source files.' });
    console.log(`[DesignFix] Fetched ${repoFiles.length} files`);

    // ── Step 3: Per-mismatch processing (batches of 3, like sourceMapper) ───
    const fileFixMap = new Map(); // filePath → { content, fixedContent, changes[] }
    const CONCURRENCY = 3;
    const toProcess = mismatches.slice(0, 20); // cap at 20 mismatches

    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const batch = toProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (mismatch) => {
        // Find best candidate file(s)
        const candidates = findBestFileForMismatch(mismatch, repoFiles);
        if (!candidates.length) {
          // Fallback: send file listing to Gemini to pick
          console.log(`[DesignFix] No candidate for "${mismatch.category}: ${mismatch.description?.slice(0, 40)}" — trying all files`);
          // Pick first style file or first component file
          const fallback = repoFiles.find(f =>
            /\.(css|scss)$/i.test(f.filePath) || /global/i.test(f.filePath)
          ) || repoFiles[0];
          if (!fallback) return null;
          return geminiFixDesignMismatch(mismatch, fallback, framework, websiteUrl, model);
        }

        const bestPath = candidates[0].filePath;
        const fileData = repoFiles.find(f => f.filePath === bestPath);
        if (!fileData) return null;
        return geminiFixDesignMismatch(mismatch, fileData, framework, websiteUrl, model);
      }));

      // Accumulate results into fileFixMap
      for (let j = 0; j < results.length; j++) {
        const gemResult = results[j];
        if (!gemResult || !gemResult.bestFile) continue;

        const filePath = gemResult.bestFile;
        const repoFile = repoFiles.find(f => f.filePath === filePath);
        if (!repoFile) continue;

        if (!fileFixMap.has(filePath)) {
          fileFixMap.set(filePath, {
            filePath,
            content: repoFile.content,
            fixedContent: repoFile.content,
            confidence: gemResult.confidence || 70,
            changes: [],
          });
        }
        const entry = fileFixMap.get(filePath);

        // Full-file replacement (preferred, for small files)
        if (gemResult.fullFixedContent && gemResult.fullFixedContent.trim().length > 50) {
          entry.fixedContent = gemResult.fullFixedContent;
          entry.changes.push({
            original: '[design fix applied]',
            fixed: '[design fix applied]',
            reason: gemResult.changeDescription || batch[j]?.description || 'Design mismatch fix',
          });
          entry.confidence = Math.max(entry.confidence, gemResult.confidence || 70);
          console.log(`[DesignFix] Full-file fix for ${filePath}`);
        }
        // Snippet replacement (for large files)
        else if (gemResult.originalCode && gemResult.fixedCode) {
          const before = entry.fixedContent;
          entry.fixedContent = fuzzyReplace(entry.fixedContent, gemResult.originalCode, gemResult.fixedCode);
          if (entry.fixedContent !== before) {
            console.log(`[DesignFix] Snippet fix for ${filePath}`);
          }
          entry.changes.push({
            original: gemResult.originalCode,
            fixed: gemResult.fixedCode,
            reason: gemResult.changeDescription || 'Design mismatch fix',
          });
        }
      }
    }

    // ── Step 4: Build final mapped files with diffs ─────────────────────────
    const mappedFiles = [...fileFixMap.values()]
      .filter(f => f.fixedContent !== f.content)
      .map(f => ({
        filePath: f.filePath,
        confidence: f.confidence,
        changes: f.changes,
        originalContent: f.content,
        fixedContent: f.fixedContent,
        diff: generateDesignDiff(f.content, f.fixedContent, f.filePath),
      }));

    if (!mappedFiles.length)
      return res.status(422).json({ success: false, message: 'AI found no actionable changes in the repository files.' });

    // ── Step 5: Persist session ─────────────────────────────────────────────
    const session = await FixSession.create({
      userId: uid, scanId: null, repoFullName, fixType: 'design',
      websiteUrl, framework, mappedFiles, unmappedErrors: [],
      status: 'review',
      totalFilesChanged: mappedFiles.length,
      totalFixesApplied: mappedFiles.reduce((s, f) => s + (f.changes?.length || 0), 0),
    });
    console.log(`[DesignFix] Done. Framework=${framework}, Files=${mappedFiles.length}, Fixes=${mappedFiles.reduce((s, f) => s + f.changes.length, 0)}`);

    return res.json({
      success: true,
      sessionId: session._id,
      framework,
      mappedFiles: mappedFiles.map(f => ({
        filePath: f.filePath, confidence: f.confidence, changes: f.changes,
        diff: f.diff, originalContent: f.originalContent, fixedContent: f.fixedContent,
      })),
      unmappedErrors: [],
      totalMismatches: mismatches.length,
      fixedMismatches: mappedFiles.reduce((s, f) => s + (f.changes?.length || 0), 0),
      filesChanged: mappedFiles.length,
    });

  } catch (err) {
    console.error('[DesignFix] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { matchDesign, generateDesignFix, getDesignHistory, getDesignScan, deleteDesignScan };

