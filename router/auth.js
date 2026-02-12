const express = require('express');
const router = express.Router();
const { signup, signin } = require('../controllers/userController');
const { validateSignup, validateSignin } = require('../middleware/validation');

// Sign up route
router.post('/signup', validateSignup, signup);  
router.post('/signin', validateSignin, signin);  

module.exports = router;