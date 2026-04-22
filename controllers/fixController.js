'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { mapErrorsToSource } = require('../services/sourceMapper');
const { getUserOctokit } = require('./githubController');
const FixSession = require('../models/fixSession');
const Scan = require('../models/scan');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Detect repo framework ────────────────────────────────────────────────────
function detectFramework(fileTree) {
  const paths = fileTree.map(f => f.path.toLowerCase());
  if (paths.some(p => p.includes('next.config'))) return 'nextjs';
  if (paths.some(p => p.includes('nuxt.config'))) return 'nuxt';
  if (paths.some(p => p.includes('vue.config') || p.endsWith('.vue'))) return 'vue';
  if (paths.some(p => p.includes('angular.json'))) return 'angular';
  if (paths.some(p => p.endsWith('.svelte'))) return 'svelte';
  if (paths.some(p => p.endsWith('.tsx') || p.endsWith('.jsx'))) return 'react';
  return 'html';
}

// ─── Select most relevant files to fetch (score by path) ─────────────────────
function selectFilesToFetch(fileTree, errors) {
  const scored = fileTree.map(f => {
    let score = 0;
    const p = f.path.toLowerCase();

    // Prefer component files
    if (p.includes('component')) score += 20;
    if (p.includes('page')) score += 15;
    if (p.includes('layout')) score += 15;
    if (p.includes('header') || p.includes('nav') || p.includes('footer')) score += 10;
    if (p.includes('form') || p.includes('button') || p.includes('input')) score += 10;

    // Prefer certain extensions
    if (p.endsWith('.tsx') || p.endsWith('.jsx')) score += 10;
    if (p.endsWith('.vue') || p.endsWith('.svelte')) score += 10;
    if (p.endsWith('.html')) score += 5;

    // Avoid test/story files
    if (p.includes('.test.') || p.includes('.spec.') || p.includes('.stories.')) score -= 30;

    // Smaller files are faster to process
    if (f.size && f.size < 10000) score += 5;

    return { ...f, score };
  });

  return scored
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40) // fetch max 40 files
    .map(f => f.path);
}

/**
 * Fuzzy string replace — normalizes whitespace before comparing.
 * Returns the replaced string, or the original if no match found.
 */
function fuzzyReplace(fileContent, originalCode, fixedCode) {
  // 1. Try exact match first
  if (fileContent.includes(originalCode)) {
    return fileContent.replace(originalCode, fixedCode);
  }

  // 2. Try trimmed lines match (handles indentation differences)
  const normalize = (s) => s.split('\n').map(l => l.trim()).filter(l => l).join('\n');
  const normalizedOriginal = normalize(originalCode);
  const lines = fileContent.split('\n');

  // Find the block of lines in the file that matches when normalized
  const origLines = originalCode.split('\n').map(l => l.trim()).filter(l => l);
  if (origLines.length === 0) return fileContent;

  for (let i = 0; i <= lines.length - origLines.length; i++) {
    const slice = lines.slice(i, i + origLines.length).map(l => l.trim()).filter(l => l);
    if (slice.join('\n') === origLines.join('\n')) {
      // Found the block — replace it preserving original indentation
      const indent = lines[i].match(/^(\s*)/)[1];
      const fixedLines = fixedCode.split('\n').map((l, idx) => idx === 0 ? l : indent + l.trim());
      const newLines = [...lines.slice(0, i), ...fixedLines, ...lines.slice(i + origLines.length)];
      console.log(`[fuzzyReplace] Matched at line ${i + 1} (normalized)`);
      return newLines.join('\n');
    }
  }

  console.warn('[fuzzyReplace] No match found — file left unchanged');
  return fileContent;
}


/**
 * POST /api/fixes/generate
 * Generate accessibility fixes for a scan using a GitHub repo
 */
const generateFixes = async (req, res) => {
  try {
    const { scanId, repoFullName, baseBranch, forceRefresh } = req.body;

    if (!scanId || !repoFullName) {
      return res.status(400).json({ success: false, message: 'scanId and repoFullName are required.' });
    }

    // Load scan
    const scan = await Scan.findOne({ _id: scanId, userId: req.user.uid });
    if (!scan) return res.status(404).json({ success: false, message: 'Scan not found.' });
    if (!scan.errors?.length) return res.status(400).json({ success: false, message: 'Scan has no errors to fix.' });

    // ── Cache check: return existing session if already generated ─────────────
    if (!forceRefresh) {
      const existing = await FixSession.findOne({
        userId: req.user.uid,
        scanId,
        repoFullName,
        status: { $in: ['review', 'pr_created'] },
        'mappedFiles.0': { $exists: true }, // must have at least 1 mapped file
      }).sort({ createdAt: -1 });

      if (existing) {
        console.log(`[FixController] Returning cached session ${existing._id}`);
        return res.json({
          success: true,
          sessionId: existing._id,
          cached: true,
          framework: existing.framework,
          totalErrors: scan.errors.length,
          mappedErrors: existing.totalFixesApplied,
          fixedErrors: existing.totalFixesApplied,
          filesChanged: existing.mappedFiles.length,
          mappedFiles: existing.mappedFiles.map(f => ({
            filePath: f.filePath,
            confidence: f.confidence,
            changesCount: f.changes.length,
            diff: f.diff,
            changes: f.changes,
            originalContent: f.content,
            fixedContent: f.fixedContent,
          })),
          unmappedErrors: [],
        });
      }
    }

    const [owner, repo] = repoFullName.split('/');
    const octokit = await getUserOctokit(req.user.uid);

    // Create fix session
    const session = await FixSession.create({
      userId: req.user.uid,
      scanId,
      scanType: 'accessibility',
      repoFullName,
      status: 'mapping',
    });


    // ── Step 1: Get repo file tree ─────────────────────────────────────────
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const branch = baseBranch || repoData.default_branch;

    const { data: tree } = await octokit.rest.git.getTree({
      owner, repo, tree_sha: branch, recursive: 'true',
    });

    const SOURCE_EXT = /\.(jsx?|tsx?|html?|vue|svelte|css|scss)$/i;
    const SKIP_DIRS = /(node_modules|\.git|\.next|dist|build|out)\//;
    const fileTree = tree.tree
      .filter(f => f.type === 'blob' && SOURCE_EXT.test(f.path) && !SKIP_DIRS.test(f.path))
      .map(f => ({ path: f.path, size: f.size }));

    const framework = detectFramework(fileTree);
    const filesToFetch = selectFilesToFetch(fileTree, scan.errors);

    // ── Step 2: Fetch file contents ────────────────────────────────────────
    const fileContents = await Promise.allSettled(
      filesToFetch.map(async (path) => {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
        return {
          filePath: path,
          content: Buffer.from(data.content, 'base64').toString('utf-8'),
          sha: data.sha,
        };
      })
    );

    const repoFiles = fileContents
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    // ── Step 3: Map errors to source files ────────────────────────────────
    await FixSession.findByIdAndUpdate(session._id, { status: 'generating' });

    const mappedErrors = await mapErrorsToSource(scan.errors, repoFiles, framework);

    // ── Step 4: Build per-file fix map ────────────────────────────────────
    const fileFixMap = new Map(); // filePath → { originalContent, fixes[] }

    for (const mapped of mappedErrors) {
      if (!mapped.bestFile) continue;
      const repoFile = repoFiles.find(f => f.filePath === mapped.bestFile);
      if (!repoFile) continue;

      if (!fileFixMap.has(mapped.bestFile)) {
        fileFixMap.set(mapped.bestFile, {
          filePath: mapped.bestFile,
          content: repoFile.content,
          fixedContent: repoFile.content,
          confidence: mapped.confidence,
          changes: [],
        });
      }

      const entry = fileFixMap.get(mapped.bestFile);

      // ── Primary path: Gemini returned the complete fixed file ──────────────
      if (mapped.fullFixedContent && mapped.fullFixedContent.trim().length > 50) {
        const prevLength = entry.fixedContent.length;
        entry.fixedContent = mapped.fullFixedContent;
        console.log(`[FixController] Full-file fix applied for ${mapped.bestFile} (${prevLength} → ${entry.fixedContent.length} chars)`);
        entry.changes.push({
          original: '[full file replacement]',
          fixed: '[full file replacement]',
          reason: mapped.explanation || mapped.changeDescription || mapped.error?.message || 'Accessibility fix',
        });
        entry.confidence = Math.max(entry.confidence, mapped.confidence || 70);
        continue;
      }

      // ── Fallback: snippet approach (large files) ───────────────────────────
      if (mapped.originalCode && mapped.fixedCode) {
        const before = entry.fixedContent;
        entry.fixedContent = fuzzyReplace(entry.fixedContent, mapped.originalCode, mapped.fixedCode);
        if (entry.fixedContent !== before) {
          console.log(`[FixController] Snippet fuzzyReplace succeeded for ${mapped.bestFile}`);
        } else {
          console.warn(`[FixController] fuzzyReplace had no effect for ${mapped.bestFile}`);
          console.warn('[FixController] originalCode snippet:', JSON.stringify(mapped.originalCode.slice(0, 80)));
        }
        entry.changes.push({
          original: mapped.originalCode,
          fixed: mapped.fixedCode,
          reason: mapped.explanation || mapped.error?.message || 'Accessibility fix',
        });
      }
    }

    const mappedFiles = [...fileFixMap.values()].map(f => ({
      ...f,
      diff: generateDiff(f.content, f.fixedContent, f.filePath),
    }));

    // ── Step 5: Update session ────────────────────────────────────────────
    await FixSession.findByIdAndUpdate(session._id, {
      status: 'review',
      mappedFiles,
      framework,
      repoDefaultBranch: branch,
      totalFilesChanged: mappedFiles.length,
      totalFixesApplied: mappedErrors.filter(m => m.bestFile && (m.fullFixedContent || m.fixedCode)).length,
    });

    return res.json({
      success: true,
      sessionId: session._id,
      framework,
      totalErrors: scan.errors.length,
      mappedErrors: mappedErrors.length,
      fixedErrors: mappedErrors.filter(m => m.bestFile && m.fixedCode).length,
      filesChanged: mappedFiles.length,
      mappedFiles: mappedFiles.map(f => ({
        filePath: f.filePath,
        confidence: f.confidence,
        changesCount: f.changes.length,
        diff: f.diff,
        changes: f.changes,
        originalContent: f.content,     // full original file for Monaco diff
        fixedContent: f.fixedContent,   // full fixed file for Monaco diff
      })),
      unmappedErrors: mappedErrors
        .filter(m => !m.bestFile)
        .map(m => ({ error: m.error, reason: 'Could not find in source files' })),
    });
  } catch (err) {
    console.error('[FixController] generateFixes:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/fixes/:sessionId/create-pr
 * Create GitHub branch, commit accepted fixes, open PR
 */
const createFixPR = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { acceptedFiles, branchName, prTitle, prBody } = req.body;

    const session = await FixSession.findOne({ _id: sessionId, userId: req.user.uid });
    if (!session) return res.status(404).json({ success: false, message: 'Fix session not found.' });

    const [owner, repo] = session.repoFullName.split('/');
    const octokit = await getUserOctokit(req.user.uid);

    const finalBranch = branchName ||
      `flowfinder/a11y-fixes-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;

    // Debug: log session state
    console.log('[createFixPR] session.mappedFiles:', session.mappedFiles.map(f => ({
      filePath: f.filePath,
      hasFixedContent: !!f.fixedContent,
      contentLength: f.content?.length,
      fixedContentLength: f.fixedContent?.length,
    })));
    console.log('[createFixPR] acceptedFiles from request:', acceptedFiles);

    // Build file list from accepted files.
    // Match by full path OR by basename (in case frontend sends basename only).
    // CRITICAL: only commit files where fixedContent actually differs from original content.
    // Files where fixedContent === content had fuzzyReplace fail — attempt a second-pass fix.
    const candidateFiles = session.mappedFiles.filter(f => {
      if (!acceptedFiles || acceptedFiles.length === 0) return true;
      const basename = f.filePath.split('/').pop();
      return acceptedFiles.includes(f.filePath) || acceptedFiles.includes(basename);
    });

    // Second-pass: for files where fixedContent === content, try applying changes individually
    for (const f of candidateFiles) {
      if (f.fixedContent && f.fixedContent === f.content && f.changes?.length > 0) {
        console.log(`[createFixPR] Second-pass fuzzyReplace for ${f.filePath} (${f.changes.length} changes)`);
        let rebuilt = f.content;
        for (const ch of f.changes) {
          if (ch.original && ch.fixed) {
            rebuilt = fuzzyReplace(rebuilt, ch.original, ch.fixed);
          }
        }
        if (rebuilt !== f.content) {
          f.fixedContent = rebuilt; // mutate in-memory; also persist below
          await FixSession.updateOne(
            { _id: session._id, 'mappedFiles.filePath': f.filePath },
            { $set: { 'mappedFiles.$.fixedContent': rebuilt } }
          );
          console.log(`[createFixPR] Second-pass succeeded for ${f.filePath}`);
        }
      }
    }

    const filesToCommit = candidateFiles
      .filter(f => f.fixedContent && f.fixedContent !== f.content)
      .map(f => ({ path: f.filePath, content: f.fixedContent }));

    console.log('[createFixPR] filesToCommit:', filesToCommit.map(f => f.path));
    console.log('[createFixPR] skipped (no actual change):', candidateFiles
      .filter(f => !f.fixedContent || f.fixedContent === f.content)
      .map(f => f.filePath));

    if (!filesToCommit.length) {
      const debugInfo = candidateFiles.map(f => ({
        path: f.filePath,
        hasFixed: !!f.fixedContent,
        hasActualChange: f.fixedContent !== f.content,
        changesCount: f.changes?.length ?? 0,
      }));
      return res.status(400).json({
        success: false,
        message: 'No files with actual code changes found. The AI-generated fixes may not have matched the exact code in your repository. Try running "Generate Fixes" again with forceRefresh.',
        debug: { acceptedFiles, sessionFiles: debugInfo },
      });
    }

    await FixSession.findByIdAndUpdate(session._id, { status: 'creating_pr' });

    // Get base branch SHA
    const { data: baseRef } = await octokit.rest.git.getRef({
      owner, repo, ref: `heads/${session.repoDefaultBranch}`,
    });
    const baseSha = baseRef.object.sha;

    const { data: baseCommit } = await octokit.rest.git.getCommit({
      owner, repo, commit_sha: baseSha,
    });

    // Create blobs
    const blobs = await Promise.all(
      filesToCommit.map(async (file) => {
        const { data: blob } = await octokit.rest.git.createBlob({
          owner, repo,
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64',
        });
        return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
      })
    );

    const { data: newTree } = await octokit.rest.git.createTree({
      owner, repo, base_tree: baseCommit.tree.sha, tree: blobs,
    });

    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner, repo,
      message: `fix: accessibility improvements via FlowFinder\n\nFixed ${filesToCommit.length} file(s) with ${session.totalFixesApplied} accessibility issues`,
      tree: newTree.sha,
      parents: [baseSha],
    });

    await octokit.rest.git.createRef({
      owner, repo, ref: `refs/heads/${finalBranch}`, sha: newCommit.sha,
    });

    const defaultPrBody = buildPRBody(session, filesToCommit);
    const { data: pr } = await octokit.rest.pulls.create({
      owner, repo,
      title: prTitle || `♿ FlowFinder: Accessibility Fixes (${filesToCommit.length} files)`,
      body: prBody || defaultPrBody,
      head: finalBranch,
      base: session.repoDefaultBranch,
    });

    await FixSession.findByIdAndUpdate(session._id, {
      status: 'pr_created',
      branchName: finalBranch,
      prUrl: pr.html_url,
      prNumber: pr.number,
      prTitle: pr.title,
    });

    res.json({
      success: true,
      pr: { number: pr.number, url: pr.html_url, title: pr.title, branch: finalBranch },
    });
  } catch (err) {
    console.error('[FixController] createFixPR:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/fixes/:sessionId
 * Get fix session status
 */
const getFixSession = async (req, res) => {
  try {
    const session = await FixSession.findOne({ _id: req.params.sessionId, userId: req.user.uid });
    if (!session) return res.status(404).json({ success: false, message: 'Fix session not found.' });
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/fixes/by-scan/:scanId
 * List all fix sessions for a given scan (for fix history UI)
 */
const listFixSessionsByScan = async (req, res) => {
  try {
    const sessions = await FixSession.find({
      userId: req.user.uid,
      scanId: req.params.scanId,
    })
      .sort({ createdAt: -1 })
      .select('_id status repoFullName totalFilesChanged totalFixesApplied prUrl prNumber branchName createdAt framework');

    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateDiff(original, fixed, filePath) {
  if (original === fixed) return '';
  const origLines = original.split('\n');
  const fixedLines = fixed.split('\n');
  const diff = [`--- a/${filePath}`, `+++ b/${filePath}`];

  let i = 0, j = 0;
  while (i < origLines.length || j < fixedLines.length) {
    if (origLines[i] === fixedLines[j]) {
      diff.push(` ${origLines[i]}`);
      i++; j++;
    } else {
      if (i < origLines.length) diff.push(`-${origLines[i++]}`);
      if (j < fixedLines.length) diff.push(`+${fixedLines[j++]}`);
    }
  }
  return diff.join('\n');
}

function buildPRBody(session, files) {
  return `## ♿ FlowFinder — Accessibility Fixes

This PR was automatically generated by [FlowFinder](https://flowfinder.app) to fix accessibility issues detected on **${session.scanType}** audit.

### Summary
- **Files changed**: ${files.length}
- **Issues fixed**: ${session.totalFixesApplied}
- **Scan URL**: ${session.scanId || 'N/A'}

### Changed Files
${files.map(f => `- \`${f.path}\``).join('\n')}

### References
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- Generated by [FlowFinder](https://flowfinder.app)

---
*Review each file carefully before merging. All fixes are minimal and targeted.*`;
}

module.exports = { generateFixes, createFixPR, getFixSession, listFixSessionsByScan };
