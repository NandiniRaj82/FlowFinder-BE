const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const { 
    processAccessibilityErrors, 
    generateSuggestions, 
    generateCorrectedCode 
} = require('../controllers/accessibilityController');

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const basename = path.basename(file.originalname, ext);
        cb(null, `${file.fieldname}-${uniqueSuffix}-${basename}${ext}`);
    }
});

// File filter function
const fileFilter = (req, file, cb) => {
    console.log('Filtering file:', file.originalname, 'MIME:', file.mimetype);
    
    // Allowed MIME types
    const allowedMimeTypes = [
        'text/html',
        'text/css',
        'text/javascript',
        'application/javascript',
        'application/json',
        'application/zip',
        'application/x-zip-compressed',
        'application/octet-stream' // For files without proper MIME type
    ];
    
    // Allowed extensions
    const allowedExtensions = /\.(html|htm|css|js|jsx|ts|tsx|json|zip)$/i;
    
    // Check MIME type or extension
    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.test(file.originalname)) {
        console.log('File accepted:', file.originalname);
        cb(null, true);
    } else {
        console.log('File rejected:', file.originalname);
        cb(new Error('Invalid file type'));
    }
};

// Multer configuration with explicit busboy limits
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 200 * 1024 * 1024, // 200MB in bytes
        files: 1, // Only allow 1 file at a time
        fields: 10, // Number of non-file fields
        parts: 100 // Total parts (files + fields)
    },
    fileFilter: fileFilter
});

// Log configuration on startup
console.log('Multer configured with:');
console.log('- Max file size: 200MB');
console.log('- Max files: 1');
console.log('- Storage: disk (uploads/)');

/**
 * POST /api/accessibility/process
 * Main endpoint - Process accessibility errors with Claude AI
 * Accepts both suggestions and full-correction in one endpoint
 */
router.post('/process', authMiddleware, (req, res, next) => {
    console.log('Processing accessibility request...');
    console.log('Content-Length:', req.headers['content-length']);
    next();
}, upload.single('file'), processAccessibilityErrors);

/**
 * POST /api/accessibility/suggestions
 * Get AI-powered suggestions only (no file upload needed)
 * Use this when you already have the code as string
 */
router.post('/suggestions', authMiddleware, generateSuggestions);

/**
 * POST /api/accessibility/correct
 * Get fully corrected code as ZIP file
 * Requires file upload
 */
router.post('/correct', authMiddleware, (req, res, next) => {
    console.log('Processing correction request...');
    console.log('Content-Length:', req.headers['content-length']);
    next();
}, upload.single('file'), generateCorrectedCode);

// Error handler specifically for multer errors on this route
router.use((err, req, res, next) => {
    console.error('Router error:', err.message);
    
    if (err instanceof multer.MulterError) {
        console.error('Multer error code:', err.code);
        
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File size exceeds 200MB limit. Please upload a smaller file or compress it.',
                error: 'FILE_TOO_LARGE',
                maxSize: '200MB',
                receivedSize: req.headers['content-length'] ? 
                    `${(parseInt(req.headers['content-length']) / 1024 / 1024).toFixed(2)}MB` : 
                    'Unknown'
            });
        }
        
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                message: 'Too many files uploaded. Please upload only one file at a time.',
                error: 'LIMIT_FILE_COUNT'
            });
        }
        
        return res.status(400).json({
            success: false,
            message: 'File upload error: ' + err.message,
            error: err.code
        });
    }
    
    // Handle other errors
    if (err.message === 'Invalid file type') {
        return res.status(400).json({
            success: false,
            message: 'Invalid file type. Please upload HTML, CSS, JS, or ZIP files only.',
            error: 'INVALID_FILE_TYPE'
        });
    }
    
    next(err);
});

module.exports = router;