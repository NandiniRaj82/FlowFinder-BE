const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Resilient navigation helper ───────────────────────────────────────────
// Strategy: try domcontentloaded (fast), fall back to load, then just wait.
// Never throws — always returns after the page has at least started rendering.
async function navigateSafe(page, url) {
  const strategies = [
    { waitUntil: 'domcontentloaded', timeout: 30000 },
    { waitUntil: 'load',             timeout: 45000 },
    { waitUntil: 'domcontentloaded', timeout: 60000 },
  ];

  for (const s of strategies) {
    try {
      await page.goto(url, s);
      return; // success
    } catch (err) {
      console.warn(`[Redesigner] Nav attempt failed (${s.waitUntil}/${s.timeout}ms): ${err.message}`);
    }
  }

  // Last resort — navigate with no wait condition, then just pause
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
  } catch (err) {
    console.error('[Redesigner] All navigation strategies failed:', err.message);
    // Don't throw — page may still have partial content we can scrape
  }
}

// ── Full page screenshot ──────────────────────────────────────────────────
async function screenshotWebsite(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    // Real browser UA to bypass basic bot-detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    await navigateSafe(page, url);

    // Short settle wait — enough for hero images/fonts to paint
    await new Promise(r => setTimeout(r, 2000));

    const screenshot = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
    return screenshot.toString('base64');
  } catch (err) {
    console.error('[Redesigner] Screenshot failed:', err.message);
    return ''; // non-fatal — UI handles empty screenshot gracefully
  } finally {
    if (browser) await browser.close();
  }
}

// ── Deep content scrape — gets EVERYTHING ────────────────────────────────
async function scrapePageContent(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Block heavy resources that slow page load but aren't needed for text scraping
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'websocket'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await navigateSafe(page, url);
    await new Promise(r => setTimeout(r, 2000));

    const content = await page.evaluate(() => {
      const clean = t => (t || '').replace(/\s+/g, ' ').trim();
      const isVisible = el => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetParent !== null;
      };

      // Meta
      const title = document.title || '';
      const description = document.querySelector('meta[name="description"]')?.content || '';

      // Logo/brand
      const logoText = clean(
        document.querySelector('.logo, [class*="logo"], [class*="brand"], nav .name, header .name')?.innerText ||
        document.querySelector('header h1, header a:first-child')?.innerText || ''
      );

      // Nav links — ALL of them
      const navLinks = Array.from(document.querySelectorAll('nav a, header nav a, [role="navigation"] a'))
        .filter(a => isVisible(a))
        .map(a => ({ text: clean(a.innerText), href: a.getAttribute('href') || '#' }))
        .filter(a => a.text.length > 0 && a.text.length < 60)
        .reduce((acc, cur) => { if (!acc.find(x => x.text === cur.text)) acc.push(cur); return acc; }, []);

      // ALL headings — every single one
      const h1s = Array.from(document.querySelectorAll('h1')).map(h => clean(h.innerText)).filter(Boolean);
      const h2s = Array.from(document.querySelectorAll('h2')).map(h => clean(h.innerText)).filter(Boolean);
      const h3s = Array.from(document.querySelectorAll('h3')).map(h => clean(h.innerText)).filter(Boolean);
      const h4s = Array.from(document.querySelectorAll('h4')).map(h => clean(h.innerText)).filter(Boolean);

      // ALL paragraphs
      const paras = Array.from(document.querySelectorAll('p'))
        .filter(p => isVisible(p))
        .map(p => clean(p.innerText))
        .filter(p => p.length > 10);

      // ALL list items — EVERY single one (tech stack, projects, etc.)
      const allListItems = Array.from(document.querySelectorAll('li'))
        .filter(li => isVisible(li))
        .map(li => clean(li.innerText))
        .filter(li => li.length > 1 && li.length < 300);

      // ALL buttons and CTAs
      const ctas = Array.from(document.querySelectorAll('button, a[href], [role="button"]'))
        .filter(b => isVisible(b))
        .map(b => clean(b.innerText))
        .filter(b => b.length > 0 && b.length < 80)
        .reduce((acc, cur) => { if (!acc.includes(cur)) acc.push(cur); return acc; }, [])
        .slice(0, 20);

      // ALL spans and divs with short meaningful text (catches tech stack badges, skill tags etc.)
      const badges = Array.from(document.querySelectorAll('span, .badge, .tag, .chip, .skill, .tech, [class*="badge"], [class*="tag"], [class*="chip"], [class*="skill"], [class*="tech"], [class*="stack"]'))
        .filter(el => isVisible(el))
        .map(el => clean(el.innerText))
        .filter(t => t.length > 1 && t.length < 40)
        .reduce((acc, cur) => { if (!acc.includes(cur)) acc.push(cur); return acc; }, [])
        .slice(0, 60);

      // Build sections from the DOM structure
      const sections = [];
      const sectionEls = document.querySelectorAll('section, [id], [class*="section"], [class*="hero"], [class*="about"], [class*="projects"], [class*="skills"], [class*="experience"], [class*="contact"], [class*="work"], [class*="portfolio"]');

      sectionEls.forEach(sec => {
        const id = sec.id || sec.className?.toString()?.split(' ')[0] || '';
        const headings = Array.from(sec.querySelectorAll('h1,h2,h3,h4')).map(h => clean(h.innerText)).filter(Boolean);
        const texts = Array.from(sec.querySelectorAll('p')).filter(p => isVisible(p)).map(p => clean(p.innerText)).filter(p => p.length > 10);
        const items = Array.from(sec.querySelectorAll('li')).filter(li => isVisible(li)).map(li => clean(li.innerText)).filter(t => t.length > 1);
        const btns = Array.from(sec.querySelectorAll('button, a[href]')).filter(b => isVisible(b)).map(b => clean(b.innerText)).filter(b => b.length > 0 && b.length < 60);
        const tags = Array.from(sec.querySelectorAll('span, .badge, .tag, .chip')).filter(el => isVisible(el)).map(el => clean(el.innerText)).filter(t => t.length > 1 && t.length < 30);

        if (headings.length > 0 || texts.length > 0 || items.length > 0) {
          sections.push({ id, headings, texts, items, buttons: btns, tags });
        }
      });

      // Footer
      const footerEl = document.querySelector('footer');
      const footerHeadings = footerEl ? Array.from(footerEl.querySelectorAll('h1,h2,h3,h4,h5')).map(h => clean(h.innerText)).filter(Boolean) : [];
      const footerTexts = footerEl ? Array.from(footerEl.querySelectorAll('p')).map(p => clean(p.innerText)).filter(Boolean) : [];
      const footerLinks = footerEl ? Array.from(footerEl.querySelectorAll('a')).map(a => clean(a.innerText)).filter(Boolean) : [];

      return {
        title, description, logoText,
        navLinks, h1s, h2s, h3s, h4s,
        paras, allListItems, badges, ctas,
        sections: sections.slice(0, 20),
        footer: { headings: footerHeadings, texts: footerTexts, links: footerLinks },
      };
    });

    return content;
  } finally { if (browser) await browser.close(); }
}

// ── Build exhaustive content reference ────────────────────────────────────
function buildContentReference(content, url) {
  const lines = [];
  lines.push(`=== WEBSITE CONTENT TO USE VERBATIM ===`);
  lines.push(`NOTE: The labels like (heading), (paragraph), (button) below are instructions for YOU only.`);
  lines.push(`Do NOT include any labels, brackets, or reference numbers in the HTML output.`);
  lines.push(`Only output the actual text values shown after each label.`);
  lines.push('');
  lines.push(`Page Title: ${content.title}`);
  lines.push(`Brand/Logo name: ${content.logoText || content.title}`);
  lines.push('');

  lines.push(`NAVIGATION LINKS — use these exact texts as nav items:`);
  content.navLinks.forEach(n => lines.push(`  - ${n.text}`));
  lines.push('');

  lines.push(`H1 HEADING — use as main hero heading:`);
  content.h1s.forEach(h => lines.push(`  "${h}"`));
  lines.push('');

  lines.push(`H2 HEADINGS — use as section titles:`);
  content.h2s.forEach(h => lines.push(`  "${h}"`));
  lines.push('');

  lines.push(`H3 HEADINGS — use as sub-section titles:`);
  content.h3s.forEach(h => lines.push(`  "${h}"`));
  lines.push('');

  if (content.h4s.length > 0) {
    lines.push(`H4 HEADINGS:`);
    content.h4s.forEach(h => lines.push(`  "${h}"`));
    lines.push('');
  }

  lines.push(`PARAGRAPHS — use all ${content.paras.length} of these as body text:`);
  content.paras.forEach(p => lines.push(`  "${p}"`));
  lines.push('');

  lines.push(`LIST ITEMS — include ALL ${content.allListItems.length} items (do not skip any):`);
  content.allListItems.forEach(li => lines.push(`  - ${li}`));
  lines.push('');

  if (content.badges.length > 0) {
    lines.push(`TECH STACK / SKILL BADGES — display ALL ${content.badges.length} as badge/tag elements:`);
    content.badges.forEach(b => lines.push(`  - ${b}`));
    lines.push('');
  }

  lines.push(`BUTTONS / CTAs — use these exact texts on buttons:`);
  content.ctas.forEach(c => lines.push(`  - ${c}`));
  lines.push('');

  lines.push(`PAGE SECTIONS — include all ${content.sections.length} sections in this order:`);
  content.sections.forEach((s, i) => {
    lines.push(`  Section ${i + 1}:`);
    if (s.headings.length > 0) lines.push(`    heading: ${s.headings.join(' / ')}`);
    if (s.texts.length > 0) lines.push(`    body text: ${s.texts.join(' | ')}`);
    if (s.items.length > 0) lines.push(`    list items (${s.items.length}): ${s.items.join(', ')}`);
    if (s.tags.length > 0) lines.push(`    tags (${s.tags.length}): ${s.tags.join(', ')}`);
    if (s.buttons.length > 0) lines.push(`    buttons: ${s.buttons.join(', ')}`);
  });
  lines.push('');

  if (content.footer.texts.length > 0 || content.footer.links.length > 0) {
    lines.push(`FOOTER:`);
    if (content.footer.headings.length > 0) lines.push(`  headings: ${content.footer.headings.join(', ')}`);
    if (content.footer.texts.length > 0) lines.push(`  text: ${content.footer.texts.join(' | ')}`);
    if (content.footer.links.length > 0) lines.push(`  links: ${content.footer.links.join(', ')}`);
    lines.push('');
  }

  lines.push(`=== END OF CONTENT ===`);
  lines.push(`REMINDER: Output clean HTML only. No [brackets], no (labels), no reference numbers in the page.`);

  return lines.join('\n');
}

// ── Generate design code (branches on framework) ────────────────────────
async function generateHTML(content, style, url, customPrompt, framework) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const contentRef = buildContentReference(content, url);

  const styleGuides = {
    minimal: { name: 'Minimal & Clean', guide: 'White background, near-black text, single blue accent (#2563EB), generous whitespace, DM Sans or Plus Jakarta Sans from Google Fonts, no gradients, subtle animations, thin borders.' },
    bold: { name: 'Bold & Dark', guide: 'Very dark background (#0A0A0F), white text, electric blue or neon accent, Syne or Space Grotesk from Google Fonts, glow effects, gradient hero text, high contrast cards, slide-in animations.' },
    colorful: { name: 'Colorful & Vibrant', guide: 'Warm gradient backgrounds, Nunito or Poppins from Google Fonts, rounded corners (20px+), multiple accent colors, colorful cards, bouncy hover effects, energetic startup feel.' },
    custom:   { name: 'Custom Design',   guide: customPrompt || 'Modern clean design.' },
    custom_1: { name: 'Custom Style 1',  guide: customPrompt || 'Modern clean design.' },
    custom_2: { name: 'Custom Style 2',  guide: customPrompt || 'Modern clean design.' },
    custom_3: { name: 'Custom Style 3',  guide: customPrompt || 'Modern clean design.' },
  };

  const sg = styleGuides[style] || styleGuides.minimal;
  if (style.startsWith('custom') && customPrompt) {
    sg.guide = customPrompt;
    sg.name = style === 'custom' ? 'Custom Design' : 'Custom Style ' + style.replace('custom_', '');
  }

  const frameworkMeta = {
    html:    { ext: 'html', label: 'HTML/CSS/JS' },
    react:   { ext: 'jsx',  label: 'React (JSX)' },
    nextjs:  { ext: 'jsx',  label: 'Next.js' },
    angular: { ext: 'ts',   label: 'Angular' },
    vue:     { ext: 'vue',  label: 'Vue.js' },
  };
  const fw = frameworkMeta[framework] || frameworkMeta.html;

  const isCustomStyle = style === 'custom' || style.startsWith('custom_');
  const styleBlock = 'STYLE: ' + sg.name + '\nSTYLE GUIDE: ' + sg.guide +
    (isCustomStyle && customPrompt ? '\nUSER CUSTOM INSTRUCTIONS: ' + customPrompt : '');

  const contentRules =
    'ABSOLUTE CONTENT RULES:\n' +
    '1. INCLUDE EVERY SINGLE ITEM from the content reference below\n' +
    '2. Copy ALL text VERBATIM\n' +
    '3. Include ALL ' + content.allListItems.length + ' list items\n' +
    '4. Include ALL ' + content.badges.length + ' badges/tags/tech stack items\n' +
    '5. Include ALL ' + content.sections.length + ' sections\n' +
    '6. Include ALL ' + content.paras.length + ' paragraphs\n' +
    '7. Do NOT add Lorem ipsum or invented text\n' +
    '8. Only change: colors, fonts, layout, spacing, animations\n\n' +
    contentRef +
    '\nTECHNICAL REQUIREMENTS:\n' +
    '- Fully responsive with mobile breakpoints\n' +
    '- Sticky navigation, smooth scroll\n' +
    '- CSS animations: fade-in on load, hover effects\n' +
    '- For images: use CSS gradient placeholders';

  const cleanCode = function(text) {
    var t = text.trim();
    t = t.replace(/^```[\w]*\n?/gm, '').replace(/\n?```/gm, '').trim();
    return t;
  };

  const isValidHtml = function(text) {
    return text.includes('<!DOCTYPE') || text.includes('<html');
  };

  // ── STEP 1: Always generate plain HTML (for thumbnail preview card) ───────
  const htmlPrompt =
    'You are a frontend developer. Generate a complete HTML website redesign.\n\n' +
    'CRITICAL OUTPUT FORMAT:\n' +
    '- Start with exactly: <!DOCTYPE html>\n' +
    '- Plain HTML/CSS/JS only — NO React, NO JSX, NO Vue, NO Angular\n' +
    '- All CSS in a <style> tag in <head>\n' +
    '- All JS in a <script> tag before </body>\n' +
    '- Include Google Fonts via <link> in <head>\n\n' +
    'CRITICAL CONTENT RULES:\n' +
    '- Use the EXACT text values from the content reference below\n' +
    '- Do NOT include any labels, brackets, numbers or markers in your HTML output\n' +
    '- Output only clean text — no reference markers\n\n' +
    styleBlock + '\n\n' +
    contentRules + '\n\n' +
    'Start your response with: <!DOCTYPE html>';

  console.log('[Redesigner] Generating HTML preview for style:', style);
  var htmlResult = await model.generateContent(htmlPrompt);
  var previewHtml = cleanCode(htmlResult.response.text());

  var doctypeIdx = previewHtml.indexOf('<!DOCTYPE');
  var htmlTagIdx = previewHtml.indexOf('<html');
  var startIdx = doctypeIdx > -1 ? doctypeIdx : (htmlTagIdx > -1 ? htmlTagIdx : -1);
  if (startIdx > 0) previewHtml = previewHtml.slice(startIdx);

  if (!isValidHtml(previewHtml)) {
    console.warn('[Redesigner] Invalid HTML, retrying...');
    htmlResult = await model.generateContent(htmlPrompt);
    previewHtml = cleanCode(htmlResult.response.text());
    var idx2 = previewHtml.indexOf('<!DOCTYPE');
    if (idx2 > -1) previewHtml = previewHtml.slice(idx2);
  }

  if (!isValidHtml(previewHtml)) {
    previewHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preview</title><style>body{margin:0;font-family:sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:1rem;}</style></head><body><h2 style="color:#6366f1">Preview loading failed</h2><p style="opacity:0.5">Please try again</p></body></html>';
  }

  console.log('[Redesigner] HTML preview ready, length:', previewHtml.length);

  // ── STEP 2: If HTML framework, return immediately ─────────────────────────
  if (!framework || framework === 'html') {
    return { style: style, styleName: sg.name, framework: 'html', frameworkLabel: fw.label, ext: 'html', code: previewHtml, previewHtml: previewHtml, previewType: 'html' };
  }

  // ── STEP 3: Generate real framework-specific code ─────────────────────────
  var fwInstructions = {
    react:
      'You are a senior React developer. Generate a complete, beautiful single-file React component (JSX).\n\n' +
      'CRITICAL FORMAT RULES:\n' +
      '- First line MUST be: import React, { useState, useEffect } from "react";\n' +
      '- Last line MUST be: export default App;\n' +
      '- Function name: function App()\n' +
      '- Use ONLY inline styles (style={{}}). NO className, NO external CSS files\n' +
      '- Inject Google Fonts via useEffect adding a <link> element to document.head\n' +
      '- Use useState/useEffect for any interactivity (nav toggle, etc.)\n' +
      '- All content in one self-contained file runnable in CodeSandbox React template\n\n' +
      styleBlock + '\n\n' + contentRules + '\n\nOutput ONLY valid JSX code. No markdown fences. No explanations.',

    nextjs:
      'You are a senior Next.js developer. Generate a complete single-file Next.js page component (JSX).\n\n' +
      'CRITICAL FORMAT RULES:\n' +
      '- First line MUST be: import React, { useState, useEffect } from "react";\n' +
      '- Last line MUST be: export default Page;\n' +
      '- Function name: function Page()\n' +
      '- Use ONLY inline styles (style={{}}). NO className, NO external CSS files\n' +
      '- Inject Google Fonts via useEffect adding a <link> element to document.head\n' +
      '- All content in one self-contained file runnable in a CodeSandbox React template\n\n' +
      styleBlock + '\n\n' + contentRules + '\n\nOutput ONLY valid JSX code. No markdown fences. No explanations.',

    vue:
      'You are a senior Vue.js developer. Generate a complete single-file Vue 3 SFC.\n\n' +
      'CRITICAL FORMAT RULES:\n' +
      '- Must have <template>, <script setup>, and <style scoped> sections\n' +
      '- Use Vue 3 Composition API (ref, onMounted, computed)\n' +
      '- Inject Google Fonts via onMounted adding a <link> to document.head\n' +
      '- All styles in <style scoped> — no external imports\n' +
      '- The SFC must run in a CodeSandbox Vue template\n\n' +
      styleBlock + '\n\n' + contentRules + '\n\nOutput ONLY the .vue file content. No markdown fences.',

    angular:
      'You are a senior Angular developer. Generate a complete Angular standalone component (TypeScript).\n\n' +
      'CRITICAL FORMAT RULES:\n' +
      '- Import Component, OnInit from "@angular/core"\n' +
      '- Use @Component({ standalone: true, selector: "app-root", template: `...`, styles: [...] })\n' +
      '- Export class AppComponent implements OnInit\n' +
      '- All template HTML uses Angular template syntax\n' +
      '- All styles are inline in the styles array\n\n' +
      styleBlock + '\n\n' + contentRules + '\n\nOutput ONLY the TypeScript file. No markdown fences.',
  };

  var fwPrompt = fwInstructions[framework];
  if (!fwPrompt) {
    return { style: style, styleName: sg.name, framework: 'html', frameworkLabel: fw.label, ext: 'html', code: previewHtml, previewHtml: previewHtml, previewType: 'html' };
  }

  console.log('[Redesigner] Generating ' + fw.label + ' code for style: ' + style);
  var fwResult = await model.generateContent(fwPrompt);
  var frameworkCode = cleanCode(fwResult.response.text());

  if (!frameworkCode || frameworkCode.length < 100) {
    console.warn('[Redesigner] ' + fw.label + ' generation failed, falling back to HTML preview');
    return { style: style, styleName: sg.name, framework: framework, frameworkLabel: fw.label, ext: fw.ext, code: previewHtml, previewHtml: previewHtml, previewType: 'html' };
  }

  console.log('[Redesigner] ' + fw.label + ' code ready, length: ' + frameworkCode.length);

  return {
    style: style,
    styleName: sg.name,
    framework: framework,
    frameworkLabel: fw.label,
    ext: fw.ext,
    code: frameworkCode,
    previewHtml: previewHtml,
    previewType: 'sandpack',
  };
}


// ── SSE helper ────────────────────────────────────────────────────────────
function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Main controller (SSE streaming) ──────────────────────────────────────
const redesignWebsite = async (req, res) => {
  const { websiteUrl, selectedStyles, customPrompts = [], framework = 'html' } = req.body;

  if (!websiteUrl || !websiteUrl.startsWith('http')) {
    return res.status(400).json({ success: false, message: 'Valid website URL is required.' });
  }

  // ── Set up SSE headers ────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Keep connection alive every 20 s
  const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 20000);
  const cleanup = () => clearInterval(heartbeat);
  req.on('close', cleanup);

  try {
    sendSSE(res, 'status', { message: 'Scraping site & generating redesigns…' });
    console.log('[Redesigner] Scraping:', websiteUrl);


    const [screenshotBase64, content] = await Promise.all([
      screenshotWebsite(websiteUrl),
      scrapePageContent(websiteUrl),
    ]);

    console.log(`[Redesigner] Scraped — H1:${content.h1s.length} P:${content.paras.length} Sections:${content.sections.length}`);


    // meta will be emitted below after allStyles is built (includes totalDesigns)


    // Build list of styles to generate
    const stylesList = selectedStyles && selectedStyles.length > 0
      ? selectedStyles
      : ['minimal', 'bold', 'colorful'];

    // Add custom styles for each non-empty custom prompt
    const customList = customPrompts
      .map((p, i) => ({ key: `custom_${i + 1}`, prompt: p.trim() }))
      .filter(c => c.prompt.length > 5);

    const allStyles = [
      ...stylesList.map(s => ({ key: s, prompt: null })),
      ...customList,
    ];

    // Re-emit meta with totalDesigns now that we know the count
    sendSSE(res, 'meta', {
      pageTitle: content.title,
      screenshotBase64,
      totalDesigns: allStyles.length,
      stats: {
        headings: content.h1s.length + content.h2s.length + content.h3s.length,
        paragraphs: content.paras.length,
        listItems: content.allListItems.length,
        tags: content.badges.length,
        sections: content.sections.length,
      },
    });


    console.log(`[Redesigner] Generating ${allStyles.length} designs in ${framework}…`);

    // Generate each design and stream it as soon as it's done
    for (const { key, prompt } of allStyles) {
      sendSSE(res, 'status', { message: `Generating ${key} design…` });
      console.log(`[Redesigner] Generating style: ${key}`);

      const design = await generateHTML(
        content, key, websiteUrl, prompt, framework
      );
      design.style = key; // ensure key is set (generateHTML may use 'custom')

      sendSSE(res, 'design', { design });
      console.log(`[Redesigner] Streamed: ${key}`);
    }

    sendSSE(res, 'done', { success: true });
    console.log('[Redesigner] All designs streamed.');

  } catch (error) {
    console.error('[Redesigner] Error:', error.message);
    sendSSE(res, 'error', { message: error.message || 'Redesign failed.' });
  } finally {
    cleanup();
    res.end();
  }
};

module.exports = { redesignWebsite };