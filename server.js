const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;
const connectDB = require('./config/db');
const authRoutes = require('./router/auth');
const accessibilityRoutes = require('./router/accessibility');

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Connect to Database
connectDB();

// CORS Configuration with increased limits
app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:3001'], // Add your frontend URLs
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body Parser Middleware with 200MB limits
app.use(express.json({ 
    limit: '200mb',
    parameterLimit: 50000 
}));

app.use(express.urlencoded({ 
    extended: true, 
    limit: '200mb',
    parameterLimit: 50000
}));

app.use(express.static(path.join(__dirname, 'public')));

// Add request logging for debugging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path} - Content-Length: ${req.headers['content-length']}`);
    next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/accessibility', accessibilityRoutes);
app.use('/api/match-design', (req, res, next) => {
  res.setTimeout(120000); // 2 minutes
  next();
}, require('./router/matchDesignRoute'));
app.use('/api/redesign', require('./router/designSuggesterRoute'));
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'Server is running',
        aiProvider: 'Google Gemini',
        geminiApiConfigured: !!process.env.GEMINI_API_KEY,
        maxFileSize: '200MB'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Error handler - Enhanced
app.use((err, req, res, next) => {
    console.error('Error occurred:', err);
    
    // Handle Multer errors
    if (err.name === 'MulterError') {
        console.error('Multer Error Code:', err.code);
        
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File is too large. Maximum size is 200MB.',
                error: 'LIMIT_FILE_SIZE',
                maxSize: '200MB'
            });
        }
        
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                message: 'Too many files. Please upload only one file at a time.',
                error: 'LIMIT_FILE_COUNT'
            });
        }
        
        return res.status(400).json({
            success: false,
            message: 'File upload error',
            error: err.message,
            code: err.code
        });
    }
    
    // Handle invalid file type
    if (err.message === 'Invalid file type') {
        return res.status(400).json({
            success: false,
            message: 'Invalid file type. Please upload HTML, CSS, JS, or ZIP files only.',
            error: 'INVALID_FILE_TYPE'
        });
    }
    
    // Handle payload too large
    if (err.type === 'entity.too.large') {
        return res.status(413).json({
            success: false,
            message: 'Request payload is too large. Maximum size is 200MB.',
            error: 'PAYLOAD_TOO_LARGE'
        });
    }
    
    // Generic error
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Something went wrong!',
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
});

// Increase server timeout for large file uploads (5 minutes)
const server = app.listen(port, () => {
    console.log(`Server started on port ${port}`);
    console.log(`AI Provider: Google Gemini (FREE)`);
    console.log(`Gemini API: ${process.env.GEMINI_API_KEY ? 'Configured ✓' : 'Not configured ✗'}`);
    console.log(`Max file size: 200MB`);
});

// Set timeout to 5 minutes (300000ms) for large file uploads
server.setTimeout(300000);

// Handle server timeout
server.on('timeout', (socket) => {
    console.error('Server timeout - possibly due to large file upload');
    socket.end('HTTP/1.1 408 Request Timeout\r\n\r\n');
});

module.exports = app;