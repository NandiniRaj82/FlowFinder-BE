const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Full page screenshot ──────────────────────────────────────────────────
async function screenshotWebsite(url) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 40000 });
    await new Promise(r => setTimeout(r, 4000));
    await autoScroll(page);
    await new Promise(r => setTimeout(r, 2000));
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
    return screenshot.toString('base64');
  } finally { if (browser) await browser.close(); }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 200);
        total += 200;
        if (total >= document.body.scrollHeight) { clearInterval(timer); window.scrollTo(0, 0); resolve(); }
      }, 60);
    });
  });
}

// ── Deep content scrape — gets EVERYTHING ────────────────────────────────
async function scrapePageContent(url) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 40000 });
    await new Promise(r => setTimeout(r, 4000));
    await autoScroll(page);
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
        const texts    = Array.from(sec.querySelectorAll('p')).filter(p => isVisible(p)).map(p => clean(p.innerText)).filter(p => p.length > 10);
        const items    = Array.from(sec.querySelectorAll('li')).filter(li => isVisible(li)).map(li => clean(li.innerText)).filter(t => t.length > 1);
        const btns     = Array.from(sec.querySelectorAll('button, a[href]')).filter(b => isVisible(b)).map(b => clean(b.innerText)).filter(b => b.length > 0 && b.length < 60);
        const tags     = Array.from(sec.querySelectorAll('span, .badge, .tag, .chip')).filter(el => isVisible(el)).map(el => clean(el.innerText)).filter(t => t.length > 1 && t.length < 30);

        if (headings.length > 0 || texts.length > 0 || items.length > 0) {
          sections.push({ id, headings, texts, items, buttons: btns, tags });
        }
      });

      // Footer
      const footerEl = document.querySelector('footer');
      const footerHeadings = footerEl ? Array.from(footerEl.querySelectorAll('h1,h2,h3,h4,h5')).map(h => clean(h.innerText)).filter(Boolean) : [];
      const footerTexts    = footerEl ? Array.from(footerEl.querySelectorAll('p')).map(p => clean(p.innerText)).filter(Boolean) : [];
      const footerLinks    = footerEl ? Array.from(footerEl.querySelectorAll('a')).map(a => clean(a.innerText)).filter(Boolean) : [];

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
    lines.push(`  Section ${i+1}:`);
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

// ── Generate HTML (framework=html) ────────────────────────────────────────
async function generateHTML(content, style, url, customPrompt, framework) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const contentRef = buildContentReference(content, url);

  const styleGuides = {
    minimal:  { name: 'Minimal & Clean',     guide: 'White background, near-black text, single blue accent (#2563EB), generous whitespace, DM Sans or Plus Jakarta Sans from Google Fonts, no gradients, subtle animations, thin borders.' },
    bold:     { name: 'Bold & Dark',         guide: 'Very dark background (#0A0A0F), white text, electric blue or neon accent, Syne or Space Grotesk from Google Fonts, glow effects, gradient hero text, high contrast cards, slide-in animations.' },
    colorful: { name: 'Colorful & Vibrant',  guide: 'Warm gradient backgrounds, Nunito or Poppins from Google Fonts, rounded corners (20px+), multiple accent colors, colorful cards, bouncy hover effects, energetic startup feel.' },
    custom_1: { name: 'Custom Design 1',     guide: customPrompt || 'Modern clean design.' },
    custom_2: { name: 'Custom Design 2',     guide: customPrompt || 'Modern clean design.' },
    custom_3: { name: 'Custom Design 3',     guide: customPrompt || 'Modern clean design.' },
    // legacy key kept for backwards compat
    custom:   { name: 'Custom Design',       guide: customPrompt || 'Modern clean design.' },
  };

  const sg = styleGuides[style] || styleGuides.minimal;

  const frameworkInstructions = {
    html: {
      ext: 'html',
      label: 'HTML/CSS/JS',
      instruction: `Return a single complete HTML file with all CSS in a <style> tag and all JS in a <script> tag. No external CSS frameworks. Include Google Fonts <link> in <head>. Start with <!DOCTYPE html>.`,
    },
    react: {
      ext: 'jsx',
      label: 'React (JSX)',
      instruction: `Return a single React component file. Use inline styles or a <style> tag via a useEffect. Import React at top. Export default App component. Use useState/useEffect where needed. No external CSS imports. Include Google Fonts via a <link> injected in useEffect. All content in one file.`,
    },
    nextjs: {
      ext: 'jsx',
      label: 'Next.js',
      instruction: `Return a Next.js page component. Use 'use client' at top. Import Head from next/head for Google Fonts. Export default function Page(). Use React hooks where needed. All styles in a <style jsx> tag or inline styles. Single file with all content.`,
    },
    angular: {
      ext: 'ts',
      label: 'Angular',
      instruction: `Return a single Angular standalone component file. Use @Component decorator with template and styles inline. Import CommonModule. Export the component as default. Use standalone: true. All content in the template string. Include Google Fonts in the styles array.`,
    },
    vue: {
      ext: 'vue',
      label: 'Vue.js',
      instruction: `Return a single Vue 3 SFC (.vue file). Use <template>, <script setup>, and <style scoped> sections. Use Composition API. Include Google Fonts in a <link> injected via onMounted. All content in one file.`,
    },
  };

  const fw = frameworkInstructions[framework] || frameworkInstructions.html;

  const contentRules = `
ABSOLUTE CONTENT RULES:
1. INCLUDE EVERY SINGLE ITEM from the content reference below
2. Copy ALL text VERBATIM — do not change a single word
3. Include ALL ${content.allListItems.length} list items — not just some of them
4. Include ALL ${content.badges.length} badges/tags/tech stack items — every single one
5. Include ALL ${content.sections.length} sections — do not skip any section
6. Include ALL ${content.paras.length} paragraphs
7. Do NOT add Lorem ipsum or any invented text
8. Do NOT remove ANY content
9. Only change: colors, fonts, layout, spacing, animations — NEVER the text content

${contentRef}

TECHNICAL REQUIREMENTS:
- Fully responsive with mobile breakpoints
- Sticky navigation, smooth scroll
- CSS animations: fade-in on load, scroll-reveal, hover effects
- All sections present with ALL their content
- For images: use CSS gradient placeholders — no broken img tags`;

  const isCustomStyle = style.startsWith('custom');
  const styleBlock = `STYLE: ${sg.name}
STYLE GUIDE: ${sg.guide}
${isCustomStyle ? `USER CUSTOM INSTRUCTIONS: ${customPrompt}` : ''}`;

  const cleanCode = text => {
    let t = text.trim();
    t = t.replace(/^```[\w]*\n?/gm, '').replace(/\n?```/gm, '').trim();
    return t;
  };

  const isValidHtml = text => text.includes('<!DOCTYPE') || text.includes('<html');

  // ── Generate plain HTML (used for both preview AND download) ─────────────
  const htmlPrompt = `You are a frontend developer. Generate a complete HTML website redesign.

CRITICAL OUTPUT FORMAT:
- Start with exactly: <!DOCTYPE html>
- Plain HTML/CSS/JS only — NO React, NO JSX, NO Vue, NO Angular
- NO import or export statements
- All CSS in a <style> tag in <head>
- All JS in a <script> tag before </body>
- Include Google Fonts via <link> in <head>

CRITICAL CONTENT RULES:
- Use the EXACT text values from the content reference below
- Do NOT include any labels, brackets, numbers or markers in your HTML output
- Do NOT write things like "[H1-1]", "(paragraph)", "[BTN7]", "[TAG1]" — these are instructions for you, not content
- Output only the clean text: e.g. write "Nandini Raj" not "[H1-1] Nandini Raj"
- Do NOT output any reference markers whatsoever in the final HTML

${styleBlock}

${contentRules}

FINAL REMINDER: The HTML page must show clean readable text with NO labels, NO brackets, NO reference numbers.
Start your response with: <!DOCTYPE html>`;

  console.log('[Redesigner] Generating HTML preview for style:', style);
  let htmlResult = await model.generateContent(htmlPrompt);
  let previewHtml = cleanCode(htmlResult.response.text());

  // Extract from DOCTYPE if there's prefix text
  const doctypeIdx = previewHtml.indexOf('<!DOCTYPE');
  const htmlTagIdx = previewHtml.indexOf('<html');
  const startIdx = doctypeIdx > -1 ? doctypeIdx : (htmlTagIdx > -1 ? htmlTagIdx : -1);
  if (startIdx > 0) previewHtml = previewHtml.slice(startIdx);

  // If still not valid HTML, retry once
  if (!isValidHtml(previewHtml)) {
    console.warn('[Redesigner] Invalid HTML, retrying...');
    htmlResult = await model.generateContent(htmlPrompt);
    previewHtml = cleanCode(htmlResult.response.text());
    const idx2 = previewHtml.indexOf('<!DOCTYPE');
    if (idx2 > -1) previewHtml = previewHtml.slice(idx2);
  }

  // Absolute fallback
  if (!isValidHtml(previewHtml)) {
    previewHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preview</title><style>body{margin:0;font-family:sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:1rem;}</style></head><body><h2 style="color:#6366f1">Preview loading failed</h2><p style="opacity:0.5">Please try again</p></body></html>`;
  }

  console.log('[Redesigner] HTML preview ready, length:', previewHtml.length);

  // ── Framework code = HTML with a comment header explaining usage ──────────
  // We skip live conversion to avoid timeouts. User downloads HTML and can
  // copy-paste into their framework or use an online converter.
  const frameworkNotes = {
    html:    '',
    react:   `/* To use in React:\n   1. Create a new .jsx file\n   2. Paste the HTML structure into JSX (convert class → className, style strings → objects)\n   3. Or use dangerouslySetInnerHTML to embed this HTML directly\n   4. Recommended: use https://transform.tools/html-to-jsx to convert automatically\n*/\n\n`,
    nextjs:  `/* To use in Next.js:\n   1. Create app/page.jsx or pages/index.jsx\n   2. Paste the HTML into a component with dangerouslySetInnerHTML\n   3. Or convert to JSX using https://transform.tools/html-to-jsx\n   4. Move <style> contents to a .module.css file\n*/\n\n`,
    vue:     `<!-- To use in Vue.js:\n  1. Create a .vue file\n  2. Paste HTML into <template>, CSS into <style scoped>\n  3. Or use this HTML directly via v-html directive\n  4. Recommended: https://transform.tools/ for conversion\n-->\n\n`,
    angular: `/* To use in Angular:\n   1. Paste HTML into component template\n   2. Move CSS into component styles array\n   3. Replace class attributes (no changes needed for Angular)\n   4. Or use [innerHTML] binding to embed directly\n*/\n\n`,
  };

  const note = frameworkNotes[framework] || '';
  const frameworkCode = note + previewHtml;

  return {
    style,
    styleName: sg.name,
    framework,
    frameworkLabel: fw.label,
    ext: framework === 'html' ? 'html' : 'html', // always html for now
    code: frameworkCode,
    previewHtml,
  };
}

// ── Fallback HTML generator (no Gemini) ──────────────────────────────────
function generateFallbackHTML(content, style, url) {
  const styleConfigs = {
    minimal: {
      name: 'Minimal & Clean',
      font: 'DM Sans',
      fontUrl: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap',
      bg: '#ffffff', text: '#111111', accent: '#2563EB', navBg: '#ffffff',
      navBorder: '#e5e7eb', cardBg: '#f9fafb', badgeBg: '#dbeafe', badgeText: '#1d4ed8',
      btnBg: '#2563EB', btnText: '#ffffff', sectionBg: '#f9fafb', footerBg: '#111111', footerText: '#ffffff',
    },
    bold: {
      name: 'Bold & Dark',
      font: 'Syne',
      fontUrl: 'https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&display=swap',
      bg: '#0a0a0f', text: '#ffffff', accent: '#3b82f6', navBg: '#0a0a0f',
      navBorder: '#1e1e2e', cardBg: '#13131f', badgeBg: '#1e3a8a', badgeText: '#93c5fd',
      btnBg: '#3b82f6', btnText: '#ffffff', sectionBg: '#0d0d18', footerBg: '#050508', footerText: '#9ca3af',
    },
    colorful: {
      name: 'Colorful & Vibrant',
      font: 'Poppins',
      fontUrl: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap',
      bg: '#fdf4ff', text: '#1e1b4b', accent: '#7c3aed', navBg: '#ffffff',
      navBorder: '#e9d5ff', cardBg: '#ffffff', badgeBg: '#ede9fe', badgeText: '#6d28d9',
      btnBg: '#7c3aed', btnText: '#ffffff', sectionBg: '#faf5ff', footerBg: '#1e1b4b', footerText: '#e0e7ff',
    },
    custom: {
      name: 'Custom Design',
      font: 'Playfair Display',
      fontUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
      bg: '#0f172a', text: '#f8fafc', accent: '#f59e0b', navBg: '#0f172a',
      navBorder: '#1e293b', cardBg: '#1e293b', badgeBg: '#451a03', badgeText: '#fcd34d',
      btnBg: '#f59e0b', btnText: '#0f172a', sectionBg: '#1e293b', footerBg: '#020617', footerText: '#94a3b8',
    },
    custom_1: {
      name: 'Custom Design 1',
      font: 'Playfair Display',
      fontUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
      bg: '#0f172a', text: '#f8fafc', accent: '#f59e0b', navBg: '#0f172a',
      navBorder: '#1e293b', cardBg: '#1e293b', badgeBg: '#451a03', badgeText: '#fcd34d',
      btnBg: '#f59e0b', btnText: '#0f172a', sectionBg: '#1e293b', footerBg: '#020617', footerText: '#94a3b8',
    },
    custom_2: {
      name: 'Custom Design 2',
      font: 'Inter',
      fontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap',
      bg: '#f0fdf4', text: '#14532d', accent: '#16a34a', navBg: '#ffffff',
      navBorder: '#bbf7d0', cardBg: '#dcfce7', badgeBg: '#bbf7d0', badgeText: '#166534',
      btnBg: '#16a34a', btnText: '#ffffff', sectionBg: '#f0fdf4', footerBg: '#14532d', footerText: '#bbf7d0',
    },
    custom_3: {
      name: 'Custom Design 3',
      font: 'Space Grotesk',
      fontUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap',
      bg: '#fafaf9', text: '#1c1917', accent: '#dc2626', navBg: '#fafaf9',
      navBorder: '#e7e5e4', cardBg: '#f5f5f4', badgeBg: '#fee2e2', badgeText: '#991b1b',
      btnBg: '#dc2626', btnText: '#ffffff', sectionBg: '#f5f5f4', footerBg: '#1c1917', footerText: '#a8a29e',
    },
  };

  const s = styleConfigs[style] || styleConfigs.minimal;
  const title = content.title || new URL(url).hostname;
  const logoText = content.logoText || title;
  const navLinks = content.navLinks.slice(0, 8);
  const h1 = content.h1s[0] || title;
  const heroPara = content.paras[0] || '';

  const navLinksHtml = navLinks.map(n =>
    `<a href="${n.href || '#'}" style="color:${s.text};text-decoration:none;font-weight:500;opacity:0.85;transition:opacity 0.2s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.85">${n.text}</a>`
  ).join('');

  const badgesHtml = content.badges.slice(0, 40).map(b =>
    `<span style="background:${s.badgeBg};color:${s.badgeText};padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;display:inline-block;margin:4px">${b}</span>`
  ).join('');

  const ctasHtml = content.ctas.slice(0, 4).map((c, i) =>
    `<a href="#" style="display:inline-block;padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;margin:6px;background:${i === 0 ? s.btnBg : 'transparent'};color:${i === 0 ? s.btnText : s.accent};border:2px solid ${s.accent};transition:opacity 0.2s" onmouseover="this.style.opacity=0.85" onmouseout="this.style.opacity=1">${c}</a>`
  ).join('');

  const sectionsHtml = content.sections.slice(0, 10).map((sec, idx) => {
    const heading = sec.headings[0] || '';
    const texts = sec.texts.map(t => `<p style="color:${s.text};opacity:0.8;line-height:1.8;margin-bottom:12px">${t}</p>`).join('');
    const items = sec.items.length > 0
      ? `<ul style="padding-left:20px;margin-top:12px">${sec.items.map(li => `<li style="color:${s.text};opacity:0.8;margin-bottom:8px;line-height:1.6">${li}</li>`).join('')}</ul>`
      : '';
    const tags = sec.tags.length > 0
      ? `<div style="margin-top:12px">${sec.tags.map(t => `<span style="background:${s.badgeBg};color:${s.badgeText};padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;display:inline-block;margin:3px">${t}</span>`).join('')}</div>`
      : '';
    if (!heading && !texts && !items) return '';
    return `
    <section style="padding:60px 0;background:${idx % 2 === 0 ? s.bg : s.sectionBg};animation:fadeIn 0.6s ease-out ${idx * 0.1}s both">
      <div style="max-width:900px;margin:0 auto;padding:0 24px">
        ${heading ? `<h2 style="font-size:clamp(24px,4vw,38px);font-weight:700;color:${s.accent};margin-bottom:20px">${heading}</h2>` : ''}
        ${texts}${items}${tags}
      </div>
    </section>`;
  }).join('');

  const footerLinksHtml = content.footer.links.slice(0, 6).map(l =>
    `<a href="#" style="color:${s.footerText};opacity:0.7;text-decoration:none;margin:0 12px;font-size:14px">${l}</a>`
  ).join('');

  const allListItemsHtml = content.allListItems.length > 0
    ? `<section style="padding:60px 0;background:${s.sectionBg}">
        <div style="max-width:900px;margin:0 auto;padding:0 24px">
          <ul style="columns:2;padding-left:20px">${content.allListItems.slice(0, 30).map(li =>
            `<li style="color:${s.text};opacity:0.8;margin-bottom:8px;line-height:1.6;break-inside:avoid">${li}</li>`
          ).join('')}</ul>
        </div>
       </section>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="${s.fontUrl}" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{font-family:'${s.font}',sans-serif;background:${s.bg};color:${s.text};line-height:1.6}
  @keyframes fadeIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  nav a:hover{opacity:1!important}
  @media(max-width:768px){.nav-links{display:none}.hero-title{font-size:32px!important}}
</style>
</head>
<body>
<!-- NAV -->
<nav style="position:sticky;top:0;z-index:100;background:${s.navBg};border-bottom:1px solid ${s.navBorder};padding:16px 24px;display:flex;align-items:center;justify-content:space-between;backdrop-filter:blur(10px)">
  <span style="font-weight:800;font-size:20px;color:${s.accent}">${logoText}</span>
  <div class="nav-links" style="display:flex;gap:28px">${navLinksHtml}</div>
</nav>

<!-- HERO -->
<section style="padding:100px 24px 80px;text-align:center;animation:fadeIn 0.7s ease-out both">
  <div style="max-width:800px;margin:0 auto">
    <h1 class="hero-title" style="font-size:clamp(36px,6vw,64px);font-weight:800;line-height:1.15;margin-bottom:24px;color:${s.text}">${h1}</h1>
    ${heroPara ? `<p style="font-size:18px;opacity:0.75;max-width:600px;margin:0 auto 36px;line-height:1.8">${heroPara}</p>` : ''}
    <div>${ctasHtml}</div>
  </div>
</section>

${sectionsHtml}

${badgesHtml ? `<section style="padding:60px 0;background:${s.sectionBg}">
  <div style="max-width:900px;margin:0 auto;padding:0 24px;text-align:center">
    <h2 style="font-size:28px;font-weight:700;color:${s.accent};margin-bottom:24px">Skills & Technologies</h2>
    <div>${badgesHtml}</div>
  </div>
</section>` : ''}

${allListItemsHtml}

<!-- FOOTER -->
<footer style="background:${s.footerBg};color:${s.footerText};padding:40px 24px;text-align:center">
  ${content.footer.texts.length > 0 ? `<p style="opacity:0.7;margin-bottom:12px">${content.footer.texts[0]}</p>` : ''}
  <div>${footerLinksHtml}</div>
  <p style="margin-top:20px;opacity:0.4;font-size:13px">© ${new Date().getFullYear()} ${logoText}</p>
</footer>

<script>
  document.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener('click',e=>{
      const t=document.querySelector(a.getAttribute('href'));
      if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth'})}
    });
  });
</script>
</body>
</html>`;

  return {
    style,
    styleName: s.name + ' (Fallback)',
    framework: 'html',
    frameworkLabel: 'HTML',
    ext: 'html',
    code: html,
    previewHtml: html,
  };
}

// ── Main controller (SSE streaming) ───────────────────────────────────────
const redesignWebsite = async (req, res) => {
  const {
    websiteUrl,
    selectedStyles = ['minimal', 'bold', 'colorful'],
    customPrompts  = [],
    framework      = 'html',
  } = req.body;

  if (!websiteUrl || !websiteUrl.startsWith('http')) {
    return res.status(400).json({ success: false, message: 'Valid website URL is required.' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('status', { message: 'Scraping website content…' });
    console.log('[Redesigner] Scraping:', websiteUrl);

    const [screenshotBase64, content] = await Promise.all([
      screenshotWebsite(websiteUrl),
      scrapePageContent(websiteUrl),
    ]);

    console.log(`[Redesigner] Scraped — H1:${content.h1s.length} H2:${content.h2s.length} P:${content.paras.length} LI:${content.allListItems.length} Tags:${content.badges.length} Sections:${content.sections.length}`);

    const stats = {
      headings: content.h1s.length + content.h2s.length + content.h3s.length,
      paragraphs: content.paras.length,
      listItems: content.allListItems.length,
      tags: content.badges.length,
      sections: content.sections.length,
    };

    // Send meta immediately so frontend can show header
    send('meta', { pageTitle: content.title, screenshotBase64, stats, websiteUrl });

    // Build a list of { styleKey, customPrompt } entries to process
    const stylesList = [
      ...selectedStyles.map(s => ({ styleKey: s, prompt: null })),
      ...customPrompts
        .map((p, i) => ({ styleKey: `custom_${i + 1}`, prompt: p }))
        .filter(e => e.prompt && e.prompt.trim().length > 5),
    ];

    const styleDisplayNames = {
      minimal:  'Minimal & Clean',
      bold:     'Bold & Dark',
      colorful: 'Colorful & Vibrant',
      custom_1: 'Custom Design 1',
      custom_2: 'Custom Design 2',
      custom_3: 'Custom Design 3',
    };

    for (const { styleKey, prompt } of stylesList) {
      const displayName = styleDisplayNames[styleKey] || styleKey;
      send('status', { message: `Generating ${displayName} design…` });
      console.log(`[Redesigner] Generating style: ${styleKey}`);

      let design;
      try {
        design = await generateHTML(content, styleKey, websiteUrl, prompt, framework);
      } catch (geminiErr) {
        console.warn(`[Redesigner] Gemini failed for ${styleKey}, using fallback:`, geminiErr.message);
        send('status', { message: `Gemini unavailable for ${displayName} — using template fallback…` });
        design = generateFallbackHTML(content, styleKey, websiteUrl);
      }

      console.log(`[Redesigner] Done: ${styleKey}`);
      send('design', { design });
    }

    send('done', { success: true });
    console.log('[Redesigner] All designs complete.');
    res.end();

  } catch (error) {
    console.error('[Redesigner] Fatal error:', error.message);
    send('error', { message: error.message });
    res.end();
  }
};

module.exports = { redesignWebsite };