const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');
const axios = require('axios');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Extract Figma file key from any figma.com URL ─────────────────────────
function extractFigmaFileKey(url) {
  // Handles:
  //   https://www.figma.com/design/FILEKEY/...
  //   https://www.figma.com/file/FILEKEY/...
  //   https://www.figma.com/proto/FILEKEY/...
  const match = url.match(/figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error('Invalid Figma URL. Please use a figma.com/design/... share link.');
  return match[1];
}

// ── Screenshot the live website using Puppeteer ───────────────────────────
async function screenshotWebsite(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Scroll through page to trigger lazy loading
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
        }, 100);
      });
    });

    await new Promise(r => setTimeout(r, 1000));

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 90,
      fullPage: true  // ← capture entire page not just viewport
    });

    return screenshot.toString('base64');
  } finally {
    if (browser) await browser.close();
  }
}

// ── Fetch Figma design thumbnail via Figma API ────────────────────────────
async function fetchFigmaImage(figmaUrl, figmaToken) {
  const fileKey = extractFigmaFileKey(figmaUrl);

  // Get file metadata to find the first page/frame
  const fileRes = await axios.get(`https://api.figma.com/v1/files/${fileKey}`, {
    headers: { 'X-Figma-Token': figmaToken },
    timeout: 15000
  });

  const file = fileRes.data;

  // Get the first top-level frame node ID
  const firstPage = file.document.children[0];
  const firstFrame = firstPage?.children?.[0];

  if (!firstFrame) throw new Error('No frames found in Figma file.');

  // Export that frame as an image
  const imgRes = await axios.get(
    `https://api.figma.com/v1/images/${fileKey}?ids=${firstFrame.id}&format=jpg&scale=1`,
    {
      headers: { 'X-Figma-Token': figmaToken },
      timeout: 15000
    }
  );

  const imageUrl = imgRes.data.images[firstFrame.id];
  if (!imageUrl) throw new Error('Could not export Figma frame as image.');

  // Download the image and convert to base64
  const imgDownload = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
  return Buffer.from(imgDownload.data).toString('base64');
}

// ── Send both images to Gemini Vision for comparison ─────────────────────
async function compareWithGemini(websiteBase64, figmaBase64, websiteUrl) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const prompt = `You are a pixel-perfect UI/UX design reviewer with 10+ years of experience.

I'm giving you TWO images:
IMAGE 1 = LIVE WEBSITE screenshot of: ${websiteUrl}
IMAGE 2 = FIGMA DESIGN (the intended/correct design)

Your job: Find EVERY difference between them. Be extremely thorough and specific.

Check ALL of these categories one by one:

1. COLORS — background colors, text colors, button colors, border colors, icon colors
2. TYPOGRAPHY — font family, font size, font weight, line height, letter spacing, text alignment
3. SPACING — padding inside elements, margins between elements, gaps in flex/grid layouts
4. LAYOUT — element positions, order of sections, alignment (left/center/right), width/height
5. COMPONENTS — buttons (shape, size, style), cards, inputs, navbars, footers, modals
6. IMAGES & ICONS — missing images, wrong icons, different icon styles, placeholder vs real images
7. MISSING ELEMENTS — things visible in Figma but NOT on the live site
8. EXTRA ELEMENTS — things on the live site that are NOT in the Figma design
9. BORDERS & SHADOWS — border radius, border width, box shadows, outlines
10. RESPONSIVE/CONTENT — missing text, wrong copy, truncated content

For EACH issue found, respond ONLY with a valid JSON array:
[
  {
    "issueNumber": 1,
    "category": "Colors | Typography | Spacing | Layout | Components | Images & Icons | Missing Elements | Extra Elements | Borders & Shadows | Content",
    "severity": "critical | major | minor",
    "title": "Short specific title",
    "description": "Exactly what is different and why it matters",
    "location": "Specific location on page e.g. 'top navigation bar', 'hero section heading', 'footer left column'",
    "figmaValue": "Exact value from Figma e.g. '#1A1A2E', '24px', 'Inter Bold', 'rounded-full button'",
    "liveValue": "Exact value on live site e.g. '#000000', '20px', 'sans-serif', 'square button'"
  }
]

IMPORTANT RULES:
- Be SPECIFIC about location — say "hero section CTA button" not just "button"
- Include EXACT values where visible — hex colors, pixel sizes, font names
- If something is in Figma but completely missing from live site, mark as critical
- Minimum 5 issues, maximum 30 issues
- Return ONLY the JSON array, no other text`;
  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: 'image/jpeg',
        data: websiteBase64
      }
    },
    {
      inlineData: {
        mimeType: 'image/jpeg',
        data: figmaBase64
      }
    },
    { text: prompt }
  ]);

  const text = result.response.text();

  // Parse JSON from response
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return [];
  } catch {
    return [{ 
      issueNumber: 1,
      category: 'Analysis',
      severity: 'minor',
      title: 'Raw Analysis',
      description: text,
      location: 'Full page',
      figmaValue: 'N/A',
      liveValue: 'N/A'
    }];
  }
}

// ── Main controller ───────────────────────────────────────────────────────
const matchDesign = async (req, res) => {
  const { websiteUrl, figmaUrl } = req.body;

  if (!websiteUrl || !figmaUrl) {
    return res.status(400).json({
      success: false,
      message: 'Both website URL and Figma URL are required.'
    });
  }

  const figmaToken = process.env.FIGMA_API_TOKEN;
  if (!figmaToken) {
    return res.status(500).json({
      success: false,
      message: 'Figma API token not configured. Add FIGMA_API_TOKEN to your .env file.'
    });
  }

  try {
    console.log('[MatchDesign] Screenshotting website:', websiteUrl);
    const websiteBase64 = await screenshotWebsite(websiteUrl);

    console.log('[MatchDesign] Fetching Figma design:', figmaUrl);
    const figmaBase64 = await fetchFigmaImage(figmaUrl, figmaToken);

    console.log('[MatchDesign] Comparing with Gemini Vision...');
    const mismatches = await compareWithGemini(websiteBase64, figmaBase64, websiteUrl);

    console.log(`[MatchDesign] Found ${mismatches.length} mismatches`);

    return res.status(200).json({
      success: true,
      mismatches,
      totalIssues: mismatches.length,
      websiteUrl,
      figmaUrl
    });

  } catch (error) {
    console.error('[MatchDesign] Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to compare designs.'
    });
  }
};

module.exports = { matchDesign };