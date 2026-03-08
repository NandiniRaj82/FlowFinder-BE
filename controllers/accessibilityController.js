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
 * Supports multiple file uploads
 */
const processAccessibilityErrors = async (req, res) => {
    let extractedDir = null;
    
    try {
        const { errors, choice } = req.body;
        const files = req.files; // Multiple files

        console.log('Processing files:', files ? files.length : 0);

        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No files uploaded'
            });
        }

        // Parse errors - could come from extension or form
        let parsedErrors = [];
        
        if (errors) {
            parsedErrors = typeof errors === 'string' ? JSON.parse(errors) : errors;
        } else {
            // If no errors provided, generate a generic accessibility check request
            parsedErrors = [{
                type: 'general-accessibility',
                message: 'Perform general accessibility audit',
                impact: 'moderate'
            }];
        }

        console.log('Errors to process:', parsedErrors.length);

        // Process multiple files
        const processedFiles = [];
        
        for (const file of files) {
            console.log(`Processing: ${file.originalname} (${(file.size / 1024).toFixed(2)}KB)`);
            
            // Check if it's a ZIP file
            const isZip = file.mimetype === 'application/zip' || 
                          file.mimetype === 'application/x-zip-compressed' ||
                          file.originalname.toLowerCase().endsWith('.zip');

            if (isZip) {
                // Extract and process ZIP
                const zipResults = await processZipFile(file, parsedErrors, choice);
                processedFiles.push(...zipResults);
            } else {
                // Process single file
                const result = await processSingleFile(file, parsedErrors, choice);
                processedFiles.push(result);
            }
        }

        // Based on choice, return appropriate response
        if (choice === 'suggestions') {
            // Return all suggestions
            await cleanupUploadedFiles(files);
            
            return res.status(200).json({
                success: true,
                results: processedFiles,
                totalFiles: processedFiles.length
            });
            
        } else if (choice === 'full-correction') {
            // Create a single ZIP with all corrected files
            const zipPath = await createCombinedCorrectedZip(processedFiles, parsedErrors);
            
            res.download(zipPath, `corrected-files-${Date.now()}.zip`, async (err) => {
                // Clean up
                await cleanupUploadedFiles(files);
                await fs.unlink(zipPath).catch(() => {});
                
                if (err) {
                    console.error('Download error:', err);
                }
            });
        } else {
            await cleanupUploadedFiles(files);
            return res.status(400).json({
                success: false,
                message: 'Invalid choice. Must be "suggestions" or "full-correction"'
            });
        }

    } catch (error) {
        console.error('Process accessibility errors:', error);
        
        // Clean up on error
        if (req.files) {
            await cleanupUploadedFiles(req.files);
        }

        res.status(500).json({
            success: false,
            message: 'Error processing accessibility errors',
            error: error.message
        });
    }
};

/**
 * Process a single uploaded file
 */
const processSingleFile = async (file, errors, choice) => {
    try {
        // Check file size
        if (file.size > MAX_PROCESSABLE_FILE_SIZE) {
            return {
                fileName: file.originalname,
                error: `File too large (max ${MAX_PROCESSABLE_FILE_SIZE / 1024 / 1024}MB)`,
                success: false
            };
        }

        const fileContent = await fs.readFile(file.path, 'utf-8');

        if (choice === 'suggestions') {
            const suggestions = await generateAccessibilitySuggestions(fileContent, errors);
            
            return {
                fileName: file.originalname,
                suggestions,
                success: true
            };
        } else {
            const correctedCode = await generateCorrectedCodeWithGemini(fileContent, errors);
            
            return {
                fileName: file.originalname,
                correctedCode,
                success: true
            };
        }
    } catch (error) {
        console.error(`Error processing ${file.originalname}:`, error);
        return {
            fileName: file.originalname,
            error: error.message,
            success: false
        };
    }
};

/**
 * Process ZIP file
 */
const processZipFile = async (file, errors, choice) => {
    const timestamp = Date.now();
    const extractedDir = path.join('uploads', `extracted-${timestamp}`);
    
    try {
        await fs.mkdir(extractedDir, { recursive: true });
        await extractZipFile(file.path, extractedDir);
        
        // Find HTML files
        const htmlFiles = await findHtmlFiles(extractedDir);
        
        if (htmlFiles.length === 0) {
            return [{
                fileName: file.originalname,
                error: 'No HTML files found in ZIP',
                success: false
            }];
        }

        const results = [];
        
        for (const htmlPath of htmlFiles) {
            const content = await fs.readFile(htmlPath, 'utf-8');
            const relativePath = path.relative(extractedDir, htmlPath);
            
            if (choice === 'suggestions') {
                const suggestions = await generateAccessibilitySuggestions(content, errors);
                results.push({
                    fileName: relativePath,
                    suggestions,
                    success: true
                });
            } else {
                const correctedCode = await generateCorrectedCodeWithGemini(content, errors);
                results.push({
                    fileName: relativePath,
                    correctedCode,
                    success: true
                });
            }
        }
        
        // Clean up extracted directory
        await fs.rm(extractedDir, { recursive: true, force: true });
        
        return results;
        
    } catch (error) {
        console.error(`Error processing ZIP ${file.originalname}:`, error);
        
        // Clean up on error
        if (extractedDir) {
            await fs.rm(extractedDir, { recursive: true, force: true }).catch(() => {});
        }
        
        return [{
            fileName: file.originalname,
            error: error.message,
            success: false
        }];
    }
};

/**
 * Create combined ZIP with all corrected files
 */
const createCombinedCorrectedZip = async (processedFiles, errors) => {
    return new Promise((resolve, reject) => {
        try {
            const timestamp = Date.now();
            const zipPath = path.join('uploads', `corrected-${timestamp}.zip`);
            const output = fsSync.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => resolve(zipPath));
            archive.on('error', (err) => reject(err));
            archive.pipe(output);

            // Add all corrected files
            processedFiles.forEach((file, index) => {
                if (file.success && file.correctedCode) {
                    const ext = path.extname(file.fileName) || '.html';
                    const baseName = path.basename(file.fileName, ext);
                    archive.append(file.correctedCode, { 
                        name: `${baseName}-corrected${ext}` 
                    });
                }
            });

            // Add changelog
            archive.append(createChangelog(errors, processedFiles), { 
                name: 'CHANGELOG.md' 
            });

            // Add README
            archive.append(createReadme(processedFiles.length), { 
                name: 'README.md' 
            });

            archive.finalize();
            
        } catch (error) {
            reject(error);
        }
    });
};

/**
 * Clean up uploaded files
 */
const cleanupUploadedFiles = async (files) => {
    for (const file of files) {
        try {
            await fs.unlink(file.path);
        } catch (error) {
            console.error(`Error deleting ${file.path}:`, error.message);
        }
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
            } else if (item.isFile() && /\.(html|htm|jsx|tsx|js|ts)$/i.test(item.name)) {
                files.push(fullPath);
            }
        }
    }
    
    await scan(dir);
    return files;
};

/**
 * Generate AI-powered suggestions using Gemini
 */
const generateAccessibilitySuggestions = async (code, errors) => {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Truncate code if too long
        const maxCodeLength = 30000;
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
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Truncate code if too long
        const maxCodeLength = 30000;
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
    const errorSummary = errors.slice(0, 20).map((err, idx) =>
        `${idx + 1}. ${err.type || 'Issue'}: ${err.message || 'Accessibility issue'}\n` +
        `   Element: ${err.selector || err.element || 'N/A'}\n` +
        `   Impact: ${err.impact || 'N/A'}`
    ).join('\n\n');

    return `You are an expert web accessibility consultant. Analyze this code for accessibility issues.

**ACCESSIBILITY ERRORS:**
${errorSummary}

**CODE:**
\`\`\`
${code}
\`\`\`

**INSTRUCTIONS:**
Provide top 5 critical accessibility fixes as JSON:

[
  {
    "errorNumber": 1,
    "errorType": "issue-name",
    "severity": "critical|serious|moderate",
    "explanation": "What's wrong",
    "codeExample": "How to fix",
    "wcagReference": "WCAG 2.1 reference"
  }
]

Be practical and clear.`;
};

/**
 * Create prompt for full code correction
 */
const createCorrectionPrompt = (code, errors) => {
    const errorSummary = errors.slice(0, 20).map((err, idx) =>
        `${idx + 1}. ${err.type || 'Issue'}: ${err.message || 'Fix needed'}`
    ).join('\n');

    return `Fix ALL accessibility issues in this code.

**ERRORS:**
${errorSummary}

**CODE:**
\`\`\`
${code}
\`\`\`

**REQUIREMENTS:**
- Fix all errors
- Follow WCAG 2.1 AA
- Add ARIA labels
- Use semantic HTML
- Maintain functionality

Return ONLY corrected code in code block:
\`\`\`
[corrected code]
\`\`\``;
};

/**
 * Parse suggestions from Gemini's response
 */
const parseSuggestionsResponse = (responseText, originalErrors) => {
    try {
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
    const codeBlockRegex = /```(?:html|javascript|jsx|tsx|css)?\n([\s\S]*?)\n```/;
    const match = responseText.match(codeBlockRegex);
    
    if (match && match[1]) {
        return match[1].trim();
    }
    return responseText.trim();
};

/**
 * Create changelog
 */
const createChangelog = (errors, processedFiles) => {
    const date = new Date().toISOString().split('T')[0];
    
    let changelog = `# Accessibility Fixes\n\n`;
    changelog += `Date: ${date}\n`;
    changelog += `Files Processed: ${processedFiles.length}\n`;
    changelog += `Total Issues: ${errors.length}\n\n`;

    changelog += `## Files Fixed\n\n`;
    processedFiles.forEach((file, idx) => {
        if (file.success) {
            changelog += `${idx + 1}. ${file.fileName} ✓\n`;
        }
    });

    changelog += `\n## Issues Addressed\n\n`;
    errors.slice(0, 20).forEach((err, idx) => {
        changelog += `${idx + 1}. ${err.type || 'Issue'}: ${err.message || 'Fixed'}\n`;
    });

    return changelog;
};

/**
 * Create README
 */
const createReadme = (fileCount) => {
    return `# Corrected Code Package

Generated by Flow Finder using Google Gemini AI

## Contents
- ${fileCount} corrected file(s)
- CHANGELOG with fixes
- This README

## What Was Done
All files analyzed for accessibility issues and corrected following WCAG 2.1 AA guidelines.

## Next Steps
1. Review corrected files
2. Test in your application
3. Run accessibility tests
4. Deploy when ready

---
Powered by Gemini AI
`;
};

/**
 * Endpoint to receive errors from Chrome extension
 */
const receiveExtensionErrors = async (req, res) => {
    try {
        const { errors, tabId, url } = req.body;

        if (!errors || !Array.isArray(errors)) {
            return res.status(400).json({
                success: false,
                message: 'Errors array is required'
            });
        }

        console.log(`Received ${errors.length} errors from extension for tab ${tabId}`);

        // Store errors temporarily (could use Redis or database)
        // For now, return them to be sent with file upload
        return res.status(200).json({
            success: true,
            message: `Received ${errors.length} accessibility errors`,
            errorCount: errors.length,
            // Instruction for user
            nextStep: 'Upload your files to get corrections'
        });

    } catch (error) {
        console.error('Error receiving extension data:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing extension errors',
            error: error.message
        });
    }
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
        const files = req.files;

        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No files uploaded'
            });
        }

        const parsedErrors = typeof errors === 'string' ? JSON.parse(errors) : errors;

        // Process all files
        const results = [];
        for (const file of files) {
            const fileContent = await fs.readFile(file.path, 'utf-8');
            const correctedCode = await generateCorrectedCodeWithGemini(fileContent, parsedErrors);
            results.push({
                fileName: file.originalname,
                correctedCode
            });
        }

        // Create ZIP
        const zipPath = await createCombinedCorrectedZip(results, parsedErrors);

        res.download(zipPath, `corrected-files.zip`, async (err) => {
            await cleanupUploadedFiles(files);
            await fs.unlink(zipPath).catch(() => {});
            
            if (err) {
                console.error('Download error:', err);
            }
        });

    } catch (error) {
        console.error('Generate corrected code error:', error);
        
        if (req.files) {
            await cleanupUploadedFiles(req.files);
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
    generateCorrectedCode,
    receiveExtensionErrors
};