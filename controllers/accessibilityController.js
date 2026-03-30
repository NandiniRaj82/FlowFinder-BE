const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MAX_PROCESSABLE_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ── In-memory chat sessions keyed by sessionId ────────────────────────────
const chatSessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────
const processAccessibilityErrors = async (req, res) => {
  try {
    const { errors, choice } = req.body;
    const files = req.files;

    console.log('Processing files:', files ? files.length : 0);

    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    let parsedErrors = [];
    if (errors) {
      parsedErrors = typeof errors === 'string' ? JSON.parse(errors) : errors;
    } else {
      parsedErrors = [{ type: 'general-accessibility', message: 'Perform general accessibility audit', impact: 'moderate' }];
    }

    console.log('Errors to process:', parsedErrors.length);

    const processedFiles = [];

    for (const file of files) {
      console.log(`Processing: ${file.originalname} (${(file.size / 1024).toFixed(2)}KB)`);
      const isZip = file.mimetype === 'application/zip' ||
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.toLowerCase().endsWith('.zip');

      if (isZip) {
        const zipResults = await processZipFile(file, parsedErrors, choice);
        processedFiles.push(...zipResults);
      } else {
        const result = await processSingleFile(file, parsedErrors, choice);
        processedFiles.push(result);
      }
    }

    if (choice === 'suggestions') {
      await cleanupUploadedFiles(files);

      // Generate a sessionId so frontend can chat about these results
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      // Store context for chat — file names + errors + suggestions
      const sessionContext = processedFiles.map(f => ({
        fileName: f.fileName,
        suggestions: f.suggestions,
        errors: parsedErrors,
      }));
      chatSessions.set(sessionId, {
        context: sessionContext,
        history: [],
        createdAt: Date.now(),
      });

      // Auto-expire sessions after 2 hours
      setTimeout(() => chatSessions.delete(sessionId), 2 * 60 * 60 * 1000);

      return res.status(200).json({
        success: true,
        results: processedFiles,
        totalFiles: processedFiles.length,
        sessionId, // frontend stores this for chat
      });

    } else if (choice === 'full-correction') {
      const zipPath = await createCombinedCorrectedZip(processedFiles, parsedErrors);
      res.download(zipPath, `corrected-files-${Date.now()}.zip`, async (err) => {
        await cleanupUploadedFiles(files);
        await fs.unlink(zipPath).catch(() => {});
        if (err) console.error('Download error:', err);
      });
    } else {
      await cleanupUploadedFiles(files);
      return res.status(400).json({ success: false, message: 'Invalid choice' });
    }

  } catch (error) {
    console.error('processAccessibilityErrors:', error);
    if (req.files) await cleanupUploadedFiles(req.files);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CHAT CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────
const chatAboutErrors = async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ success: false, message: 'sessionId and message are required' });
    }

    const session = chatSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session expired or not found. Please re-upload your files.' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Build context summary from stored session
    const contextSummary = session.context.map(f => {
      const suggestionList = Array.isArray(f.suggestions)
        ? f.suggestions.map((s, i) =>
          `  ${i + 1}. [${s.severity || 'unknown'}] ${s.errorType || 'Issue'}: ${s.explanation || ''}\n     Fix: ${s.codeExample || 'N/A'}`
        ).join('\n')
        : JSON.stringify(f.suggestions);

      return `File: ${f.fileName}\nSuggestions:\n${suggestionList}`;
    }).join('\n\n---\n\n');

    // Build conversation history for Gemini
    const historyMessages = session.history.map(h => ({
      role: h.role,
      parts: [{ text: h.content }],
    }));

    const systemPrompt = `You are an expert web accessibility engineer helping a developer understand and fix accessibility issues in their code.

Here is the accessibility analysis that was already performed on their files:

${contextSummary}

RULES:
- Answer questions specifically about their code and the issues found above
- When showing code fixes, show MINIMAL changes — only what needs to change for accessibility
- Always explain WHY a fix improves accessibility (WCAG criterion)
- If they ask about a specific error, reference the exact file and line if possible
- Keep responses concise and practical
- If they ask something unrelated to accessibility, gently redirect them
- Format code in markdown code blocks with the correct language`;

    // Start or continue chat
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: 'I have reviewed the accessibility analysis for your files. I can see the issues found and I\'m ready to help you understand and fix them. What would you like to know?' }] },
        ...historyMessages,
      ],
    });

    const result = await chat.sendMessage(message);
    const reply = result.response.text();

    // Save to history
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'model', content: reply });

    // Keep history manageable (last 20 messages)
    if (session.history.length > 20) {
      session.history = session.history.slice(-20);
    }

    return res.status(200).json({ success: true, reply });

  } catch (error) {
    console.error('chatAboutErrors:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE FILE PROCESSOR
// ─────────────────────────────────────────────────────────────────────────────
const processSingleFile = async (file, errors, choice) => {
  try {
    if (file.size > MAX_PROCESSABLE_FILE_SIZE) {
      return { fileName: file.originalname, error: 'File too large', success: false };
    }

    const fileContent = await fs.readFile(file.path, 'utf-8');

    if (choice === 'suggestions') {
      const suggestions = await generateAccessibilitySuggestions(fileContent, errors, file.originalname);
      return { fileName: file.originalname, suggestions, success: true };
    } else {
      const correctedCode = await generateCorrectedCode_internal(fileContent, errors, file.originalname);
      return { fileName: file.originalname, correctedCode, success: true };
    }
  } catch (error) {
    console.error(`Error processing ${file.originalname}:`, error);
    return { fileName: file.originalname, error: error.message, success: false };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ZIP PROCESSOR
// ─────────────────────────────────────────────────────────────────────────────
const processZipFile = async (file, errors, choice) => {
  const timestamp = Date.now();
  const extractedDir = path.join('uploads', `extracted-${timestamp}`);

  try {
    await fs.mkdir(extractedDir, { recursive: true });
    await extractZipFile(file.path, extractedDir);
    const htmlFiles = await findHtmlFiles(extractedDir);

    if (htmlFiles.length === 0) {
      return [{ fileName: file.originalname, error: 'No code files found in ZIP', success: false }];
    }

    const results = [];
    for (const htmlPath of htmlFiles) {
      const content = await fs.readFile(htmlPath, 'utf-8');
      const relativePath = path.relative(extractedDir, htmlPath);

      if (choice === 'suggestions') {
        const suggestions = await generateAccessibilitySuggestions(content, errors, relativePath);
        results.push({ fileName: relativePath, suggestions, success: true });
      } else {
        const correctedCode = await generateCorrectedCode_internal(content, errors, relativePath);
        results.push({ fileName: relativePath, correctedCode, success: true });
      }
    }

    await fs.rm(extractedDir, { recursive: true, force: true });
    return results;

  } catch (error) {
    console.error(`Error processing ZIP ${file.originalname}:`, error);
    await fs.rm(extractedDir, { recursive: true, force: true }).catch(() => {});
    return [{ fileName: file.originalname, error: error.message, success: false }];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI — SUGGESTIONS (improved prompt)
// ─────────────────────────────────────────────────────────────────────────────
const generateAccessibilitySuggestions = async (code, errors, fileName = 'file') => {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const maxCodeLength = 30000;
    const truncatedCode = code.length > maxCodeLength
      ? code.substring(0, maxCodeLength) + '\n... (code truncated)'
      : code;

    const errorSummary = errors.slice(0, 20).map((err, idx) =>
      `${idx + 1}. [${err.impact || err.severity || 'unknown'}] ${err.title || err.type || 'Issue'}: ${err.message || err.description || ''}\n   Selector: ${err.selector || 'N/A'}\n   Source: ${err.source || 'N/A'}`
    ).join('\n\n');

    const prompt = `You are an expert web accessibility engineer reviewing code for WCAG 2.1 AA compliance.

FILE: ${fileName}

ACCESSIBILITY ERRORS DETECTED:
${errorSummary}

ACTUAL CODE TO REVIEW:
\`\`\`
${truncatedCode}
\`\`\`

TASK: For each accessibility error above, find the EXACT problematic code in the file and provide a minimal surgical fix.

STRICT RULES:
- Find the EXACT line(s) in the code that cause each error
- Show the ORIGINAL problematic code snippet
- Show the FIXED code snippet with ONLY the accessibility change — nothing else changed
- Do NOT refactor, rename variables, change logic, or restructure anything
- Keep all imports, exports, component names, props, classNames identical
- Only modify: aria-label, role, alt, tabIndex, htmlFor/id, button type, semantic tags

Return ONLY a valid JSON array — no markdown, no explanation outside the array:
[
  {
    "errorNumber": 1,
    "errorType": "exact error name from the list above",
    "severity": "critical|serious|moderate|minor",
    "location": "exact location e.g. line 45, ContactForm component, submit button",
    "explanation": "exactly what is wrong in this file and why it fails WCAG",
    "originalCode": "the exact problematic code snippet from the file",
    "codeExample": "the exact fixed version with minimal change",
    "wcagReference": "e.g. WCAG 2.1 Success Criterion 4.1.2 Name, Role, Value"
  }
]

Only include issues that actually exist in the provided code. If an error from the list doesn't appear in this file, skip it.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    return parseSuggestionsResponse(responseText, errors);

  } catch (error) {
    console.error('Error generating suggestions:', error);
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI — FULL CORRECTION (improved prompt)
// ─────────────────────────────────────────────────────────────────────────────
const generateCorrectedCode_internal = async (code, errors, fileName = 'file') => {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const maxCodeLength = 30000;
    const truncatedCode = code.length > maxCodeLength
      ? code.substring(0, maxCodeLength) + '\n... (rest omitted)'
      : code;

    const errorSummary = errors.slice(0, 20).map((err, idx) =>
      `${idx + 1}. [${err.impact || 'unknown'}] ${err.title || err.type || 'Issue'}: ${err.selector || ''}`
    ).join('\n');

    const prompt = `You are an expert accessibility engineer. Fix ONLY the accessibility issues in this file without breaking anything.

FILE: ${fileName}

ACCESSIBILITY ERRORS TO FIX:
${errorSummary}

ORIGINAL CODE:
\`\`\`
${truncatedCode}
\`\`\`

STRICT RULES:
- Fix ONLY the accessibility errors listed above
- Do NOT change any logic, state, imports, exports, component names, or non-accessibility code
- Do NOT refactor or restructure anything
- Do NOT change classNames, styles, or non-accessibility attributes
- Only add/modify: aria-label, role, alt, tabIndex, htmlFor/id pairs, button type="button", semantic HTML tags where appropriate
- The fixed code must be a drop-in replacement — it must work exactly as before

Return ONLY the complete corrected file content inside a code block:
\`\`\`
[complete corrected file here]
\`\`\``;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    return extractCorrectedCode(responseText);

  } catch (error) {
    console.error('Error generating corrected code:', error);
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const parseSuggestionsResponse = (responseText, originalErrors) => {
  try {
    // Strip markdown code fences if present
    const cleaned = responseText.replace(/^```json\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return [{ errorType: 'Parse Error', explanation: responseText, severity: 'unknown', codeExample: '', wcagReference: '' }];
  } catch (error) {
    return [{ errorType: 'Parse Error', explanation: responseText, severity: 'unknown', codeExample: '', wcagReference: '' }];
  }
};

const extractCorrectedCode = (responseText) => {
  const match = responseText.match(/```(?:html|javascript|jsx|tsx|js|ts|css)?\n([\s\S]*?)\n```/);
  if (match && match[1]) return match[1].trim();
  return responseText.trim();
};

const createCombinedCorrectedZip = async (processedFiles, errors) => {
  return new Promise((resolve, reject) => {
    try {
      const timestamp = Date.now();
      const zipPath = path.join('uploads', `corrected-${timestamp}.zip`);
      const output = fsSync.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve(zipPath));
      archive.on('error', reject);
      archive.pipe(output);

      processedFiles.forEach((file) => {
        if (file.success && file.correctedCode) {
          const ext = path.extname(file.fileName) || '.html';
          const baseName = path.basename(file.fileName, ext);
          archive.append(file.correctedCode, { name: `${baseName}-corrected${ext}` });
        }
      });

      archive.append(createChangelog(errors, processedFiles), { name: 'CHANGELOG.md' });
      archive.append(createReadme(processedFiles.length), { name: 'README.md' });
      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
};

const cleanupUploadedFiles = async (files) => {
  for (const file of files) {
    try { await fs.unlink(file.path); } catch (e) { /* ignore */ }
  }
};

const extractZipFile = async (zipPath, destPath) => {
  return new Promise((resolve, reject) => {
    fsSync.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: destPath }))
      .on('close', resolve)
      .on('error', reject);
  });
};

const findHtmlFiles = async (dir) => {
  const files = [];
  async function scan(directory) {
    const items = await fs.readdir(directory, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(directory, item.name);
      if (item.isDirectory()) await scan(fullPath);
      else if (item.isFile() && /\.(html|htm|jsx|tsx|js|ts)$/i.test(item.name)) files.push(fullPath);
    }
  }
  await scan(dir);
  return files;
};

const createChangelog = (errors, processedFiles) => {
  const date = new Date().toISOString().split('T')[0];
  let log = `# Accessibility Fixes\n\nDate: ${date}\nFiles: ${processedFiles.length}\nIssues: ${errors.length}\n\n## Files Fixed\n\n`;
  processedFiles.forEach((f, i) => { if (f.success) log += `${i + 1}. ${f.fileName} ✓\n`; });
  log += `\n## Issues Addressed\n\n`;
  errors.slice(0, 20).forEach((e, i) => { log += `${i + 1}. ${e.title || e.type || 'Issue'}: ${e.message || ''}\n`; });
  return log;
};

const createReadme = (fileCount) => `# Corrected Code Package\n\nGenerated by Flow Finder • Gemini AI\n\n## Contents\n- ${fileCount} corrected file(s)\n- CHANGELOG.md\n- README.md\n\n## Next Steps\n1. Review corrected files\n2. Test in your application\n3. Run accessibility audit again\n4. Deploy when ready\n`;

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY EXPORTS (kept for backward compat)
// ─────────────────────────────────────────────────────────────────────────────
const receiveExtensionErrors = async (req, res) => {
  try {
    const { errors, tabId } = req.body;
    if (!errors || !Array.isArray(errors)) return res.status(400).json({ success: false, message: 'Errors array required' });
    console.log(`Received ${errors.length} errors from extension for tab ${tabId}`);
    return res.status(200).json({ success: true, message: `Received ${errors.length} errors`, errorCount: errors.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const generateSuggestions = async (req, res) => {
  try {
    const { code, errors } = req.body;
    if (!code || !errors) return res.status(400).json({ success: false, message: 'Code and errors required' });
    const suggestions = await generateAccessibilitySuggestions(code, errors);
    res.status(200).json({ success: true, suggestions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const generateCorrectedCode = async (req, res) => {
  try {
    const { errors } = req.body;
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });
    const parsedErrors = typeof errors === 'string' ? JSON.parse(errors) : errors;
    const results = [];
    for (const file of files) {
      const fileContent = await fs.readFile(file.path, 'utf-8');
      const correctedCode = await generateCorrectedCode_internal(fileContent, parsedErrors, file.originalname);
      results.push({ fileName: file.originalname, correctedCode });
    }
    const zipPath = await createCombinedCorrectedZip(results, parsedErrors);
    res.download(zipPath, `corrected-files.zip`, async (err) => {
      await cleanupUploadedFiles(files);
      await fs.unlink(zipPath).catch(() => {});
    });
  } catch (error) {
    if (req.files) await cleanupUploadedFiles(req.files);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  processAccessibilityErrors,
  chatAboutErrors,
  generateSuggestions,
  generateCorrectedCode,
  receiveExtensionErrors,
};