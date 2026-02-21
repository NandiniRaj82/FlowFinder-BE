const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Maximum file size for processing (10MB for individual files)
const MAX_PROCESSABLE_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Main controller for processing accessibility errors with Gemini AI
 */
const processAccessibilityErrors = async (req, res) => {
    let extractedDir = null;
    
    try {
        const { errors, choice } = req.body;
        const file = req.file;

        console.log('Processing file:', file ? file.originalname : 'none', 'Size:', file ? file.size : 0);

        if (!file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        if (!errors) {
            return res.status(400).json({
                success: false,
                message: 'No accessibility errors provided'
            });
        }

        // Parse errors if string
        const parsedErrors = typeof errors === 'string' ? JSON.parse(errors) : errors;

        // Check if file is a ZIP
        const isZip = file.mimetype === 'application/zip' || 
                      file.mimetype === 'application/x-zip-compressed' ||
                      file.originalname.toLowerCase().endsWith('.zip');

        if (isZip) {
            console.log('Detected ZIP file, extracting...');
            
            // Extract ZIP to temporary directory
            const timestamp = Date.now();
            extractedDir = path.join('uploads', `extracted-${timestamp}`);
            await fs.mkdir(extractedDir, { recursive: true });

            await extractZipFile(file.path, extractedDir);
            
            // Find HTML files in extracted directory
            const htmlFiles = await findHtmlFiles(extractedDir);
            
            if (htmlFiles.length === 0) {
                throw new Error('No HTML files found in ZIP archive');
            }

            console.log(`Found ${htmlFiles.length} HTML files to process`);

            if (choice === 'suggestions') {
                // Process first HTML file for suggestions
                const firstHtmlPath = htmlFiles[0];
                const fileContent = await fs.readFile(firstHtmlPath, 'utf-8');
                
                const suggestions = await generateAccessibilitySuggestions(fileContent, parsedErrors);
                
                // Clean up
                await cleanupFiles(file.path, extractedDir);

                return res.status(200).json({
                    success: true,
                    suggestions,
                    fileName: path.basename(firstHtmlPath),
                    totalFilesInZip: htmlFiles.length
                });
                
            } else if (choice === 'full-correction') {
                // Process all HTML files and create corrected ZIP
                const correctedFiles = [];
                
                for (const htmlPath of htmlFiles) {
                    console.log(`Processing: ${path.basename(htmlPath)}`);
                    const fileContent = await fs.readFile(htmlPath, 'utf-8');
                    const correctedCode = await generateCorrectedCodeWithGemini(fileContent, parsedErrors);
                    
                    correctedFiles.push({
                        originalPath: htmlPath,
                        relativePath: path.relative(extractedDir, htmlPath),
                        correctedContent: correctedCode
                    });
                }

                // Create ZIP with all corrected files
                const zipPath = await createZipWithMultipleFiles(
                    file.originalname,
                    correctedFiles,
                    parsedErrors,
                    extractedDir
                );

                // Send ZIP file
                res.download(zipPath, `corrected-${file.originalname}`, async (err) => {
                    await cleanupFiles(file.path, extractedDir, zipPath);
                    
                    if (err) {
                        console.error('Download error:', err);
                    }
                });
            } else {
                await cleanupFiles(file.path, extractedDir);
                return res.status(400).json({
                    success: false,
                    message: 'Invalid choice. Must be "suggestions" or "full-correction"'
                });
            }

        } else {
            // Handle single file (not ZIP)
            console.log('Processing single file...');
            
            // Check file size
            const stats = await fs.stat(file.path);
            if (stats.size > MAX_PROCESSABLE_FILE_SIZE) {
                await fs.unlink(file.path);
                return res.status(400).json({
                    success: false,
                    message: `Single file is too large to process. Maximum size: ${MAX_PROCESSABLE_FILE_SIZE / 1024 / 1024}MB`,
                    actualSize: `${(stats.size / 1024 / 1024).toFixed(2)}MB`
                });
            }

            const fileContent = await fs.readFile(file.path, 'utf-8');

            if (choice === 'suggestions') {
                const suggestions = await generateAccessibilitySuggestions(fileContent, parsedErrors);
                await fs.unlink(file.path);

                return res.status(200).json({
                    success: true,
                    suggestions,
                    fileName: file.originalname
                });
                
            } else if (choice === 'full-correction') {
                const correctedCode = await generateCorrectedCodeWithGemini(fileContent, parsedErrors);
                const zipPath = await createZipWithCorrectedCode(
                    file.originalname, 
                    correctedCode,
                    parsedErrors
                );

                res.download(zipPath, `corrected-${file.originalname}.zip`, async (err) => {
                    await cleanupFiles(file.path, null, zipPath);
                    
                    if (err) {
                        console.error('Download error:', err);
                    }
                });
            } else {
                await fs.unlink(file.path);
                return res.status(400).json({
                    success: false,
                    message: 'Invalid choice. Must be "suggestions" or "full-correction"'
                });
            }
        }

    } catch (error) {
        console.error('Process accessibility errors:', error);
        
        // Clean up on error
        if (req.file) {
            try {
                await fs.unlink(req.file.path).catch(() => {});
            } catch (e) {}
        }
        
        if (extractedDir) {
            try {
                await fs.rm(extractedDir, { recursive: true, force: true }).catch(() => {});
            } catch (e) {}
        }

        res.status(500).json({
            success: false,
            message: 'Error processing accessibility errors',
            error: error.message
        });
    }
};

/**
 * Extract ZIP file to directory
 */
const extractZipFile = async (zipPath, destPath) => {
    return new Promise((resolve, reject) => {
        fsSync.createReadStream(zipPath)
            .pipe(unzipper.Extract({ path: destPath }))
            .on('close', resolve)
            .on('error', reject);
    });
};

/**
 * Find all HTML files in directory recursively
 */
const findHtmlFiles = async (dir) => {
    const files = [];
    
    async function scan(directory) {
        const items = await fs.readdir(directory, { withFileTypes: true });
        
        for (const item of items) {
            const fullPath = path.join(directory, item.name);
            
            if (item.isDirectory()) {
                await scan(fullPath);
            } else if (item.isFile() && /\.html?$/i.test(item.name)) {
                files.push(fullPath);
            }
        }
    }
    
    await scan(dir);
    return files;
};

/**
 * Clean up files and directories
 */
const cleanupFiles = async (...paths) => {
    for (const p of paths) {
        if (!p) continue;
        
        try {
            const stats = await fs.stat(p);
            if (stats.isDirectory()) {
                await fs.rm(p, { recursive: true, force: true });
            } else {
                await fs.unlink(p);
            }
        } catch (error) {
            console.error(`Error cleaning up ${p}:`, error.message);
        }
    }
};

/**
 * Generate AI-powered suggestions using Gemini
 */
const generateAccessibilitySuggestions = async (code, errors) => {
    try {
        // Get the Gemini 2.5 Flash model (FREE tier available)
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Truncate code if too long
        const maxCodeLength = 30000; // ~30KB
        const truncatedCode = code.length > maxCodeLength 
            ? code.substring(0, maxCodeLength) + '\n... (code truncated)'
            : code;

        const prompt = createSuggestionsPrompt(truncatedCode, errors);

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const responseText = response.text();

        return parseSuggestionsResponse(responseText, errors);

    } catch (error) {
        console.error('Error generating suggestions with Gemini:', error);
        throw error;
    }
};

/**
 * Generate fully corrected code with Gemini AI
 */
const generateCorrectedCodeWithGemini = async (code, errors) => {
    try {
        // Get the Gemini 2.5 Flash model
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Truncate code if too long
        const maxCodeLength = 30000; // ~30KB
        const truncatedCode = code.length > maxCodeLength 
            ? code.substring(0, maxCodeLength) + '\n... (rest of code omitted)'
            : code;

        const prompt = createCorrectionPrompt(truncatedCode, errors);

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const responseText = response.text();

        return extractCorrectedCode(responseText);

    } catch (error) {
        console.error('Error generating corrected code with Gemini:', error);
        throw error;
    }
};

/**
 * Create prompt for getting suggestions
 */
const createSuggestionsPrompt = (code, errors) => {
    const errorSummary = errors.slice(0, 20).map((err, idx) => // Limit to 20 errors
        `${idx + 1}. ${err.type}: ${err.message}\n` +
        `   Element: ${err.selector || err.element || 'N/A'}\n` +
        `   Impact: ${err.impact || 'N/A'}`
    ).join('\n\n');

    return `You are an expert web accessibility consultant. I need your help to fix accessibility issues.

**ACCESSIBILITY ERRORS (showing first 20):**
${errorSummary}

**CODE SAMPLE:**
\`\`\`html
${code}
\`\`\`

**INSTRUCTIONS:**
Provide detailed suggestions for the top 5 most critical accessibility errors. For each error:

1. Explain the problem clearly
2. Show how to fix it with code example
3. Provide WCAG reference

Format your response as a JSON array:
[
  {
    "errorNumber": 1,
    "errorType": "missing-alt-text",
    "severity": "critical",
    "explanation": "Clear explanation of the problem",
    "codeExample": "Fixed code snippet",
    "wcagReference": "WCAG 2.1 Level A 1.1.1"
  }
]

Make your suggestions practical and beginner-friendly.`;
};

/**
 * Create prompt for full code correction
 */
const createCorrectionPrompt = (code, errors) => {
    const errorSummary = errors.slice(0, 20).map((err, idx) =>
        `${idx + 1}. ${err.type}: ${err.message}`
    ).join('\n');

    return `You are an expert web accessibility engineer. Fix ALL accessibility issues in this code.

**ERRORS TO FIX:**
${errorSummary}

**ORIGINAL CODE:**
\`\`\`html
${code}
\`\`\`

**REQUIREMENTS:**
1. Fix ALL accessibility errors listed above
2. Maintain existing functionality and styling
3. Follow WCAG 2.1 Level AA guidelines
4. Add proper ARIA labels where needed
5. Use semantic HTML

**IMPORTANT:**
Return ONLY the corrected code in a code block. No explanations outside the code block.

\`\`\`html
[your corrected code here]
\`\`\``;
};

/**
 * Parse suggestions from Gemini's response
 */
const parseSuggestionsResponse = (responseText, originalErrors) => {
    try {
        // Try to extract JSON from response
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return {
            rawSuggestions: responseText,
            errorCount: originalErrors.length
        };
    } catch (error) {
        return {
            rawSuggestions: responseText,
            errorCount: originalErrors.length
        };
    }
};

/**
 * Extract corrected code from Gemini's response
 */
const extractCorrectedCode = (responseText) => {
    const codeBlockRegex = /```(?:html|javascript|css)?\n([\s\S]*?)\n```/;
    const match = responseText.match(codeBlockRegex);
    
    if (match && match[1]) {
        return match[1].trim();
    }
    return responseText.trim();
};

/**
 * Create ZIP with single corrected file
 */
const createZipWithCorrectedCode = async (originalFileName, correctedCode, errors) => {
    return new Promise(async (resolve, reject) => {
        try {
            const timestamp = Date.now();
            const zipPath = path.join('uploads', `corrected-${timestamp}.zip`);
            const output = fsSync.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => resolve(zipPath));
            archive.on('error', (err) => reject(err));
            archive.pipe(output);

            const fileExtension = path.extname(originalFileName);
            const baseName = path.basename(originalFileName, fileExtension);
            archive.append(correctedCode, { name: `${baseName}-corrected${fileExtension}` });
            archive.append(createChangelog(errors), { name: 'CHANGELOG.md' });
            archive.append(createReadme(originalFileName), { name: 'README.md' });

            await archive.finalize();
        } catch (error) {
            reject(error);
        }
    });
};

/**
 * Create ZIP with multiple corrected files
 */
const createZipWithMultipleFiles = async (originalZipName, correctedFiles, errors, extractedDir) => {
    return new Promise(async (resolve, reject) => {
        try {
            const timestamp = Date.now();
            const zipPath = path.join('uploads', `corrected-${timestamp}.zip`);
            const output = fsSync.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => resolve(zipPath));
            archive.on('error', (err) => reject(err));
            archive.pipe(output);

            // Add corrected files
            for (const file of correctedFiles) {
                const correctedPath = file.relativePath.replace('.html', '-corrected.html');
                archive.append(file.correctedContent, { name: correctedPath });
            }

            // Add other files from ZIP (CSS, JS, images, etc.)
            archive.directory(extractedDir, false, (entry) => {
                // Skip HTML files (already added as corrected)
                return !/\.html?$/i.test(entry.name);
            });

            // Add documentation
            archive.append(createChangelog(errors), { name: 'CHANGELOG.md' });
            archive.append(createReadme(originalZipName), { name: 'README.md' });

            await archive.finalize();
        } catch (error) {
            reject(error);
        }
    });
};

/**
 * Create changelog
 */
const createChangelog = (errors) => {
    const date = new Date().toISOString().split('T')[0];
    
    let changelog = `# Accessibility Fixes\n\n`;
    changelog += `Date: ${date}\n`;
    changelog += `Total Issues: ${errors.length}\n\n`;

    errors.slice(0, 20).forEach((err, idx) => {
        changelog += `${idx + 1}. ${err.type || 'Issue'}\n`;
        changelog += `   ${err.message}\n\n`;
    });

    return changelog;
};

/**
 * Create README
 */
const createReadme = (originalFileName) => {
    return `# Corrected Code Package

Original: ${originalFileName}
Generated by Flow Finder using Google Gemini AI

## Contents
- Corrected HTML files
- Original CSS/JS/assets
- This README
- CHANGELOG with fixes

## Next Steps
1. Review corrected files
2. Test in your application
3. Verify accessibility improvements
`;
};

/**
 * Standalone function for generating suggestions
 */
const generateSuggestions = async (req, res) => {
    try {
        const { code, errors } = req.body;

        if (!code || !errors) {
            return res.status(400).json({
                success: false,
                message: 'Code and errors are required'
            });
        }

        const suggestions = await generateAccessibilitySuggestions(code, errors);

        res.status(200).json({
            success: true,
            suggestions
        });

    } catch (error) {
        console.error('Generate suggestions error:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating suggestions',
            error: error.message
        });
    }
};

/**
 * Standalone function for generating corrected code
 */
const generateCorrectedCode = async (req, res) => {
    try {
        const { errors } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        if (!errors) {
            return res.status(400).json({
                success: false,
                message: 'No errors provided'
            });
        }

        const parsedErrors = typeof errors === 'string' ? JSON.parse(errors) : errors;
        const fileContent = await fs.readFile(file.path, 'utf-8');

        const correctedCode = await generateCorrectedCodeWithGemini(fileContent, parsedErrors);
        const zipPath = await createZipWithCorrectedCode(file.originalname, correctedCode, parsedErrors);

        res.download(zipPath, `corrected-${file.originalname}.zip`, async (err) => {
            await cleanupFiles(file.path, null, zipPath);
            
            if (err) {
                console.error('Download error:', err);
            }
        });

    } catch (error) {
        console.error('Generate corrected code error:', error);
        
        if (req.file) {
            await cleanupFiles(req.file.path);
        }

        res.status(500).json({
            success: false,
            message: 'Error generating corrected code',
            error: error.message
        });
    }
};

module.exports = {
    processAccessibilityErrors,
    generateSuggestions,
    generateCorrectedCode
};