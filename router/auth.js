const express = require('express');
const router = express.Router();
const { signup, signin } = require('../controllers/userController');
const { validateSignup, validateSignin } = require('../middleware/validation');

// Sign up route
router.post('/api/auth/signup', validateSignup, signup);

// Sign in route
router.post('/api/auth/signin', validateSignin, signin);

module.exports = router;