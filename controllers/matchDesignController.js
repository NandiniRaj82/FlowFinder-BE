'use strict';
const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');
const axios     = require('axios');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractFigmaFileKey(url) {
  const m = url.match(/figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9]+)/);
  if (!m) throw new Error('Invalid Figma URL. Please use a figma.com/design/... share link.');
  return m[1];
}

/** Extract node-id from Figma share URL query param, converting 86-2961 → 86:2961 */
function extractFigmaNodeId(url) {
  try {
    const u = new URL(url);
    const raw = u.searchParams.get('node-id');
    if (!raw) return null;
    return raw.replace(/-/g, ':');   // '86-2961' → '86:2961'
  } catch {
    return null;
  }
}

function calculateMatchScore(mismatches) {
  const score = mismatches.reduce((s, m) => {
    const v = (m.severity || '').toLowerCase();
    return s - (v === 'critical' ? 15 : v === 'major' ? 8 : 3);
  }, 100);
  return Math.max(0, score);
}

function deriveLabel(pct) {
  if (typeof pct !== 'number') return 'Medium';
  if (pct <= 40) return 'Low';
  if (pct <= 75) return 'Medium';
  return 'High';
}

// ── Part A: Screenshot live website ──────────────────────────────────────────

async function screenshotWebsite(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    // D) 60 s goto timeout
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));

    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve(undefined);
          }
        }, 80);
      });
    });

    await new Promise(r => setTimeout(r, 1500));
    const buf = await page.screenshot({ type: 'jpeg', quality: 95, fullPage: true });
    return buf.toString('base64');
  } finally {
    if (browser) try { await browser.close(); } catch (_) {}
  }
}

// ── Part B: Fetch Figma frame image ──────────────────────────────────────────

async function fetchFigmaImage(figmaUrl, figmaToken) {
  const fileKey = extractFigmaFileKey(figmaUrl);
  const nodeId  = extractFigmaNodeId(figmaUrl);   // may be null

  let frameId = nodeId;

  if (!frameId) {
    // G) No node-id in URL — fetch file metadata (with C) retry logic)
    let fileRes;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // A) File metadata fetch timeout: 60 000 ms
        fileRes = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
          headers: { 'X-Figma-Token': figmaToken },
          timeout: 60000,
        });
        break; // success
      } catch (err) {
        if (attempt < 2) {
          console.warn(`[Figma] file metadata attempt ${attempt} failed: ${err.message} — retrying in 3 s…`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          throw err;
        }
      }
    }
    const firstPage  = fileRes.data.document.children[0];
    const firstFrame = firstPage?.children?.[0];
    if (!firstFrame) throw new Error('No frames found in Figma file.');
    frameId = firstFrame.id;
  }

  // B) Figma image export with 3 retries, 5 s between attempts
  let imgRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // A) Image export timeout: 60 000 ms
      imgRes = await axios.get(
        `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(frameId)}&format=png&scale=2`,
        { headers: { 'X-Figma-Token': figmaToken }, timeout: 60000 }
      );
      break; // success
    } catch (err) {
      if (attempt < 3) {
        console.warn(`[Figma] image export attempt ${attempt} failed: ${err.message} — retrying in 5 s…`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw new Error(`Figma image export failed after 3 attempts: ${err.message}`);
      }
    }
  }

  const imageUrl = imgRes.data.images[frameId];
  if (!imageUrl) throw new Error('Could not export Figma frame as image.');

  // A) Image download timeout: 120 000 ms
  const dl = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 120000 });
  return Buffer.from(dl.data).toString('base64');
}

// ── Part C: Gemini Vision comparison ─────────────────────────────────────────

async function compareWithGemini(websiteBase64, figmaBase64, websiteUrl) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `You are a pixel-perfect UI/UX design QA engineer with expert eyes for visual differences.

I am giving you TWO images:
IMAGE 1 = Live website screenshot of: ${websiteUrl}
IMAGE 2 = Figma design (the intended correct design)

Your job is to find EVERY single visual difference between them. Be extremely precise and specific.

For EACH difference found, you must:
1. Name the EXACT element (e.g. 'primary CTA button in hero section')
2. State the EXACT location on the page (e.g. 'top-right of navbar', 'center of hero section', 'left column of footer')
3. Give EXACT values where visible:
   - Colors: provide hex codes (e.g. #FF5733 vs #FF0000)
   - Sizes: estimate in px (e.g. 48px vs 40px)
   - Fonts: name the font family and weight (e.g. Inter Bold vs Inter Regular)
   - Spacing: estimate padding/margin differences (e.g. 24px vs 16px)
   - Border radius: (e.g. 8px vs 0px)
4. Provide bounding box coordinates for where this difference appears:
   - x: percentage from left edge (0-100)
   - y: percentage from top edge (0-100)
   - width: percentage of total width (0-100)
   - height: percentage of total height (0-100)
   These coordinates should describe where the difference is on BOTH images.

Check ALL of these categories:
- Colors (backgrounds, text, buttons, borders, icons)
- Typography (font family, size, weight, line height, letter spacing)
- Spacing (padding, margin, gap between elements)
- Layout (element position, alignment, order of sections)
- Components (button shape, card style, input style, nav style)
- Images and icons (missing images, different icons, wrong illustrations)
- Missing elements (in Figma but NOT on live site)
- Extra elements (on live site but NOT in Figma)
- Border radius and shadows
- Content differences (wrong text, missing text)

Return ONLY a valid JSON array:
[
  {
    "issueNumber": 1,
    "category": "Colors|Typography|Spacing|Layout|Components|Images|Missing|Extra|Borders|Content",
    "severity": "critical|major|minor",
    "title": "Short specific title",
    "description": "Exact detailed description of the difference",
    "location": "Exact location on page",
    "figmaValue": "Exact value in Figma design",
    "liveValue": "Exact value on live site",
    "boundingBox": {
      "x": 10,
      "y": 5,
      "width": 30,
      "height": 8
    }
  }
]

Be thorough. Find minimum 8 differences, maximum 30.
Every figmaValue and liveValue must have a SPECIFIC value — never write 'different' or 'N/A' or 'unknown'.
JSON array only, no other text.`;

  const result = await model.generateContent([
    { inlineData: { mimeType: 'image/jpeg', data: websiteBase64 } },
    { inlineData: { mimeType: 'image/jpeg', data: figmaBase64  } },
    { text: prompt },
  ]);

  const text = result.response.text();

  try {
    // Try array directly
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);

    // Try object wrapper (some models wrap in {})
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed.mismatches)) return parsed.mismatches;
    }
    return [];
  } catch {
    return [{
      issueNumber: 1, category: 'Analysis', severity: 'minor',
      title: 'Analysis Result', description: text,
      location: 'Full page', figmaValue: 'See description', liveValue: 'See description',
      boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    }];
  }
}

// ── Main controller ───────────────────────────────────────────────────────────

const matchDesign = async (req, res) => {
  const { websiteUrl, figmaUrl } = req.body;

  if (!websiteUrl || !figmaUrl) {
    return res.status(400).json({ success: false, message: 'Both website URL and Figma URL are required.' });
  }

  const figmaToken = process.env.FIGMA_API_TOKEN;
  if (!figmaToken) {
    return res.status(500).json({ success: false, message: 'FIGMA_API_TOKEN not configured.' });
  }

  try {
    console.log('[MatchDesign] Screenshotting website:', websiteUrl);
    const websiteBase64 = await screenshotWebsite(websiteUrl);

    console.log('[MatchDesign] Fetching Figma design:', figmaUrl);
    const figmaBase64 = await fetchFigmaImage(figmaUrl, figmaToken);

    console.log('[MatchDesign] Comparing with Gemini Vision...');
    const mismatches = await compareWithGemini(websiteBase64, figmaBase64, websiteUrl);

    // Part D: compute scores
    const matchScore      = calculateMatchScore(mismatches);
    const projectedScore  = 100;
    const matchPercentage = matchScore;
    const accuracyLabel   = deriveLabel(matchScore);

    console.log(`[MatchDesign] score:${matchScore}% (${accuracyLabel}) mismatches:${mismatches.length}`);

    // Part E: return screenshots so frontend can overlay bounding boxes
    return res.status(200).json({
      success: true,
      mismatches,
      totalIssues:            mismatches.length,
      matchScore,
      projectedScore,
      matchPercentage,
      accuracyLabel,
      websiteScreenshotBase64: websiteBase64,
      figmaScreenshotBase64:   figmaBase64,
      websiteUrl,
      figmaUrl,
    });

  } catch (err) {
    console.error('[MatchDesign] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Comparison failed.' });
  }
};

module.exports = { matchDesign };