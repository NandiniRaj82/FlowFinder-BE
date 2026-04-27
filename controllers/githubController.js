'use strict';

const { Octokit } = require('@octokit/rest');
const UserProfile = require('../models/userProfile');

// ─── GitHub OAuth helpers ─────────────────────────────────────────────────────
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/**
 * GET /api/github/connect?token=<firebase-id-token>
 * Redirects user to GitHub OAuth consent screen.
 * Token is passed as a query param because this is a browser redirect
 * and browsers cannot set Authorization headers on redirects.
 */
const connectGitHub = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Missing token query param' });
    }

    // Verify Firebase token inline
    const { getAuth } = require('../config/firebase');
    const firebaseAuth = getAuth();
    if (!firebaseAuth) {
      return res.status(503).json({ success: false, message: 'Firebase not configured' });
    }
    const decoded = await firebaseAuth.verifyIdToken(token);
    const uid = decoded.uid;

    // Embed uid in state so callback can link the account
    const state = Buffer.from(JSON.stringify({ uid })).toString('base64url');
    const scope = 'repo,read:user';
    const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=${scope}&state=${state}`;
    res.redirect(url);
  } catch (err) {
    console.error('[GitHub] connectGitHub error:', err.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};


/**
 * GET /api/github/callback
 * GitHub OAuth callback — exchanges code for access token
 */
const githubCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.redirect(`${FRONTEND_URL}/settings?github=error`);


    // Decode state to get uid
    const { uid } = JSON.parse(Buffer.from(state, 'base64url').toString());

    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      console.error('[GitHub] Token exchange failed:', tokenData.error_description);
      return res.redirect(`${FRONTEND_URL}/settings?github=error`);

    }

    const accessToken = tokenData.access_token;

    // Get GitHub user info
    const octokit = new Octokit({ auth: accessToken });
    const { data: githubUser } = await octokit.rest.users.getAuthenticated();

    // Store token in user profile.
    // IMPORTANT: include email in $setOnInsert so the required field
    // is satisfied when the UserProfile document doesn't exist yet.
    await UserProfile.findOneAndUpdate(
      { uid },
      {
        $set: {
          'github.accessToken': accessToken,
          'github.username': githubUser.login,
          'github.avatarUrl': githubUser.avatar_url,
          'github.connectedAt': new Date(),
        },
        $setOnInsert: {
          uid,
          // Fallback email so the required field is satisfied on first insert.
          // A real email will be set when the user next calls upsertFromFirebase.
          email: githubUser.email || `${githubUser.login}@github.placeholder`,
          displayName: githubUser.name || githubUser.login,
          photoURL: githubUser.avatar_url,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`[GitHub] Connected: ${githubUser.login} for uid ${uid}`);
    res.redirect(`${FRONTEND_URL}/settings?github=connected&username=${encodeURIComponent(githubUser.login)}`);

  } catch (err) {
    console.error('[GitHub] Callback error:', err);
    res.redirect(`${FRONTEND_URL}/settings?github=error`);

  }
};

/**
 * DELETE /api/github/disconnect
 */
const disconnectGitHub = async (req, res) => {
  try {
    await UserProfile.findOneAndUpdate(
      { uid: req.user.uid },
      { $unset: { github: '' } }
    );
    res.json({ success: true, message: 'GitHub disconnected.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/github/status
 * Returns whether GitHub is connected and basic user info
 */
const getGitHubStatus = async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ uid: req.user.uid }).select('github').lean();
    if (!profile?.github?.accessToken) {
      return res.json({ success: true, connected: false });
    }
    res.json({
      success: true,
      connected: true,
      username: profile.github.username,
      avatarUrl: profile.github.avatarUrl,
      connectedAt: profile.github.connectedAt,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Helper: get user's Octokit instance ─────────────────────────────────────
async function getUserOctokit(uid) {
  const profile = await UserProfile.findOne({ uid }).select('github.accessToken').lean();
  if (!profile?.github?.accessToken) {
    throw new Error('GitHub not connected. Please connect your GitHub account first.');
  }
  return new Octokit({ auth: profile.github.accessToken });
}

/**
 * GET /api/github/repos
 * List user's repos (sorted by pushed_at desc)
 */
const listRepos = async (req, res) => {
  try {
    const octokit = await getUserOctokit(req.user.uid);
    const { page = 1, per_page = 30, type = 'owner' } = req.query;

    const { data: repos } = await octokit.rest.repos.listForAuthenticatedUser({
      sort: 'pushed',
      direction: 'desc',
      per_page: Number(per_page),
      page: Number(page),
      type,
    });

    const simplified = repos.map(r => ({
      id: r.id,
      fullName: r.full_name,
      name: r.name,
      description: r.description,
      private: r.private,
      language: r.language,
      defaultBranch: r.default_branch,
      updatedAt: r.pushed_at,
      url: r.html_url,
      topics: r.topics || [],
    }));

    res.json({ success: true, repos: simplified });
  } catch (err) {
    console.error('[GitHub] listRepos:', err);
    res.status(err.message.includes('connected') ? 401 : 500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/github/repos/:owner/:repo/tree
 * Get file tree of a repo (flattened, only source files)
 */
const getRepoTree = async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { branch } = req.query;

    const octokit = await getUserOctokit(req.user.uid);

    // Get default branch if not specified
    let ref = branch;
    if (!ref) {
      const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
      ref = repoData.default_branch;
    }

    const { data: tree } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: 'true',
    });

    // Filter to source files only
    const SOURCE_EXT = /\.(jsx?|tsx?|html?|vue|svelte|css|scss|sass|less)$/i;
    const SKIP_DIRS = /(node_modules|\.git|\.next|dist|build|out|coverage|\.cache)\//;

    const files = tree.tree
      .filter(f => f.type === 'blob' && SOURCE_EXT.test(f.path) && !SKIP_DIRS.test(f.path))
      .map(f => ({ path: f.path, size: f.size, sha: f.sha }))
      .slice(0, 500); // cap at 500 files

    res.json({ success: true, files, ref, total: files.length });
  } catch (err) {
    console.error('[GitHub] getRepoTree:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/github/repos/:owner/:repo/file-contents
 * Batch fetch file contents (up to 30 files at once)
 */
const getFileContents = async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { paths, ref = 'HEAD' } = req.body;

    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ success: false, message: 'paths array is required.' });
    }
    if (paths.length > 50) {
      return res.status(400).json({ success: false, message: 'Max 50 files per request.' });
    }

    const octokit = await getUserOctokit(req.user.uid);

    const results = await Promise.allSettled(
      paths.map(async (path) => {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return { path, content, sha: data.sha };
      })
    );

    const files = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { path: paths[i], content: null, error: r.reason?.message }
    );

    res.json({ success: true, files });
  } catch (err) {
    console.error('[GitHub] getFileContents:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/github/repos/:owner/:repo/create-pr
 * Create a branch, commit fixes, open a pull request
 */
const createPullRequest = async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const {
      branchName,
      baseBranch,
      prTitle,
      prBody,
      files, // [{ path, content }]
    } = req.body;

    if (!branchName || !files?.length) {
      return res.status(400).json({ success: false, message: 'branchName and files are required.' });
    }

    const octokit = await getUserOctokit(req.user.uid);

    // 1. Get base branch SHA
    const { data: baseRef } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });
    const baseSha = baseRef.object.sha;

    // 2. Get base tree
    const { data: baseCommit } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseSha,
    });

    // 3. Create blobs for each changed file
    const blobs = await Promise.all(
      files.map(async (file) => {
        const { data: blob } = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: Buffer.from(file.content).toString('base64'),
          encoding: 'base64',
        });
        return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
      })
    );

    // 4. Create new tree
    const { data: newTree } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.tree.sha,
      tree: blobs,
    });

    // 5. Create commit
    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: `fix: FlowFinder accessibility fixes\n\n${prTitle || 'Automated accessibility improvements'}`,
      tree: newTree.sha,
      parents: [baseSha],
    });

    // 6. Create branch
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: newCommit.sha,
    });

    // 7. Create PR
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: prTitle || '♿ FlowFinder: Accessibility Fixes',
      body: prBody || 'Automated accessibility improvements generated by FlowFinder.',
      head: branchName,
      base: baseBranch,
    });

    console.log(`[GitHub] PR created: ${pr.html_url}`);
    res.json({
      success: true,
      pr: {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        branch: branchName,
      },
    });
  } catch (err) {
    console.error('[GitHub] createPullRequest:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  connectGitHub,
  githubCallback,
  disconnectGitHub,
  getGitHubStatus,
  listRepos,
  getRepoTree,
  getFileContents,
  createPullRequest,
  getUserOctokit,
};
