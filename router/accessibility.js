const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const { 
    processAccessibilityErrors, 
    generateSuggestions, 
    generateCorrectedCode,
    receiveExtensionErrors,
    chatAboutErrors  // NEW
} = require('../controllers/accessibilityController');

// Configure multer for MULTIPLE file uploads
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

const fileFilter = (req, file, cb) => {
    console.log('Filtering file:', file.originalname, 'MIME:', file.mimetype);
    
    const allowedMimeTypes = [
        'text/html',
        'text/css',
        'text/javascript',
        'application/javascript',
        'application/json',
        'application/zip',
        'application/x-zip-compressed',
        'application/octet-stream'
    ];
    
    const allowedExtensions = /\.(html|htm|css|js|jsx|ts|tsx|json|zip)$/i;
    
    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.test(file.originalname)) {
        console.log('File accepted:', file.originalname);
        cb(null, true);
    } else {
        console.log('File rejected:', file.originalname);
        cb(new Error('Invalid file type'));
    }
};

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 200 * 1024 * 1024,
        files: 50,
        fields: 20,
        parts: 100
    },
    fileFilter: fileFilter
});

console.log('Multer configured with:');
console.log('- Max file size: 200MB per file');
console.log('- Max files: 50');
console.log('- Storage: disk (uploads/)');

router.post('/process', authMiddleware, (req, res, next) => {
    console.log('Processing accessibility request...');
    console.log('Content-Length:', req.headers['content-length']);
    next();
}, upload.array('files', 50), processAccessibilityErrors);

// NEW — chat follow-up route
router.post('/chat', authMiddleware, chatAboutErrors);

router.post('/extension-errors', (req, res, next) => {
    console.log('Received errors from extension');
    next();
}, receiveExtensionErrors);

router.post('/suggestions', authMiddleware, generateSuggestions);

router.post('/correct', authMiddleware, (req, res, next) => {
    console.log('Processing correction request...');
    console.log('Content-Length:', req.headers['content-length']);
    next();
}, upload.array('files', 50), generateCorrectedCode);

router.use((err, req, res, next) => {
    console.error('Router error:', err.message);
    
    if (err instanceof multer.MulterError) {
        console.error('Multer error code:', err.code);
        
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File size exceeds 200MB limit. Please upload smaller files.',
                error: 'FILE_TOO_LARGE',
                maxSize: '200MB per file'
            });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                message: 'Too many files uploaded. Maximum 50 files at once.',
                error: 'LIMIT_FILE_COUNT',
                maxFiles: 50
            });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
                success: false,
                message: 'Unexpected field name. Use "files" for file uploads.',
                error: 'UNEXPECTED_FIELD'
            });
        }
        return res.status(400).json({
            success: false,
            message: 'File upload error: ' + err.message,
            error: err.code
        });
    }
    
    if (err.message === 'Invalid file type') {
        return res.status(400).json({
            success: false,
            message: 'Invalid file type. Please upload HTML, CSS, JS, TS, JSX, TSX, or ZIP files only.',
            error: 'INVALID_FILE_TYPE'
        });
    }
    
    next(err);
});

module.exports = router;