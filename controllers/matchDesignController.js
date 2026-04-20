const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');
const axios = require('axios');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ── Helpers ────────────────────────────────────────────────────────────── */

function extractFigmaFileKey(url) {
  const match = url.match(/figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error('Invalid Figma URL. Please use a figma.com/design/... share link.');
  return match[1];
}

function extractFigmaNodeId(url) {
  try {
    const parsed = new URL(url);
    const nodeId = parsed.searchParams.get('node-id');
    if (!nodeId) return null;
    // Convert '86-2961' format to '86:2961' format
    return nodeId.replace(/-/g, ':');
  } catch {
    return null;
  }
}

/* ── Part A: Improved screenshot ────────────────────────────────────────── */

async function screenshotWebsite(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    // Part D: increased goto timeout from 30000 → 60000
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    // Wait 4s for animations / deferred content
    await new Promise(r => setTimeout(r, 4000));

    // Scroll through the full page to trigger lazy loading, then return to top
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0;
        const distance = 300;
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

    await new Promise(r => setTimeout(r, 1000));

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 95,
      fullPage: true,
    });

    return screenshot.toString('base64');
  } finally {
    if (browser) await browser.close();
  }
}

/* ── Part B/C/G: Improved Figma fetch with retry + node-id fast-path ─────── */

async function fetchFigmaImage(figmaUrl, figmaToken) {
  const fileKey = extractFigmaFileKey(figmaUrl);
  const nodeId  = extractFigmaNodeId(figmaUrl);

  let targetNodeId = nodeId;

  if (!targetNodeId) {
    // Part C: retry file metadata fetch up to 2 times with 3s delay
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[MatchDesign] Fetching Figma file metadata (attempt ${attempt}/2)...`);
        const fileRes = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
          headers: { 'X-Figma-Token': figmaToken },
          timeout: 60000, // Part A: increased to 60s
        });
        const firstPage  = fileRes.data.document.children[0];
        const firstFrame = firstPage?.children?.[0];
        if (!firstFrame) throw new Error('No frames found in Figma file.');
        targetNodeId = firstFrame.id;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          console.log(`[MatchDesign] Figma metadata fetch failed (attempt ${attempt}), retrying in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    if (!targetNodeId) throw lastErr;
  } else {
    console.log(`[MatchDesign] Using node-id from URL: ${targetNodeId} (skipping file metadata fetch)`);
  }

  // Part B: retry image export request up to 3 times with 5s delay
  let exportUrl;
  let lastExportErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[MatchDesign] Requesting Figma image export (attempt ${attempt}/3)...`);
      const imgRes = await axios.get(
        `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(targetNodeId)}&format=png&scale=2`,
        { headers: { 'X-Figma-Token': figmaToken }, timeout: 60000 } // Part A: increased to 60s
      );
      exportUrl = imgRes.data.images[targetNodeId];
      if (!exportUrl) throw new Error('Could not export Figma frame as image.');
      break;
    } catch (err) {
      lastExportErr = err;
      if (attempt < 3) {
        console.log(`[MatchDesign] Figma export failed (attempt ${attempt}), retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  if (!exportUrl) throw lastExportErr;

  // Part A: image download timeout increased to 120s
  const imgDownload = await axios.get(exportUrl, { responseType: 'arraybuffer', timeout: 120000 });
  return Buffer.from(imgDownload.data).toString('base64');
}

/* ── Part C: Improved Gemini prompt ─────────────────────────────────────── */

async function compareWithGemini(websiteBase64, figmaBase64) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `You are a pixel-perfect UI/UX design QA engineer with expert eyes for visual differences.

I am giving you TWO images:
IMAGE 1 = Live website screenshot
IMAGE 2 = Figma design (the intended correct design)

Your job is to find EVERY single visual difference between them.
Be extremely precise and specific.

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
    { inlineData: { mimeType: 'image/png',  data: figmaBase64   } },
    { text: prompt },
  ]);

  const text = result.response.text();
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return [];
  } catch {
    return [{
      issueNumber: 1, category: 'Analysis', severity: 'minor',
      title: 'Raw Analysis', description: text, location: 'Full page',
      figmaValue: 'See description', liveValue: 'See description',
      boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    }];
  }
}

/* ── Part D: Score calculator ───────────────────────────────────────────── */

function computeScores(mismatches) {
  const WEIGHTS = { critical: 15, major: 8, minor: 3 };
  const deduction = mismatches.reduce((sum, m) => {
    return sum + (WEIGHTS[(m.severity || 'minor').toLowerCase()] || 3);
  }, 0);
  const matchScore     = Math.max(0, 100 - deduction);
  const projectedScore = 100;
  return { matchScore, projectedScore };
}

/* ── Main handler ───────────────────────────────────────────────────────── */

const matchDesign = async (req, res) => {
  const { websiteUrl, figmaUrl } = req.body;

  if (!websiteUrl || !figmaUrl) {
    return res.status(400).json({ success: false, message: 'Both website URL and Figma URL are required.' });
  }

  const figmaToken = process.env.FIGMA_API_TOKEN;
  if (!figmaToken) {
    return res.status(500).json({ success: false, message: 'Figma API token not configured.' });
  }

  try {
    console.log('[MatchDesign] Screenshotting website:', websiteUrl);
    const websiteBase64 = await screenshotWebsite(websiteUrl);

    console.log('[MatchDesign] Fetching Figma design:', figmaUrl);
    const figmaBase64 = await fetchFigmaImage(figmaUrl, figmaToken);

    console.log('[MatchDesign] Comparing with Gemini Vision...');
    const mismatches = await compareWithGemini(websiteBase64, figmaBase64);

    const { matchScore, projectedScore } = computeScores(mismatches);
    console.log(`[MatchDesign] Found ${mismatches.length} mismatches. Score: ${matchScore}%`);

    return res.status(200).json({
      success: true,
      mismatches,
      totalIssues:            mismatches.length,
      matchScore,
      projectedScore,
      websiteUrl,
      figmaUrl,
      websiteScreenshotBase64: websiteBase64,
      figmaScreenshotBase64:   figmaBase64,
    });
  } catch (error) {
    console.error('[MatchDesign] Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Failed to compare designs.' });
  }
};

module.exports = { matchDesign };