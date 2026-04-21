const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  connectGitHub,
  githubCallback,
  disconnectGitHub,
  getGitHubStatus,
  listRepos,
  getRepoTree,
  getFileContents,
  createPullRequest,
} = require('../controllers/githubController');

// OAuth flow — /connect is intentionally public (browser redirect cannot send headers)
// The Firebase token is passed as ?token= query param and verified inline
router.get('/connect', connectGitHub);
router.get('/callback', githubCallback);
router.delete('/disconnect', auth, disconnectGitHub);
router.get('/status', auth, getGitHubStatus);

// Repo operations
router.get('/repos', auth, listRepos);
router.get('/repos/:owner/:repo/tree', auth, getRepoTree);
router.post('/repos/:owner/:repo/file-contents', auth, getFileContents);
router.post('/repos/:owner/:repo/create-pr', auth, createPullRequest);

module.exports = router;
