'use strict';
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const sharp = require('sharp');
const DesignScan = require('../models/designScan');
const UserProfile = require('../models/userProfile');
const { ingestFigma, ingestLiveSite } = require('../services/hybridIngestion');
const { runSpatialComparison, bboxToPercentWithDimensions } = require('../services/spatialMatcher');

/* ─── Sharp-based image normalizer ─────────────────────────────────────────── */
async function normalizeToSameSize(buf1, buf2) {
  // Get dimensions of both images
  const [meta1, meta2] = await Promise.all([sharp(buf1).metadata(), sharp(buf2).metadata()]);
  console.log(`[PixelDiff] Live: ${meta1.width}×${meta1.height}, Figma: ${meta2.width}×${meta2.height}`);

  // Use Figma dimensions as reference (it's the design source of truth)
  const targetW = meta2.width;
  const targetH = meta2.height;

  // Resize live screenshot to match Figma exactly
  // Use 'cover' fit so it fills the target dimensions without distortion
  const [normalized1, normalized2] = await Promise.all([
    sharp(buf1)
      .resize(targetW, targetH, { fit: 'cover', position: 'top' })
      .png()
      .toBuffer(),
    buf2, // Figma is already at target size
  ]);
  return { buf1: normalized1, buf2: normalized2, width: targetW, height: targetH };
}

/* ─── Pixel diff (sharp-normalized) ────────────────────────────────────────── */
async function runPixelDiff(liveBuf, figmaBuf) {
  try {
    // Step 1: Normalize both images to identical dimensions using sharp
    const { buf1: normalizedLive, buf2: normalizedFigma, width: W, height: H } =
      await normalizeToSameSize(liveBuf, figmaBuf);

    // Step 2: Parse normalized PNGs
    const parsePng = buf => new Promise((res, rej) => {
      const p = new PNG(); p.parse(buf, (e, d) => e ? rej(e) : res(d));
    });
    const [livePng, figmaPng] = await Promise.all([parsePng(normalizedLive), parsePng(normalizedFigma)]);

    // Step 3: Run pixelmatch on same-size images
    // threshold: 0.20 — more tolerant of anti-aliasing and sub-pixel rendering
    const diffData = Buffer.alloc(W * H * 4);
    const numDiff = pixelmatch(livePng.data, figmaPng.data, diffData, W, H, {
      threshold: 0.20, includeAA: false, alpha: 0.1,
    });

    const matchPct = Math.max(0, Math.min(100, Math.round((1 - numDiff / (W * H)) * 100)));

    const diffPng = new PNG({ width: W, height: H });
    diffData.copy(diffPng.data);
    const diffBase64 = PNG.sync.write(diffPng).toString('base64');

    return { matchPct, diffBase64, W, H };
  } catch (e) {
    console.warn('[PixelDiff] Failed:', e.message);
    return null;
  }
}

/* â”€â”€â”€ Score computation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function computeScores(pixelPct, spatialScore, driftCount, critCount, majCount) {
  // Blend pixel match and spatial match
  const blended = Math.round(pixelPct * 0.4 + spatialScore * 0.6);
  const matchScore = Math.max(0, Math.min(100, blended));

  // Projected: how much we can fix via CSS
  const fixablePenalty = Math.min(30, critCount * 6 + majCount * 3);
  const projectedScore = Math.min(100, matchScore + fixablePenalty + 5);

  let verdict, verdictDetail;
  if (matchScore >= 85) {
    verdict = 'excellent';
    verdictDetail = 'Minor polish needed â€” colours or spacing are slightly off.';
  } else if (matchScore >= 65) {
    verdict = 'good';
    verdictDetail = 'Several style mismatches detected. CSS fixes should bring this close to design.';
  } else if (matchScore >= 40) {
    verdict = 'partial';
    verdictDetail = 'Significant differences found. Some sections match; others need layout work.';
  } else if (matchScore >= 15) {
    verdict = 'divergent';
    verdictDetail = 'Pages are structurally very different. Layout redesign likely needed.';
  } else {
    verdict = 'unrelated';
    verdictDetail = 'These pages appear completely different. A full redesign is needed.';
  }

  return { matchScore, projectedScore, verdict, verdictDetail };
}

/* â”€â”€â”€ VLM fallback for complex elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
async function vlmFallbackCheck(liveBuf, figmaBuf, complexDrifts) {
  // Only run for elements where spatial matching was weak
  if (complexDrifts.length === 0) return [];
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const result = await model.generateContent([
      {
        inlineData: { mimeType: 'image/png', data: liveBuf.toString('base64') }
      },
      {
        inlineData: { mimeType: 'image/png', data: figmaBuf.toString('base64') }
      },
      `Compare these two UI screenshots. The first is the live website, the second is the Figma design.
Identify up to 5 major visual differences that automated comparison might miss (complex SVGs, icons, images, gradients).
Return ONLY valid JSON array:
[{"title":"...","description":"...","severity":"critical|major|minor","category":"visual","boundingBox":{"x":0,"y":0,"width":100,"height":10}}]
boundingBox values are percentages of the image. Be concise.`
    ]);

    const text = result.response.text().trim().replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '');
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const items = JSON.parse(match[0]);
      return items.slice(0, 5).map((item, i) => ({
        ...item,
        issueNumber: 900 + i,
        property: 'visual',
        expected: 'See Figma design',
        actual: 'See live site',
        delta: 0,
        matchConfidence: 0,
        figmaName: 'VLM detected',
        domSelector: '',
      }));
    }
  } catch (e) {
    console.log('[MatchDesign] VLM fallback skipped:', e.message);
  }
  return [];
}

/* â”€â”€â”€ Main handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const matchDesign = async (req, res) => {
  const { websiteUrl, figmaUrl } = req.body;
  if (!websiteUrl || !figmaUrl)
    return res.status(400).json({ success: false, message: 'Both website URL and Figma URL are required.' });

  const uid = req.user?.uid;
  let figmaToken = process.env.FIGMA_API_TOKEN;
  try {
    const profile = await UserProfile.findOne({ uid }).select('figma.accessToken');
    if (profile?.figma?.accessToken) figmaToken = profile.figma.accessToken;
  } catch { /* use env fallback */ }

  if (!figmaToken)
    return res.status(400).json({ success: false, message: 'No Figma token configured.' });

  try {
    // â”€â”€ Phase 1: Ingestion & Viewport Synchronization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('[MatchDesign] Phase 1 â€” Ingesting Figma:', figmaUrl);
    const { figmaBuf, nodeDoc, frameWidth, frameHeight } = await ingestFigma(figmaUrl, figmaToken);

    console.log(`[MatchDesign] Phase 1 â€” Ingesting live site at ${frameWidth}Ã—${frameHeight}:`, websiteUrl);
    const { screenshotBuf, domElements } = await ingestLiveSite(websiteUrl, frameWidth, frameHeight);

    // â”€â”€ Phase 2+3+4: Spatial Comparison â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('[MatchDesign] Phases 2-4 â€” Spatial comparison...');
    const { drifts, stats, overallScore } = runSpatialComparison(
      nodeDoc, domElements, frameWidth, frameHeight
    );

    // â”€â”€ Pixel diff (backup layer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    console.log('[MatchDesign] Running pixel diff backup...');
    const pixelResult = await runPixelDiff(screenshotBuf, figmaBuf);
    const pixelPct = pixelResult?.matchPct ?? 50;
    const diffBase64 = pixelResult?.diffBase64 ?? '';

    // â”€â”€ VLM fallback for complex visual elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const vlmDrifts = await vlmFallbackCheck(screenshotBuf, figmaBuf,
      drifts.filter(d => d.category === 'missing'));

    // â”€â”€ Phase 5: Build final output â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const allDrifts = [...drifts, ...vlmDrifts];
    // Re-number
    allDrifts.forEach((d, i) => { d.issueNumber = i + 1; });

    // Build backward-compatible mismatches array
    const mismatches = allDrifts.map(d => ({
      issueNumber: d.issueNumber,
      category: (d.category || 'Layout').charAt(0).toUpperCase() + (d.category || 'layout').slice(1),
      severity: d.severity || 'minor',
      title: d.title,
      description: d.description,
      location: d.figmaName || d.domSelector || 'Unknown',
      figmaValue: d.expected || 'N/A',
      liveValue: d.actual || 'N/A',
      boundingBox: d.boundingBox,
      property: d.property,
      delta: d.delta,
      matchConfidence: d.matchConfidence,
    }));

    const critCount = mismatches.filter(m => m.severity === 'critical').length;
    const majCount = mismatches.filter(m => m.severity === 'major').length;

    const { matchScore, projectedScore, verdict, verdictDetail } =
      computeScores(pixelPct, overallScore, mismatches.length, critCount, majCount);

    // Section scores from spatial stats
    const sectionScores = buildSectionScores(drifts, frameHeight);
    const worstSection = findWorstSection(sectionScores);
    const layoutDivergence = Math.round(Math.abs(stats.missingElements / Math.max(1, stats.figmaElementCount)) * 100);

    console.log(`[MatchDesign] Done. Score: ${matchScore}% (${verdict}), Drifts: ${mismatches.length}, Pixel: ${pixelPct}%`);
    console.log(`[MatchDesign] Stats: ${stats.matchedPairs} matched, ${stats.missingElements} missing, ${stats.extraElements} extra`);

    // â”€â”€ Persist to DB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const websiteB64 = screenshotBuf.toString('base64');
    const figmaB64 = figmaBuf.toString('base64');
    let savedScanId = null;
    try {
      const saved = await DesignScan.create({
        userId: uid, websiteUrl, figmaUrl,
        matchScore, projectedScore, pixelMatchPercent: pixelPct,
        layoutDivergence, verdict, verdictDetail, sectionScores, worstSection,
        totalIssues: mismatches.length, mismatches,
        websiteScreenshotBase64: websiteB64,
        figmaScreenshotBase64: figmaB64,
        diffImageBase64: diffBase64,
        status: 'complete',
      });
      savedScanId = saved._id;
    } catch (dbErr) {
      console.error('[MatchDesign] DB save failed:', dbErr.message);
    }

    return res.status(200).json({
      success: true, scanId: savedScanId,
      mismatches, totalIssues: mismatches.length,
      matchScore, projectedScore, verdict, verdictDetail,
      pixelMatchPercent: pixelPct, layoutDivergence, sectionScores, worstSection,
      websiteUrl, figmaUrl,
      websiteScreenshotBase64: websiteB64,
      figmaScreenshotBase64: figmaB64,
      diffImageBase64: diffBase64,
      spatialStats: stats,
    });

  } catch (error) {
    console.error('[MatchDesign] Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Comparison failed.' });
  }
};

/* ──── Section scores (10 vertical bands) ───────────────────────────────────────── */
function buildSectionScores(drifts, pageHeight) {
  const SECTIONS = 10;
  const sectionDrifts = new Array(SECTIONS).fill(0);
  for (const d of drifts) {
    if (!d.boundingBox) continue;
    const midY = d.boundingBox.y + d.boundingBox.height / 2;
    const idx = Math.min(SECTIONS - 1, Math.floor((midY / 100) * SECTIONS));
    const weight = d.severity === 'critical' ? 3 : d.severity === 'major' ? 2 : 1;
    sectionDrifts[idx] += weight;
  }
  const maxDrift = Math.max(1, ...sectionDrifts);
  return sectionDrifts.map(d => Math.max(0, Math.min(100, Math.round(100 - (d / maxDrift) * 80))));
}

function findWorstSection(scores) {
  if (!scores.length) return null;
  const minScore = Math.min(...scores);
  const idx = scores.indexOf(minScore);
  const labels = ['Top (Hero/Header)', 'Upper section', '', 'Mid-upper', '', 'Middle', '', 'Mid-lower', 'Lower section', 'Bottom (Footer)'];
  return { sectionIndex: idx, matchPct: minScore, label: labels[idx] || `Section ${idx + 1}` };
}

/* â”€â”€â”€ CRUD endpoints (unchanged) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const getDesignHistory = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const scans = await DesignScan.find({ userId: uid })
      .sort({ createdAt: -1 }).limit(30)
      .select('-websiteScreenshotBase64 -figmaScreenshotBase64 -diffImageBase64 -mismatches');
    return res.json({ success: true, scans });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

const getDesignScan = async (req, res) => {
  try {
    const uid = req.user?.uid;
    const scan = await DesignScan.findOne({ _id: req.params.scanId, userId: uid });
    if (!scan) return res.status(404).json({ success: false, message: 'Scan not found.' });
    return res.json({ success: true, scan });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

const deleteDesignScan = async (req, res) => {
  try {
    const uid = req.user?.uid;
    await DesignScan.deleteOne({ _id: req.params.scanId, userId: uid });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

/* ─── Fix Generation ─────────────────────────────────────────────────────── */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const FixSession = require('../models/fixSession');
const { getUserOctokit } = require('./githubController');

/* â”€â”€â”€ Framework detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€â”€ File selection â€” scoring approach (mirrors fixController.selectFilesToFetch) â”€â”€ */
function selectFilesForDesignFix(tree, framework) {
  const SKIP = /(node_modules|\.git|\.next|dist|build|out|__pycache__|\.cache)\//i;
  const SOURCE_EXT = /\.(jsx?|tsx?|html?|vue|svelte|css|scss|sass|less)$/i;
  const blobs = tree
    .filter(f => f.type === 'blob' && SOURCE_EXT.test(f.path) && !SKIP.test(f.path))
    .map(f => ({ path: f.path, size: f.size }));

  const scored = blobs.map(f => {
    let score = 0;
    const p = f.path.toLowerCase();

    // Component / page files â€” highest relevance
    if (p.includes('component')) score += 20;
    if (p.includes('page')) score += 18;
    if (p.includes('layout')) score += 18;
    if (p.includes('header') || p.includes('nav') || p.includes('footer')) score += 15;
    if (p.includes('hero') || p.includes('banner') || p.includes('section')) score += 12;
    if (p.includes('card') || p.includes('button') || p.includes('sidebar')) score += 10;
    if (p.includes('form') || p.includes('input') || p.includes('modal')) score += 8;
    if (p.includes('home') || p.includes('landing') || p.includes('main')) score += 15;
    if (p.includes('app')) score += 10;
    if (p.includes('index')) score += 8;

    // Style files â€” always relevant for design fixes
    if (p.endsWith('.css') || p.endsWith('.scss') || p.endsWith('.sass') || p.endsWith('.less')) score += 20;
    if (p.includes('global') || p.includes('style') || p.includes('theme')) score += 18;
    if (p.includes('variable') || p.includes('_var')) score += 12;
    if (p.includes('tailwind.config')) score += 25;
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

/* â”€â”€â”€ Diff generator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€â”€ Fuzzy replace (from fixController) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

const MAX_FULL_FILE = 40000; // chars â€” match sourceMapper limit

const FRAMEWORK_HINTS = {
  'nextjs-tailwind': 'Next.js + Tailwind CSS. Fix via tailwind.config.js theme values, globals.css, or updating className strings in .tsx/.jsx files.',
  'react-tailwind': 'React + Tailwind CSS. Fix via tailwind.config.js theme values or className strings in JSX.',
  'nextjs-styled': 'Next.js + styled-components/emotion. Fix the styled component definitions.',
  'nextjs-css': 'Next.js + CSS Modules. Fix .module.css files and globals.css.',
  'vue': 'Vue.js project. Fix <style> sections of .vue SFCs or separate CSS files.',
  'svelte': 'Svelte project. Fix <style> sections of .svelte files.',
  'react-bootstrap': 'React + Bootstrap. Fix SCSS variable overrides (_variables.scss).',
  'css': 'Plain CSS/SCSS project. Fix CSS/SCSS files directly.',
};

/* â”€â”€â”€ Per-mismatch: find best candidate file â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function findBestFileForMismatch(mismatch, repoFiles) {
  const loc = (mismatch.location || '').toLowerCase();
  const cat = (mismatch.category || '').toLowerCase();
  const desc = (mismatch.description || '').toLowerCase();
  const figVal = (mismatch.figmaValue || '').toLowerCase();

  const candidates = repoFiles.map(f => {
    const p = f.filePath.toLowerCase();
    const c = f.content.toLowerCase();
    let score = 0;

    // Category-based: style issues â†’ CSS/SCSS, content â†’ JSX/HTML
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

/* â”€â”€â”€ Per-mismatch Gemini fix call â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
  "fullFixedContent": "COMPLETE FIXED FILE CONTENT â€” all lines",
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

FILE: ${filePath} (large file â€” showing lines ${start + 1}â€“${end} of ${lines.length})
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

/* â”€â”€â”€ Main handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

    // â”€â”€ Step 1: Get repo tree + detect framework â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Step 2: Select and fetch files (scoring approach, up to 40) â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Step 3: Per-mismatch processing (batches of 3, like sourceMapper) â”€â”€â”€
    const fileFixMap = new Map(); // filePath â†’ { content, fixedContent, changes[] }
    const CONCURRENCY = 3;
    const toProcess = mismatches.slice(0, 20); // cap at 20 mismatches

    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const batch = toProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (mismatch) => {
        // Find best candidate file(s)
        const candidates = findBestFileForMismatch(mismatch, repoFiles);
        if (!candidates.length) {
          // Fallback: send file listing to Gemini to pick
          console.log(`[DesignFix] No candidate for "${mismatch.category}: ${mismatch.description?.slice(0, 40)}" â€” trying all files`);
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

    // â”€â”€ Step 4: Build final mapped files with diffs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Step 5: Persist session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

