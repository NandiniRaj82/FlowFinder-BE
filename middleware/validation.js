const validateSignup = (req, res, next) => {
    const { fullName, email, password } = req.body;
    const errors = [];

    // Validate full name
    if (!fullName || fullName.trim().length === 0) {
        errors.push('Full name is required');
    } else if (fullName.trim().length < 2) {
        errors.push('Full name must be at least 2 characters long');
    }

    // Validate email
    if (!email || email.trim().length === 0) {
        errors.push('Email is required');
    } else {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            errors.push('Please provide a valid email address');
        }
    }

    // Validate password
    if (!password) {
        errors.push('Password is required');
    } else if (password.length < 6) {
        errors.push('Password must be at least 6 characters long');
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors
        });
    }

    next();
};

const validateSignin = (req, res, next) => {
    const { email, password } = req.body;
    const errors = [];

    // Validate email
    if (!email || email.trim().length === 0) {
        errors.push('Email is required');
    } else {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            errors.push('Please provide a valid email address');
        }
    }

    // Validate password
    if (!password) {
        errors.push('Password is required');
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors
        });
    }

    next();
};

module.exports = { validateSignup, validateSignin };