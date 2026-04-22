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

// ─── Layer 4: Gemini AI Confirmation + Fix Generation ────────────────────────
async function geminiConfirmAndFix(error, candidates, framework) {
  if (candidates.length === 0) return { bestFile: null, confidence: 0, suggestedFix: null };

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const candidateContext = candidates.slice(0, 3).map((c, i) => `
=== Candidate ${i + 1}: ${c.filePath} (score: ${c.score}) ===
Matched by: ${c.matchedBy.join(', ')}
Code snippet:
\`\`\`
${c.snippet.slice(0, 800)}
\`\`\`
`).join('\n');

  const prompt = `You are an expert accessibility engineer. An automated tool found this accessibility issue on a rendered webpage:

ACCESSIBILITY ERROR:
- Type: ${error.type || error.title || 'Unknown'}
- Impact: ${error.impact || 'unknown'}
- Message: ${error.message || error.description || ''}
- CSS Selector: ${error.selector || 'N/A'}
- Rendered Element: ${(error.element || '').slice(0, 300)}

I found these candidate source files that might contain the problematic element:

${candidateContext}

TASK:
1. Identify which candidate file (if any) contains the element causing this accessibility issue.
2. If found, generate the MINIMAL fix for the accessibility issue in that file.
3. The fix must not break any existing functionality.

Framework/tech stack hint: ${framework || 'React/Next.js'}

Respond in this exact JSON format:
{
  "bestFile": "path/to/file.tsx or null",
  "confidence": 0-100,
  "reasoning": "brief explanation",
  "originalCode": "the exact problematic code snippet",
  "fixedCode": "the fixed version with minimal changes",
  "explanation": "what was changed and why (WCAG reference)"
}

Return ONLY valid JSON.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { bestFile: candidates[0]?.filePath || null, confidence: 30, suggestedFix: null };
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn('[SourceMapper] Gemini confirm failed:', err.message);
    return {
      bestFile: candidates[0]?.filePath || null,
      confidence: 25,
      suggestedFix: null,
      reasoning: 'Gemini unavailable — top candidate used',
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Map accessibility errors to source files.
 * @param {AccessibilityError[]} errors
 * @param {RepoFile[]} repoFiles - array of { filePath, content }
 * @param {string} framework - 'react'|'nextjs'|'vue'|'html' etc.
 * @returns {Promise<MappedError[]>}
 */
async function mapErrorsToSource(errors, repoFiles, framework = 'react') {
  console.log(`[SourceMapper] Mapping ${errors.length} errors across ${repoFiles.length} files`);

  // Filter to only source files we can actually analyse
  const sourceFiles = repoFiles.filter(f =>
    SOURCE_EXTENSIONS.test(f.filePath) &&
    !SKIP_EXTENSIONS.test(f.filePath) &&
    f.content &&
    f.content.length < MAX_FILE_BYTES * 4
  );

  console.log(`[SourceMapper] Analysing ${sourceFiles.length} source files`);

  const mapped = [];

  for (const error of errors) {
    // Run all 3 local layers in parallel
    const [textCandidates, selectorCandidates, structureCandidates] = await Promise.all([
      Promise.resolve(textContentMatch(error, sourceFiles)),
      Promise.resolve(selectorGrepMatch(error, sourceFiles)),
      Promise.resolve(structureMatch(error, sourceFiles)),
    ]);

    const merged = mergeCandidates(textCandidates, selectorCandidates, structureCandidates);

    // Only call Gemini if we have at least one candidate
    let geminiResult = { bestFile: null, confidence: 0, suggestedFix: null };
    if (merged.length > 0) {
      geminiResult = await geminiConfirmAndFix(error, merged, framework);
    }

    mapped.push({
      error,
      candidates: merged,
      bestFile: geminiResult.bestFile,
      confidence: geminiResult.confidence || 0,
      originalCode: geminiResult.originalCode || null,
      fixedCode: geminiResult.fixedCode || null,
      explanation: geminiResult.explanation || null,
      reasoning: geminiResult.reasoning || null,
    });
  }

  console.log(`[SourceMapper] Mapped ${mapped.filter(m => m.bestFile).length}/${errors.length} errors to source files`);
  return mapped;
}

module.exports = { mapErrorsToSource };
