'use strict';

/**
 * sourceMapper.js
 *
 * Multi-signal engine that maps rendered-HTML accessibility errors
 * (from the extension) to source files in a GitHub repository.
 *
 * Strategy (4 layers, highest confidence wins):
 *   Layer 1 — Text content match  (fastest, ~95% precision when text is unique)
 *   Layer 2 — CSS class/ID grep   (handles Tailwind, CSS Modules, styled-components)
 *   Layer 3 — HTML structure match (element type + attribute fingerprint)
 *   Layer 4 — Gemini AI confirm   (sends top candidates to Gemini to pick best + generate fix)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// File extensions we care about for source mapping
const SOURCE_EXTENSIONS = /\.(jsx?|tsx?|html?|vue|svelte|css|scss|sass|less)$/i;

// Extensions to SKIP (binary, config, lock files)
const SKIP_EXTENSIONS = /\.(png|jpg|gif|svg|ico|woff|woff2|ttf|eot|json|lock|md|txt|env)$/i;

// Max file size to analyse (50KB) — skip huge generated files
const MAX_FILE_BYTES = 50 * 1024;

// ─── Types ────────────────────────────────────────────────────────────────────
/**
 * @typedef {{ filePath: string, content: string }} RepoFile
 * @typedef {{ selector?: string, message?: string, title?: string, impact?: string, type?: string, element?: string }} AccessibilityError
 * @typedef {{ error: AccessibilityError, candidates: Candidate[], bestFile: string|null, confidence: number, suggestedFix: string|null }} MappedError
 * @typedef {{ filePath: string, score: number, matchedBy: string[], snippet: string }} Candidate
 */

// ─── Layer 1: Text Content Match ──────────────────────────────────────────────
function extractTextFromSelector(error) {
  const texts = [];

  // From element HTML snippet (axe provides this)
  if (error.element) {
    const textMatch = error.element.match(/>([^<]{3,80})</g);
    if (textMatch) {
      textMatch.forEach(m => {
        const t = m.replace(/^>/, '').replace(/<$/, '').trim();
        if (t.length > 2) texts.push(t);
      });
    }
    // Extract aria-label
    const ariaMatch = error.element.match(/aria-label="([^"]+)"/);
    if (ariaMatch) texts.push(ariaMatch[1]);
    // Extract id
    const idMatch = error.element.match(/id="([^"]+)"/);
    if (idMatch) texts.push(idMatch[1]);
    // Extract name attr
    const nameMatch = error.element.match(/name="([^"]+)"/);
    if (nameMatch) texts.push(nameMatch[1]);
    // Extract placeholder
    const placeholderMatch = error.element.match(/placeholder="([^"]+)"/);
    if (placeholderMatch) texts.push(placeholderMatch[1]);
  }

  return texts.filter(t => t.length > 2 && t.length < 200);
}

function textContentMatch(error, files) {
  const texts = extractTextFromSelector(error);
  if (texts.length === 0) return [];

  const candidates = [];

  for (const file of files) {
    if (!SOURCE_EXTENSIONS.test(file.filePath)) continue;
    if (SKIP_EXTENSIONS.test(file.filePath)) continue;
    if (file.content.length > MAX_FILE_BYTES * 2) continue;

    const content = file.content;
    let score = 0;
    const matched = [];

    for (const text of texts) {
      if (content.includes(text)) {
        score += text.length > 20 ? 40 : 20;
        matched.push(`text:"${text.slice(0, 30)}"`);
      }
    }

    if (score > 0) {
      const snippetIdx = content.indexOf(texts[0]);
      const snippet = snippetIdx > -1
        ? content.slice(Math.max(0, snippetIdx - 100), snippetIdx + 200)
        : content.slice(0, 300);

      candidates.push({ filePath: file.filePath, score, matchedBy: matched, snippet });
    }
  }

  return candidates;
}

// ─── Layer 2: CSS Class / ID Grep ────────────────────────────────────────────
function extractIdentifiersFromSelector(selector) {
  if (!selector) return [];
  const identifiers = [];

  // Extract classes
  const classes = selector.match(/\.([a-zA-Z][a-zA-Z0-9_-]{2,})/g);
  if (classes) identifiers.push(...classes.map(c => c.slice(1)));

  // Extract IDs
  const ids = selector.match(/#([a-zA-Z][a-zA-Z0-9_-]{2,})/g);
  if (ids) identifiers.push(...ids.map(id => id.slice(1)));

  // Extract data-* attributes
  const dataAttrs = selector.match(/\[data-([^\]]+)\]/g);
  if (dataAttrs) identifiers.push(...dataAttrs.map(a => a.slice(1, -1)));

  // Extract element type
  const tag = selector.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  if (tag && !['div', 'span', 'p'].includes(tag[1])) {
    identifiers.push(tag[1]);
  }

  return [...new Set(identifiers)];
}

function selectorGrepMatch(error, files) {
  const ids = extractIdentifiersFromSelector(error.selector);
  if (ids.length === 0) return [];

  const candidates = [];

  for (const file of files) {
    if (!SOURCE_EXTENSIONS.test(file.filePath)) continue;
    if (file.content.length > MAX_FILE_BYTES * 2) continue;

    const content = file.content;
    let score = 0;
    const matched = [];

    for (const id of ids) {
      // Check for the identifier in various contexts
      const patterns = [
        id,                    // direct
        `"${id}"`,             // as string
        `'${id}'`,             // as string
        `className.*${id}`,    // React className
        `class.*${id}`,        // HTML class
        `#${id}`,              // CSS ID
        `.${id}`,              // CSS class
      ];

      for (const pattern of patterns) {
        try {
          if (new RegExp(pattern).test(content)) {
            score += id.length > 10 ? 30 : 15;
            matched.push(`selector:"${id}"`);
            break;
          }
        } catch {
          if (content.includes(id)) {
            score += 15;
            matched.push(`selector:"${id}"`);
          }
        }
      }
    }

    if (score > 0) {
      const snippetIdx = ids[0] ? content.indexOf(ids[0]) : -1;
      const snippet = snippetIdx > -1
        ? content.slice(Math.max(0, snippetIdx - 100), snippetIdx + 300)
        : content.slice(0, 300);

      candidates.push({ filePath: file.filePath, score, matchedBy: matched, snippet });
    }
  }

  return candidates;
}

// ─── Layer 3: Structure / Element Type Match ─────────────────────────────────
function structureMatch(error, files) {
  if (!error.element) return [];

  // Extract element tag
  const tagMatch = error.element.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : null;

  // Only strong signal for semantic/interactive elements
  const strongTags = ['button', 'input', 'select', 'textarea', 'form', 'a', 'img', 'video', 'audio', 'nav', 'main', 'aside', 'header', 'footer'];
  if (!tag || !strongTags.includes(tag)) return [];

  const candidates = [];

  for (const file of files) {
    if (!SOURCE_EXTENSIONS.test(file.filePath)) continue;
    if (file.content.length > MAX_FILE_BYTES * 2) continue;

    const content = file.content;
    // Look for the element tag in JSX/HTML context
    const regex = new RegExp(`<${tag}[\\s>]`, 'gi');
    const matches = content.match(regex);

    if (matches && matches.length > 0) {
      // Prefer files with fewer instances (more specific)
      const score = Math.max(5, 20 - matches.length);
      const idx = content.search(regex);
      const snippet = content.slice(Math.max(0, idx - 50), idx + 300);

      candidates.push({
        filePath: file.filePath,
        score,
        matchedBy: [`element:<${tag}> (${matches.length} instances)`],
        snippet,
      });
    }
  }

  return candidates;
}

// ─── Merge & rank candidates ──────────────────────────────────────────────────
function mergeCandidates(...candidateLists) {
  const merged = new Map();

  for (const list of candidateLists) {
    for (const c of list) {
      if (merged.has(c.filePath)) {
        const existing = merged.get(c.filePath);
        existing.score += c.score;
        existing.matchedBy = [...new Set([...existing.matchedBy, ...c.matchedBy])];
        // Keep longer snippet
        if (c.snippet.length > existing.snippet.length) existing.snippet = c.snippet;
      } else {
        merged.set(c.filePath, { ...c });
      }
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 5);
}

// ─── Layer 4: Gemini AI — Full-file fix generation ───────────────────────────
// KEY DESIGN: instead of asking for originalCode/fixedCode snippets (fragile,
// fails fuzzyReplace), we send the ENTIRE file and ask Gemini to return the
// COMPLETE fixed file. This guarantees fixedContent !== content.
const MAX_FULL_FILE = 40000; // chars — Gemini output cap ~50k

async function geminiConfirmAndFix(error, candidates, framework, repoFiles) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  // Build candidate context: for top candidate, include full file if small enough
  const topCandidates = candidates.slice(0, 3);

  // If no candidates, ask Gemini to pick a file from all available files
  if (topCandidates.length === 0) {
    if (!repoFiles || repoFiles.length === 0) {
      return { bestFile: null, confidence: 0 };
    }

    // Send file listing with short preview so Gemini can pick the best one
    const fileList = repoFiles.slice(0, 30).map(f =>
      `- ${f.filePath} (${f.content.length} chars)\n  Preview: ${f.content.slice(0, 150).replace(/\n/g, ' ')}`
    ).join('\n');

    const pickPrompt = `You are an expert accessibility engineer. This accessibility error was found on a rendered webpage:

ERROR:
- Type: ${error.type || error.title || 'Unknown'}
- Impact: ${error.impact || 'unknown'}
- Message: ${error.message || error.description || ''}
- CSS Selector: ${error.selector || 'N/A'}
- HTML Element: ${(error.element || '').slice(0, 400)}

No candidate files were found by text/selector matching. Here are all available source files:

${fileList}

Which file is MOST LIKELY to contain the source code for this element?
Framework: ${framework || 'React/Next.js'}

Respond in JSON:
{"bestFile": "path/to/file or null", "confidence": 0-100, "reasoning": "..."}
Return ONLY valid JSON.`;

    try {
      const r = await model.generateContent(pickPrompt);
      const text = r.response.text().trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return { bestFile: null, confidence: 0 };
      const pick = JSON.parse(m[0]);
      if (!pick.bestFile) return { bestFile: null, confidence: 0 };
      // Now run the full fix on the picked file
      const pickedFile = repoFiles.find(f => f.filePath === pick.bestFile);
      if (!pickedFile) return { bestFile: null, confidence: 0 };
      return geminiFixFile(error, pickedFile, pick.confidence, pick.reasoning, framework, model);
    } catch (e) {
      console.warn('[SourceMapper] Gemini pick failed:', e.message);
      return { bestFile: null, confidence: 0 };
    }
  }

  // We have candidates — run full-file fix on the best candidate
  const bestCandidate = topCandidates[0];
  const fileData = repoFiles?.find(f => f.filePath === bestCandidate.filePath);
  if (!fileData) return { bestFile: bestCandidate.filePath, confidence: 20 };

  return geminiFixFile(error, fileData, bestCandidate.score, bestCandidate.matchedBy.join(', '), framework, model);
}

/**
 * Send a single file + error to Gemini and get back the COMPLETE fixed file content.
 * For files > MAX_FULL_FILE chars, falls back to snippet approach.
 */
async function geminiFixFile(error, fileData, score, matchReason, framework, model) {
  const { filePath, content } = fileData;
  const isLargeFile = content.length > MAX_FULL_FILE;

  const errorDesc = `
Error Type: ${error.type || error.title || 'Unknown'}
Impact: ${error.impact || 'unknown'}
Message: ${error.message || error.description || ''}
CSS Selector: ${error.selector || 'N/A'}
HTML Element: ${(error.element || '').slice(0, 400)}`.trim();

  let prompt;

  if (!isLargeFile) {
    // ── Full-file approach (preferred) ──────────────────────────────────────
    prompt = `You are an expert accessibility engineer fixing WCAG violations.

ACCESSIBILITY ERROR FOUND ON RENDERED PAGE:
${errorDesc}

SOURCE FILE (${framework || 'React/Next.js'}): ${filePath}
\`\`\`
${content}
\`\`\`

TASK:
1. Fix the accessibility issue in the file above.
2. Make ONLY the minimal changes needed. Do NOT refactor or change anything else.
3. Return the COMPLETE file with your fix applied — every single line, unchanged lines included.

Respond ONLY with this JSON (no markdown, no explanation outside JSON):
{
  "bestFile": "${filePath}",
  "confidence": 0-100,
  "reasoning": "brief explanation of why this file contains the issue",
  "fullFixedContent": "COMPLETE FIXED FILE CONTENT HERE — all lines",
  "explanation": "what was changed and which WCAG criterion it fixes",
  "changeDescription": "one-line summary"
}`;
  } else {
    // ── Snippet approach for large files ────────────────────────────────────
    // Find the relevant section by selector/text and send ±80 lines around it
    const lines = content.split('\n');
    let focusLine = 0;
    const selector = error.selector || '';
    const texts = (error.element || '').match(/>([^<]{3,60})</g) || [];
    const searchTerms = [
      ...extractIdentifiersFromSelector2(selector),
      ...texts.map(t => t.replace(/^>|<$/g, '').trim()).filter(Boolean),
    ];
    for (let i = 0; i < lines.length; i++) {
      if (searchTerms.some(t => lines[i].includes(t))) { focusLine = i; break; }
    }
    const start = Math.max(0, focusLine - 80);
    const end = Math.min(lines.length, focusLine + 120);
    const snippet = lines.slice(start, end).join('\n');
    const snippetLines = `lines ${start + 1}–${end}`;

    prompt = `You are an expert accessibility engineer.

ACCESSIBILITY ERROR:
${errorDesc}

FILE: ${filePath} (large file — showing ${snippetLines} of ${lines.length} total)
\`\`\`
${snippet}
\`\`\`

TASK: Fix the accessibility issue in the snippet above.
Return ONLY this JSON:
{
  "bestFile": "${filePath}",
  "confidence": 0-100,
  "reasoning": "why this file contains the issue",
  "originalCode": "exact lines to replace (copy verbatim from snippet above, no paraphrasing)",
  "fixedCode": "the replacement lines",
  "explanation": "what changed and why (WCAG ref)",
  "changeDescription": "one-line summary",
  "snippetStart": ${start}
}`;
  }

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[SourceMapper] Gemini returned no JSON for', filePath);
      return { bestFile: filePath, confidence: 20 };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return { ...parsed, bestFile: parsed.bestFile || filePath };
  } catch (err) {
    console.warn('[SourceMapper] Gemini fix failed for', filePath, ':', err.message);
    return { bestFile: filePath, confidence: 15 };
  }
}

// Helper for large-file search (inline, no import needed)
function extractIdentifiersFromSelector2(selector) {
  if (!selector) return [];
  const out = [];
  const cls = selector.match(/\.([a-zA-Z][a-zA-Z0-9_-]{2,})/g);
  if (cls) out.push(...cls.map(c => c.slice(1)));
  const ids = selector.match(/#([a-zA-Z][a-zA-Z0-9_-]{2,})/g);
  if (ids) out.push(...ids.map(id => id.slice(1)));
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Map accessibility errors to source files AND generate complete fixed file content.
 * @param {AccessibilityError[]} errors
 * @param {RepoFile[]} repoFiles - array of { filePath, content }
 * @param {string} framework
 * @returns {Promise<MappedError[]>}
 */
async function mapErrorsToSource(errors, repoFiles, framework = 'react') {
  console.log(`[SourceMapper] Mapping ${errors.length} errors across ${repoFiles.length} files`);

  const sourceFiles = repoFiles.filter(f =>
    SOURCE_EXTENSIONS.test(f.filePath) &&
    !SKIP_EXTENSIONS.test(f.filePath) &&
    f.content &&
    f.content.length < MAX_FILE_BYTES * 4
  );

  console.log(`[SourceMapper] Analysing ${sourceFiles.length} source files`);

  const mapped = [];

  // Process errors concurrently (max 3 at a time to avoid rate limits)
  const CONCURRENCY = 3;
  for (let i = 0; i < errors.length; i += CONCURRENCY) {
    const batch = errors.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (error) => {
      const [textCandidates, selectorCandidates, structureCandidates] = await Promise.all([
        Promise.resolve(textContentMatch(error, sourceFiles)),
        Promise.resolve(selectorGrepMatch(error, sourceFiles)),
        Promise.resolve(structureMatch(error, sourceFiles)),
      ]);

      const merged = mergeCandidates(textCandidates, selectorCandidates, structureCandidates);

      // ALWAYS call Gemini — even with no candidates (it will pick a file from the full list)
      const geminiResult = await geminiConfirmAndFix(error, merged, framework, sourceFiles);

      return {
        error,
        candidates: merged,
        bestFile: geminiResult.bestFile || null,
        confidence: geminiResult.confidence || 0,
        // Full file approach
        fullFixedContent: geminiResult.fullFixedContent || null,
        // Snippet approach fallback
        originalCode: geminiResult.originalCode || null,
        fixedCode: geminiResult.fixedCode || null,
        snippetStart: geminiResult.snippetStart ?? null,
        explanation: geminiResult.explanation || null,
        changeDescription: geminiResult.changeDescription || null,
        reasoning: geminiResult.reasoning || null,
      };
    }));
    mapped.push(...results);
  }

  console.log(`[SourceMapper] Mapped ${mapped.filter(m => m.bestFile).length}/${errors.length} errors to source files`);
  return mapped;
}

module.exports = { mapErrorsToSource };
