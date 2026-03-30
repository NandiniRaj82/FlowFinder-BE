const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function scrapePageContent(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.evaluate(() => {
      const clean = t => (t || '').replace(/\s+/g, ' ').trim();

      const navLinks = Array.from(document.querySelectorAll('nav a, header a'))
        .map(a => ({ text: clean(a.innerText), href: a.getAttribute('href') || '#' }))
        .filter(a => a.text.length > 0 && a.text.length < 40)
        .slice(0, 10);

      const h1s = Array.from(document.querySelectorAll('h1')).map(h => clean(h.innerText)).filter(Boolean).slice(0, 3);
      const h2s = Array.from(document.querySelectorAll('h2')).map(h => clean(h.innerText)).filter(Boolean).slice(0, 8);
      const h3s = Array.from(document.querySelectorAll('h3')).map(h => clean(h.innerText)).filter(Boolean).slice(0, 10);

      const paras = Array.from(document.querySelectorAll('p'))
        .map(p => clean(p.innerText))
        .filter(p => p.length > 30)
        .slice(0, 12);

      const ctas = Array.from(document.querySelectorAll('button, a.btn, a[class*="button"], a[class*="cta"]'))
        .map(b => clean(b.innerText))
        .filter(b => b.length > 0 && b.length < 50)
        .slice(0, 6);

      const lists = Array.from(document.querySelectorAll('ul, ol'))
        .map(ul => Array.from(ul.querySelectorAll('li')).map(li => clean(li.innerText)).filter(Boolean).slice(0, 6))
        .filter(l => l.length > 0)
        .slice(0, 4);

      const title       = document.title || '';
      const description = document.querySelector('meta[name="description"]')?.content || '';
      const logo        = document.querySelector('header img, nav img, .logo img')?.src || '';

      const body         = document.body;
      const bodyStyle    = window.getComputedStyle(body);
      const primaryBg    = bodyStyle.backgroundColor;
      const primaryColor = bodyStyle.color;

      const sections = [];
      document.querySelectorAll('section, [class*="section"], main > div').forEach(sec => {
        const heading = sec.querySelector('h1,h2,h3')?.innerText?.trim();
        const text    = Array.from(sec.querySelectorAll('p')).map(p => clean(p.innerText)).filter(p => p.length > 20).slice(0, 2).join(' ');
        const items   = Array.from(sec.querySelectorAll('li')).map(li => clean(li.innerText)).filter(Boolean).slice(0, 5);
        if (heading) sections.push({ heading: clean(heading), text, items });
      });

      return {
        title, description, logo,
        navLinks, h1s, h2s, h3s, paras, ctas, lists,
        sections: sections.slice(0, 8),
        primaryBg, primaryColor
      };
    });

    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
    content.screenshotBase64 = screenshot.toString('base64');

    return content;
  } finally {
    if (browser) await browser.close();
  }
}

async function generateStyledHTML(content, style, url) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const styleGuides = {
    minimal: {
      name: 'Minimal & Clean',
      description: 'Pure white background, generous whitespace, sharp typography, no gradients',
      colors: 'White (#FFFFFF) background, near-black (#111111) text, single accent color',
      fonts: 'Use system font stack or suggest Google Fonts link for clean sans-serif',
      mood: 'Apple-like, editorial, breathing space, content-first',
      animations: 'Subtle fade-in on scroll, clean hover underlines on links',
    },
    bold: {
      name: 'Bold & Dark',
      description: 'Dark background, vibrant accent colors, strong typography, high contrast',
      colors: 'Very dark (#0A0A0F) background, white text, vivid accent (electric blue or neon green)',
      fonts: 'Strong display font for headings, clean body font',
      mood: 'Powerful, modern tech, confident, premium',
      animations: 'Gradient text animations, glow effects on hover, slide-in elements',
    },
    colorful: {
      name: 'Colorful & Vibrant',
      description: 'Rich gradients, playful colors, energetic layout, rounded corners',
      colors: 'Gradient backgrounds, multiple accent colors, warm and inviting palette',
      fonts: 'Rounded or friendly display font, readable body font',
      mood: 'Creative, energetic, modern startup, friendly',
      animations: 'Colorful gradient shifts, bouncy hover effects, vibrant section transitions',
    }
  };

  const guide = styleGuides[style];

  const contentSummary = `
Website: ${url}
Title: ${content.title}
Description: ${content.description}
Nav links: ${content.navLinks.map(n => n.text).join(', ')}
Main headings: ${content.h1s.join(' | ')}
Sub headings: ${content.h2s.slice(0, 5).join(' | ')}
Key paragraphs: ${content.paras.slice(0, 4).join(' || ')}
CTAs/Buttons: ${content.ctas.join(', ')}
Sections: ${content.sections.map(s => `[${s.heading}: ${s.text.slice(0, 80)}]`).join(' | ')}
Lists: ${content.lists.map(l => l.join(', ')).join(' | ')}
  `.trim();

  const prompt = `You are a world-class frontend developer and UI designer.

Create a COMPLETE, BEAUTIFUL, FULLY FUNCTIONAL single-page HTML redesign of this website.

STYLE: ${guide.name}
DESCRIPTION: ${guide.description}
COLORS: ${guide.colors}
FONTS: ${guide.fonts}
MOOD: ${guide.mood}
ANIMATIONS: ${guide.animations}

WEBSITE CONTENT TO USE:
${contentSummary}

REQUIREMENTS:
1. Use ALL the real content from above — real headings, real paragraphs, real nav links, real CTAs
2. Create a COMPLETE page with: navigation, hero section, features/services sections, and footer
3. Include <style> with beautiful CSS — NO external CSS frameworks
4. Include smooth CSS animations and hover effects appropriate for the style
5. Use Google Fonts (include the <link> tag) for beautiful typography
6. Make it fully responsive (mobile-friendly)
7. The design must look PROFESSIONAL and PRODUCTION-READY
8. Include subtle micro-interactions on buttons and links
9. Navigation should be sticky/fixed at top
10. Hero section should be visually impressive and above-fold

CRITICAL: Return ONLY the complete HTML document starting with <!DOCTYPE html>. Nothing else. No markdown, no explanation, no backticks.`;

  const result = await model.generateContent(prompt);
  let html = result.response.text();

  html = html.replace(/^```html\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();

  if (!html.startsWith('<!DOCTYPE') && !html.startsWith('<html')) {
    const docStart = html.indexOf('<!DOCTYPE');
    if (docStart > -1) html = html.slice(docStart);
  }

  return { style, styleName: guide.name, html };
}

const redesignWebsite = async (req, res) => {
  const { websiteUrl } = req.body;

  if (!websiteUrl || !websiteUrl.startsWith('http')) {
    return res.status(400).json({ success: false, message: 'Valid website URL is required.' });
  }

  try {
    console.log('[Redesigner] Scraping content from:', websiteUrl);
    const content = await scrapePageContent(websiteUrl);
    console.log('[Redesigner] Scraped:', content.title, '| Sections:', content.sections.length);

    console.log('[Redesigner] Generating 3 redesign styles...');
    const [minimalResult, boldResult, colorfulResult] = await Promise.all([
      generateStyledHTML(content, 'minimal', websiteUrl),
      generateStyledHTML(content, 'bold', websiteUrl),
      generateStyledHTML(content, 'colorful', websiteUrl),
    ]);

    console.log('[Redesigner] All 3 designs generated successfully');

    return res.status(200).json({
      success: true,
      websiteUrl,
      pageTitle: content.title,
      screenshotBase64: content.screenshotBase64,
      designs: [minimalResult, boldResult, colorfulResult],
    });

  } catch (error) {
    console.error('[Redesigner] Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Failed to redesign website.' });
  }
};

module.exports = { redesignWebsite };