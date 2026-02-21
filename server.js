const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const querystring = require('querystring');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { initQueue, submitPipelineJob, getQueueStats } = require('./queue');
const { startScheduler } = require('./scheduler');
const { generatePrompt, generateKlingJWT, generateImageBounded, callClaude, callGemini } = require('./pipeline');

const PORT = parseInt(process.env.PORT || '3333', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3334', 10);
const N8N_HOST = process.env.N8N_HOST || 'http://localhost:5678';
const JWT_SECRET = process.env.JWT_SECRET || 'loki-saas-secret-2024-lokiai-dashboard-stable';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_IDS = {
    starter: process.env.STRIPE_PRICE_STARTER || '',
    pro:     process.env.STRIPE_PRICE_PRO || '',
    premium: process.env.STRIPE_PRICE_PREMIUM || '',
};

// Google OAuth Client
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

// Meta (Facebook) OAuth Client
const META_APP_ID = process.env.META_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';

// Instagram Direct Login
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID || '1278102737683108';
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || 'fa4fce52a05992bc3c8a1d1bb1249e29';

// Public base URL (Railway deployment URL or local tunnel for dev)
const TUNNEL_BASE_URL = process.env.TUNNEL_BASE_URL || 'https://dashboard-production-ead3.up.railway.app';

let n8nCookie = '';

// ==================== JWT AUTH ====================
function generateToken(user) {
    return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

// Extract userId from Authorization header. Returns null if invalid/missing.
function getUserIdFromReq(req) {
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    if (!auth.startsWith('Bearer ')) return null;
    const decoded = verifyToken(auth.slice(7));
    return decoded?.userId || null;
}

// Middleware-style: returns userId or sends 401
function requireAuth(req, res) {
    // Bypass auth for sandbox testing
    if (process.env.BYPASS_AUTH === 'true') return _bypassUserId || 1;
    const userId = getUserIdFromReq(req);
    if (!userId) {
        jsonResponse(res, 401, { error: 'Authentication required' });
        return null;
    }
    return userId;
}
let _bypassUserId = null;

// ==================== AUTH HANDLERS ====================
async function handleSignup(req, res) {
    const body = await getRequestBody(req);
    try {
        const { email, password, name } = JSON.parse(body);
        if (!email || !password) {
            jsonResponse(res, 400, { error: 'Email and password are required' });
            return;
        }
        if (password.length < 6) {
            jsonResponse(res, 400, { error: 'Password must be at least 6 characters' });
            return;
        }
        const existing = await db.getUserByEmail(email.toLowerCase().trim());
        if (existing) {
            jsonResponse(res, 409, { error: 'An account with this email already exists' });
            return;
        }
        const passwordHash = await bcrypt.hash(password, 12);
        const user = await db.createUser(email.toLowerCase().trim(), passwordHash, name || '');
        const token = generateToken(user);
        console.log(`👤 New user signed up: ${user.email} (ID: ${user.id})`);
        jsonResponse(res, 201, { token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, runs_used: user.runs_used, runs_limit: user.runs_limit } });
    } catch (err) {
        console.error('Signup error:', err);
        jsonResponse(res, 500, { error: 'Signup failed: ' + err.message });
    }
}

async function handleLogin(req, res) {
    const body = await getRequestBody(req);
    try {
        const { email, password } = JSON.parse(body);
        if (!email || !password) {
            jsonResponse(res, 400, { error: 'Email and password are required' });
            return;
        }
        const user = await db.getUserByEmail(email.toLowerCase().trim());
        if (!user) {
            jsonResponse(res, 401, { error: 'Invalid email or password' });
            return;
        }
        if (!user.password_hash) {
            jsonResponse(res, 400, { error: 'This account uses Google sign-in. Please click "Sign in with Google" below.' });
            return;
        }
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            jsonResponse(res, 401, { error: 'Invalid email or password' });
            return;
        }
        const token = generateToken(user);
        console.log(`🔑 User logged in: ${user.email}`);
        jsonResponse(res, 200, { token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, runs_used: user.runs_used, runs_limit: user.runs_limit } });
    } catch (err) {
        console.error('Login error:', err);
        jsonResponse(res, 500, { error: 'Login failed' });
    }
}

async function handleMe(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const user = await db.getUserById(userId);
    if (!user) {
        jsonResponse(res, 404, { error: 'User not found' });
        return;
    }
    jsonResponse(res, 200, {
        id: user.id, email: user.email, name: user.name, plan: user.plan,
        runs_used: user.runs_used, runs_limit: user.runs_limit,
        onboarding_completed: user.onboarding_completed || false,
    });
}

// ==================== GOOGLE SIGN-IN ====================
function handleGoogleLogin(req, res) {
    const stateStr = crypto.randomBytes(16).toString('hex');
    pendingAuth[stateStr] = { platform: 'google-login', timestamp: Date.now() };

    // Use TUNNEL_BASE_URL (Railway public URL) if available, else localhost
    const baseUrl = TUNNEL_BASE_URL || `http://localhost:${PORT}`;
    const redirectUri = `${baseUrl}/auth/callback/youtube`;
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: stateStr,
        access_type: 'offline',
        prompt: 'select_account',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    console.log(`🔗 Google Sign-In redirect: ${authUrl.substring(0, 80)}...`);
    res.writeHead(302, { Location: authUrl });
    res.end();
}

async function handleGoogleLoginCallback(req, res) {
    const urlObj = new URL(req.url, TUNNEL_BASE_URL || `http://localhost:${PORT}`);
    const code = urlObj.searchParams.get('code');
    const stateStr = urlObj.searchParams.get('state');

    if (!code || !stateStr || !pendingAuth[stateStr]) {
        res.writeHead(302, { Location: '/login#error=invalid_state' });
        res.end();
        return;
    }

    delete pendingAuth[stateStr];

    try {
        const baseUrl = TUNNEL_BASE_URL || `http://localhost:${PORT}`;
        const redirectUri = `${baseUrl}/auth/callback/youtube`;
        const tokens = await httpsPost('https://oauth2.googleapis.com/token', {
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        });

        if (!tokens.access_token) {
            console.error('Google token exchange failed:', tokens);
            res.writeHead(302, { Location: '/login#error=token_exchange_failed' });
            res.end();
            return;
        }

        // Fetch user profile
        const profile = await httpsGet(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokens.access_token}`);
        if (!profile.email) {
            console.error('Google profile fetch failed:', profile);
            res.writeHead(302, { Location: '/login#error=profile_fetch_failed' });
            res.end();
            return;
        }

        const email = profile.email.toLowerCase().trim();
        const googleId = profile.id;
        const name = profile.name || '';

        // Find or create user
        let user = await db.getUserByGoogleId(googleId);
        if (!user) {
            // Check if email already exists (link accounts)
            user = await db.getUserByEmail(email);
            if (user) {
                await db.linkGoogleId(user.id, googleId);
                console.log(`🔗 Linked Google ID to existing user: ${email} (ID: ${user.id})`);
            } else {
                // Create new Google user
                user = await db.createGoogleUser(email, googleId, name);
                console.log(`👤 New Google user: ${email} (ID: ${user.id})`);
            }
        }

        const token = generateToken(user);
        const userData = encodeURIComponent(JSON.stringify({
            id: user.id, email: user.email, name: user.name || name,
            plan: user.plan, runs_used: user.runs_used, runs_limit: user.runs_limit
        }));

        console.log(`🔑 Google sign-in: ${email}`);
        res.writeHead(302, { Location: `/login#token=${token}&user=${userData}` });
        res.end();
    } catch (err) {
        console.error('Google login callback error:', err);
        res.writeHead(302, { Location: '/login#error=server_error' });
        res.end();
    }
}

// ==================== MIME TYPES ====================
const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
};

// ==================== N8N AUTH ====================
async function loginToN8n() {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ emailOrLdapLoginId: process.env.N8N_EMAIL || 'loki@local.dev', password: process.env.N8N_PASSWORD || 'n8nAdmin2026!' });
        const loginClient = N8N_HOST.startsWith('https') ? https : http;
        const req = loginClient.request(`${N8N_HOST}/rest/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => {
            const cookies = res.headers['set-cookie'];
            if (cookies) n8nCookie = cookies.map(c => c.split(';')[0]).join('; ');
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                console.log(res.statusCode === 200 ? '✅ Logged in to n8n' : '⚠️  n8n login: ' + res.statusCode);
                resolve(body);
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ==================== PROXY TO N8N ====================
const n8nClient = N8N_HOST.startsWith('https') ? https : http;

function proxyToN8n(clientReq, clientRes, apiPath) {
    const url = new URL(apiPath, N8N_HOST);
    const options = {
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: clientReq.method,
        headers: { 'Content-Type': 'application/json', 'Cookie': n8nCookie }
    };

    const proxyReq = n8nClient.request(options, async (proxyRes) => {
        const cookies = proxyRes.headers['set-cookie'];
        if (cookies) n8nCookie = cookies.map(c => c.split(';')[0]).join('; ');

        if (proxyRes.statusCode === 401) {
            proxyRes.resume();
            try {
                await loginToN8n();
                options.headers.Cookie = n8nCookie;
                const retry = n8nClient.request(options, (retryRes) => {
                    clientRes.writeHead(retryRes.statusCode, { 'Content-Type': retryRes.headers['content-type'] || 'application/json', 'Access-Control-Allow-Origin': '*' });
                    retryRes.pipe(clientRes);
                });
                retry.on('error', () => { clientRes.writeHead(502); clientRes.end('{}'); });
                retry.end();
            } catch { clientRes.writeHead(401); clientRes.end('{}'); }
            return;
        }

        clientRes.writeHead(proxyRes.statusCode, { 'Content-Type': proxyRes.headers['content-type'] || 'application/json', 'Access-Control-Allow-Origin': '*' });
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', () => { clientRes.writeHead(502); clientRes.end(JSON.stringify({ error: 'n8n unreachable' })); });
    if (['POST', 'PUT', 'PATCH'].includes(clientReq.method)) clientReq.pipe(proxyReq);
    else proxyReq.end();
}

// ==================== AGENT CONFIG API (per-user via DB) ====================
async function handleAgentConfigGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const row = await db.getActiveConfig(userId);
    if (!row) {
        jsonResponse(res, 404, { error: 'No config found' });
        return;
    }
    const config = row.config || {};
    jsonResponse(res, 200, {
        character_description: config.character_description || '',
        prompts: config.prompts || [],
        actions: config.actions || [],
        scenes: config.scenes || [],
        variations: config.variations || {},
        content_rules: config.content_rules || '',
        reference_image_url: config.reference_image_url || '',
        custom_prompt_override: config.custom_prompt_override || '',
        music: config.music || [],
        caption_template: config.caption_template || '',
        skip_llm_merge: config.skip_llm_merge || false
    });
    // Clear the override after it's been read (one-time use)
    if (config.custom_prompt_override) {
        config.custom_prompt_override = '';
        await db.saveActiveConfig(userId, config);
    }
}

async function handleAgentConfigPost(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const incoming = JSON.parse(body);
        const row = await db.getActiveConfig(userId);
        if (!row) { jsonResponse(res, 404, { error: 'No active config' }); return; }
        const config = row.config || {};
        // Merge incoming fields
        for (const key of ['character_description', 'prompts', 'actions', 'scenes', 'variations', 'content_rules', 'reference_image_url', 'custom_prompt_override', 'music', 'caption_template', 'skip_llm_merge']) {
            if (incoming[key] !== undefined) config[key] = incoming[key];
        }
        await db.saveActiveConfig(userId, config);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        jsonResponse(res, 400, { error: 'Invalid JSON: ' + err.message });
    }
}

async function handleAgentConfigList(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const configs = await db.listConfigs(userId);
    const activeSlot = configs.find(c => c.is_active)?.slot ?? 0;
    jsonResponse(res, 200, {
        activeConfig: activeSlot,
        configs: configs.map(c => ({ index: c.slot, name: c.name }))
    });
}

async function handleAgentConfigSwitch(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { index } = JSON.parse(body);
        if (index < 0 || index > 2) {
            jsonResponse(res, 400, { error: 'Invalid config index' });
            return;
        }
        const row = await db.switchConfig(userId, index);
        if (!row) { jsonResponse(res, 404, { error: 'Config not found' }); return; }
        const config = row.config_json || {};
        jsonResponse(res, 200, {
            character_description: config.character_description || '',
            prompts: config.prompts || [],
            actions: config.actions || [],
            scenes: config.scenes || [],
            variations: config.variations || {},
            content_rules: config.content_rules || '',
            reference_image_url: config.reference_image_url || '',
            custom_prompt_override: config.custom_prompt_override || '',
            music: config.music || [],
            caption_template: config.caption_template || '',
            skip_llm_merge: config.skip_llm_merge || false
        });
    } catch (err) {
        jsonResponse(res, 400, { error: 'Invalid JSON: ' + err.message });
    }
}

async function handleAgentConfigRename(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { index, name } = JSON.parse(body);
        if (index < 0 || index > 2) {
            jsonResponse(res, 400, { error: 'Invalid config index' });
            return;
        }
        await db.renameConfig(userId, index, name);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        jsonResponse(res, 400, { error: 'Invalid JSON: ' + err.message });
    }
}

// ==================== DATA ENDPOINTS (per-user via DB) ====================
async function handleDataGet(collection, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const row = await db.getActiveConfig(userId);
    const config = row?.config || {};
    jsonResponse(res, 200, config[collection] || []);
}

async function handleDataPost(collection, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const items = JSON.parse(body);
        const row = await db.getActiveConfig(userId);
        if (!row) { jsonResponse(res, 404, { error: 'No active config' }); return; }
        const config = row.config || {};
        config[collection] = items;
        await db.saveActiveConfig(userId, config);
        jsonResponse(res, 200, { success: true, count: items.length });
    } catch (err) {
        jsonResponse(res, 400, { error: 'Invalid JSON: ' + err.message });
    }
}

// n8n-compatible endpoint: returns data for the workflow (accepts userId query param)
async function handleDataN8n(collection, req, res) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const userId = parseInt(urlObj.searchParams.get('userId'));
    if (!userId) {
        jsonResponse(res, 400, { error: 'userId query param required' });
        return;
    }
    const row = await db.getActiveConfig(userId);
    const config = row?.config || {};
    jsonResponse(res, 200, config[collection] || []);
}

// ==================== OAUTH HELPERS ====================
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve({ raw: body }); }
            });
        }).on('error', reject);
    });
}

function httpsPost(url, data, headers = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const postData = typeof data === 'string' ? data : querystring.stringify(data);
        const req = https.request({
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                ...headers
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve({ raw: body }); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ==================== SOCIAL MEDIA PLATFORM CONFIGS ====================
function getPlatformOAuthConfig(platform, appId, appSecret) {
    // Use TUNNEL_BASE_URL for all platforms when available (Railway deployment)
    const redirectUri = TUNNEL_BASE_URL
        ? `${TUNNEL_BASE_URL}/auth/callback/${platform}`
        : `http://localhost:${PORT}/auth/callback/${platform}`;

    switch (platform) {
        case 'youtube':
            return {
                authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
                tokenUrl: 'https://oauth2.googleapis.com/token',
                clientId: GOOGLE_CLIENT_ID,
                clientSecret: GOOGLE_CLIENT_SECRET,
                scopes: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/spreadsheets.readonly',
                redirectUri,
                extraParams: { access_type: 'offline', prompt: 'consent' }
            };
        case 'instagram':
            return {
                authUrl: 'https://www.instagram.com/oauth/authorize',
                tokenUrl: 'https://api.instagram.com/oauth/access_token',
                longLivedTokenUrl: 'https://graph.instagram.com/access_token',
                clientId: appId || INSTAGRAM_APP_ID,
                clientSecret: appSecret || INSTAGRAM_APP_SECRET,
                scopes: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments',
                redirectUri,
                isInstagramDirect: true,
                extraParams: {}
            };
        case 'facebook':
            return {
                authUrl: 'https://www.facebook.com/v22.0/dialog/oauth',
                tokenUrl: 'https://graph.facebook.com/v22.0/oauth/access_token',
                clientId: appId || META_APP_ID,
                clientSecret: appSecret || META_APP_SECRET,
                scopes: 'pages_manage_posts,pages_read_engagement,publish_video',
                redirectUri
            };
        case 'twitter':
            return {
                authUrl: 'https://twitter.com/i/oauth2/authorize',
                tokenUrl: 'https://api.twitter.com/2/oauth2/token',
                clientId: appId,
                clientSecret: appSecret,
                scopes: 'tweet.write tweet.read users.read offline.access',
                redirectUri,
                usePKCE: true
            };
        case 'tiktok':
            return {
                authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
                tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
                clientId: appId,
                clientSecret: appSecret,
                scopes: 'video.upload,video.publish,user.info.basic',
                redirectUri
            };
        default:
            return null;
    }
}

// Pending OAuth state storage (includes userId for per-user token storage)
const pendingAuth = {};

// Store last OAuth error per user+platform so frontend can display it
const lastAuthErrors = {}; // keyed by `${userId}-${platform}`

// ==================== SOCIAL ROUTE HANDLERS (per-user) ====================
async function handleSocialConnect(platform, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    let appId, appSecret, characterCardId;
    // Always try to read body (for characterCardId and possibly appId/appSecret)
    const body = await getRequestBody(req);
    if (body) {
        try {
            const parsed = JSON.parse(body);
            appId = parsed.appId;
            appSecret = parsed.appSecret;
            characterCardId = parsed.characterCardId || null;
        } catch {
            // For platforms that require appId/appSecret, this is an error
            if (!['youtube', 'instagram', 'facebook'].includes(platform)) {
                jsonResponse(res, 400, { error: 'Invalid request body' });
                return;
            }
        }
    }

    const oauthConfig = getPlatformOAuthConfig(platform, appId, appSecret);
    if (!oauthConfig) { jsonResponse(res, 400, { error: 'Unknown platform' }); return; }

    // Store app credentials in DB for later use
    if (appId && appSecret) {
        await db.saveSocialConnection(userId, platform, {
            appCredentials: { appId, appSecret },
            connected: false,
        }, characterCardId);
    }

    // For YouTube — enable YouTube Data API first
    if (platform === 'youtube') {
        console.log('📺 Enabling YouTube Data API...');
        try {
            await execPromise('gcloud services enable youtube.googleapis.com --project=gen-lang-client-0855593245 2>/dev/null || true');
        } catch (e) {
            console.log('YouTube API enable:', e.message);
        }
        try {
            await execPromise(`gcloud auth application-default set-quota-project gen-lang-client-0855593245 2>/dev/null || true`);
        } catch (e) { }
    }

    // Generate state with userId embedded (and characterCardId if provided)
    const stateStr = crypto.randomBytes(16).toString('hex');
    pendingAuth[stateStr] = { platform, oauthConfig, userId, characterCardId, timestamp: Date.now() };

    const params = new URLSearchParams({
        client_id: oauthConfig.clientId,
        redirect_uri: oauthConfig.redirectUri,
        response_type: 'code',
        scope: oauthConfig.scopes,
        state: stateStr,
        ...(oauthConfig.extraParams || {})
    });

    if (oauthConfig.usePKCE) {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        pendingAuth[stateStr].codeVerifier = verifier;
        params.set('code_challenge', challenge);
        params.set('code_challenge_method', 'S256');
    }

    if (platform === 'tiktok') {
        params.delete('client_id');
        params.set('client_key', oauthConfig.clientId);
    }

    const authUrl = `${oauthConfig.authUrl}?${params.toString()}`;
    console.log(`🔗 OAuth URL for ${platform} (user ${userId}): ${authUrl.substring(0, 80)}...`);
    jsonResponse(res, 200, { authUrl });
}

async function handleAuthCallback(platform, req, res) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const code = urlObj.searchParams.get('code');
    const stateStr = urlObj.searchParams.get('state');

    if (!code || !stateStr || !pendingAuth[stateStr]) {
        console.error('[OAuth] Callback failed: invalid state or missing code', { hasCode: !!code, hasState: !!stateStr, stateExists: !!pendingAuth[stateStr] });
        htmlResponse(res, `
        <div style="font-family:Inter,system-ui,sans-serif;background:#0a0a0f;color:#f0f0f5;height:100vh;display:flex;align-items:center;justify-content:center">
          <div style="max-width:420px;text-align:center;padding:32px">
            <div style="font-size:3rem;margin-bottom:16px">⚠️</div>
            <h2 style="color:#ef4444;margin-bottom:12px">Connection Failed</h2>
            <p style="color:rgba(240,240,245,0.7);line-height:1.6">The authorization session expired or was invalid. Please close this window and click <strong>Connect</strong> again.</p>
            <button onclick="window.close()" style="margin-top:24px;padding:10px 32px;background:#6366f1;color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px">Close</button>
          </div>
        </div>`);
        return;
    }

    const { oauthConfig, codeVerifier, userId, characterCardId } = pendingAuth[stateStr];
    delete pendingAuth[stateStr];

    try {
        const tokenData = {
            client_id: oauthConfig.clientId,
            client_secret: oauthConfig.clientSecret,
            code,
            redirect_uri: oauthConfig.redirectUri,
            grant_type: 'authorization_code',
        };

        if (codeVerifier) tokenData.code_verifier = codeVerifier;
        if (platform === 'tiktok') {
            tokenData.client_key = tokenData.client_id;
            delete tokenData.client_id;
        }

        console.log(`🔄 Exchanging code for tokens (${platform}, user ${userId})...`);
        let tokens = await httpsPost(oauthConfig.tokenUrl, tokenData);

        // Instagram: exchange for long-lived token
        if (oauthConfig.isInstagramDirect && tokens.access_token) {
            console.log(`🔄 Exchanging for long-lived Instagram token...`);
            const longLivedUrl = `${oauthConfig.longLivedTokenUrl}?grant_type=ig_exchange_token&client_secret=${oauthConfig.clientSecret}&access_token=${tokens.access_token}`;
            try {
                const llResp = await httpsGet(longLivedUrl);
                if (llResp.access_token) {
                    tokens.access_token = llResp.access_token;
                    tokens.expires_in = llResp.expires_in || 5184000;
                    tokens.token_type = llResp.token_type;
                    console.log(`✅ Got long-lived Instagram token (${llResp.expires_in}s)`);
                }
            } catch (e) {
                console.log('⚠️ Long-lived token exchange failed, using short-lived:', e.message);
            }
        }

        if (tokens.access_token || tokens.data?.access_token) {
            const accessToken = tokens.access_token || tokens.data.access_token;
            const refreshToken = tokens.refresh_token || tokens.data?.refresh_token;

            // Save tokens to database (per-user, optionally per-character)
            await db.saveSocialConnection(userId, platform, {
                tokens: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
                    raw: tokens
                },
                connected: true,
                connectedAt: new Date().toISOString(),
            }, characterCardId);

            // Resolve platform-specific user_id (Instagram needs it for Reels upload)
            let platformUserId = tokens.user_id || tokens.data?.user_id;
            if (!platformUserId && platform === 'instagram') {
                try {
                    const meResp = await httpsGet(`https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${accessToken}`);
                    platformUserId = meResp.user_id || meResp.id;
                    console.log(`📸 Instagram user_id resolved: ${platformUserId}`);
                } catch (e) {
                    console.log('⚠️ Could not fetch Instagram user_id:', e.message);
                }
            }
            console.log(`🔑 Saving platform token for ${platform}, user_id: ${platformUserId}`);

            // Also save to platform_tokens so queue workers can read them
            await db.savePlatformToken(userId, platform, accessToken, refreshToken,
                new Date(Date.now() + ((tokens.expires_in || 3600) * 1000)).toISOString(),
                { user_id: platformUserId ? String(platformUserId) : null },
                characterCardId
            );

            console.log(`✅ ${platform} connected for user ${userId}!`);
            delete lastAuthErrors[`${userId}-${platform}`];

            // Create n8n credential
            const conn = await db.getSocialConnection(userId, platform, characterCardId);
            await createN8nCredential(platform, {
                tokens: { access_token: accessToken, refresh_token: refreshToken, raw: tokens },
                appId: conn?.app_credentials?.appId,
                appSecret: conn?.app_credentials?.appSecret,
            }, userId, characterCardId);

            htmlResponse(res, `
        <div style="font-family:Inter,sans-serif;background:#0a0a0f;color:#f0f0f5;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column">
          <div style="font-size:3rem;margin-bottom:16px">✅</div>
          <h2 style="color:#10b981">${platform.charAt(0).toUpperCase() + platform.slice(1)} Connected!</h2>
          <p style="color:rgba(240,240,245,0.6);margin-top:8px">You can close this window now.</p>
          <script>setTimeout(()=>window.close(),2000)</script>
        </div>
      `);
        } else {
            const errorMsg = tokens.error_message || tokens.error?.message || tokens.error_description || 'Instagram did not return an access token';
            console.error(`[OAuth] Token exchange failed for ${platform} (user ${userId}):`, JSON.stringify(tokens));
            lastAuthErrors[`${userId}-${platform}`] = errorMsg;
            htmlResponse(res, `
        <div style="font-family:Inter,system-ui,sans-serif;background:#0a0a0f;color:#f0f0f5;height:100vh;display:flex;align-items:center;justify-content:center">
          <div style="max-width:480px;text-align:center;padding:32px">
            <div style="font-size:3rem;margin-bottom:16px">❌</div>
            <h2 style="color:#ef4444;margin-bottom:12px">Connection Failed</h2>
            <p style="color:rgba(240,240,245,0.85);line-height:1.6;margin-bottom:20px">${errorMsg}</p>
            <div style="text-align:left;background:rgba(255,255,255,0.05);border-radius:10px;padding:20px;margin-bottom:24px">
              <h3 style="color:#f0f0f5;font-size:14px;margin:0 0 12px">Common fixes:</h3>
              <ul style="color:rgba(240,240,245,0.7);font-size:13px;line-height:1.8;margin:0;padding-left:20px">
                <li>Your Instagram account must be a <strong style="color:#f0f0f5">Business</strong> or <strong style="color:#f0f0f5">Creator</strong> account (not Personal)</li>
                <li>If the app is in development mode, your account must be added as a <strong style="color:#f0f0f5">tester</strong> in Meta Developer Console</li>
                <li>Make sure your Facebook Page is linked to your Instagram account</li>
              </ul>
            </div>
            <button onclick="window.close()" style="padding:10px 32px;background:#6366f1;color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px">Close</button>
          </div>
        </div>`);
        }
    } catch (err) {
        console.error(`[OAuth] Callback exception for ${platform} (user ${userId}):`, err);
        lastAuthErrors[`${userId}-${platform}`] = err.message;
        htmlResponse(res, `
        <div style="font-family:Inter,system-ui,sans-serif;background:#0a0a0f;color:#f0f0f5;height:100vh;display:flex;align-items:center;justify-content:center">
          <div style="max-width:420px;text-align:center;padding:32px">
            <div style="font-size:3rem;margin-bottom:16px">⚠️</div>
            <h2 style="color:#ef4444;margin-bottom:12px">Connection Error</h2>
            <p style="color:rgba(240,240,245,0.7);line-height:1.6">${err.message}</p>
            <button onclick="window.close()" style="margin-top:24px;padding:10px 32px;background:#6366f1;color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px">Close</button>
          </div>
        </div>`);
    }
}

// Create n8n credential for a connected platform
async function createN8nCredential(platform, platformConfig, userId, characterCardId = null) {
    const tokens = platformConfig.tokens;
    let credType, credName, credData;

    switch (platform) {
        case 'youtube':
            credType = 'googleOAuth2Api';
            credName = `User${userId} YouTube`;
            credData = { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, oauthTokenData: tokens.raw };
            break;
        case 'facebook':
            credType = 'facebookGraphApi';
            credName = `User${userId} Facebook`;
            credData = { accessToken: tokens.access_token };
            break;
        case 'instagram':
            credType = 'facebookGraphApi';
            credName = `User${userId} Instagram`;
            credData = { accessToken: tokens.access_token };
            break;
        case 'twitter':
            credType = 'twitterOAuth2Api';
            credName = `User${userId} X`;
            credData = { clientId: platformConfig.appId, clientSecret: platformConfig.appSecret, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, oauthTokenData: tokens.raw };
            break;
        case 'tiktok':
            credType = 'httpHeaderAuth';
            credName = `User${userId} TikTok`;
            credData = { name: 'Authorization', value: `Bearer ${tokens.access_token}` };
            break;
        default:
            return;
    }

    try {
        const postData = JSON.stringify({ name: credName, type: credType, data: credData });
        const req = n8nClient.request(`${N8N_HOST}/rest/credentials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': n8nCookie, 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', async () => {
                if (res.statusCode < 300) {
                    console.log(`📝 n8n credential "${credName}" created`);
                    try {
                        const parsed = JSON.parse(body);
                        const credId = parsed.data?.id || parsed.id;
                        await db.saveSocialConnection(userId, platform, {
                            tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token, raw: tokens.raw },
                            connected: true,
                            connectedAt: new Date().toISOString(),
                            n8nCredentialId: String(credId),
                        }, characterCardId);
                    } catch (e) { console.log('Credential ID save error:', e.message); }
                } else {
                    console.log(`⚠️ n8n credential creation: ${res.statusCode} ${body.substring(0, 200)}`);
                }
            });
        });
        req.on('error', (err) => console.error('n8n credential error:', err.message));
        req.write(postData);
        req.end();
    } catch (err) {
        console.error('Credential creation error:', err.message);
    }
}

async function handleSocialDisconnect(platform, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    // Read characterCardId from query param or request body
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    let characterCardId = urlObj.searchParams.get('characterCardId') || null;
    if (!characterCardId) {
        const body = await getRequestBody(req);
        if (body) {
            try { characterCardId = JSON.parse(body).characterCardId || null; } catch {}
        }
    }

    try {
        // Delete the platform token
        await db.deletePlatformToken(userId, platform, characterCardId);

        // Reset social connection to disconnected
        await db.saveSocialConnection(userId, platform, {
            tokens: null,
            connected: false,
            connectedAt: null,
        }, characterCardId);

        // Clear any stored auth error
        delete lastAuthErrors[`${userId}-${platform}`];

        console.log(`🔌 ${platform} disconnected for user ${userId}${characterCardId ? ` (card ${characterCardId})` : ''}`);
        jsonResponse(res, 200, { success: true, message: `${platform} disconnected` });
    } catch (err) {
        console.error(`[Disconnect] Error for ${platform} (user ${userId}):`, err);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleSocialStatus(platform, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    // Read characterCardId from query param
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const characterCardId = urlObj.searchParams.get('characterCardId') || null;

    // Cross-check platform_tokens to ensure the token actually exists
    // (social_connections may say "connected" but token can be lost on redeploy)
    const allTokens = await db.getAllPlatformTokens(userId, characterCardId);

    if (platform) {
        const hasToken = !!allTokens[platform]?.access_token;
        const lastError = lastAuthErrors[`${userId}-${platform}`] || null;
        jsonResponse(res, 200, {
            connected: hasToken,
            connectedAt: hasToken ? allTokens[platform]?.created_at || null : null,
            lastError: hasToken ? null : lastError
        });
    } else {
        const result = {};
        for (const p of ['youtube', 'instagram', 'facebook', 'twitter', 'tiktok']) {
            result[p] = { connected: !!allTokens[p]?.access_token };
        }
        jsonResponse(res, 200, result);
    }
}

// ==================== PLATFORM TOKEN (for n8n workflow, uses userId query param) ====================
async function handlePlatformToken(platform, req, res) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const userId = parseInt(urlObj.searchParams.get('userId')) || getUserIdFromReq(req);
    if (!userId) {
        jsonResponse(res, 401, { error: 'userId required' });
        return;
    }
    const conn = await db.getSocialConnection(userId, platform);
    const tokens = conn?.tokens_json;
    if (tokens?.access_token) {
        if (platform === 'instagram') {
            try {
                const meData = await httpsGet(
                    `https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${tokens.access_token}`
                );
                jsonResponse(res, 200, {
                    access_token: tokens.access_token,
                    user_id: meData.user_id || String(tokens.raw?.user_id || ''),
                    username: meData.username || null,
                    expires_at: tokens.expires_at || null
                });
            } catch (e) {
                jsonResponse(res, 200, {
                    access_token: tokens.access_token,
                    user_id: String(tokens.raw?.user_id || ''),
                    expires_at: tokens.expires_at || null
                });
            }
        } else {
            jsonResponse(res, 200, {
                access_token: tokens.access_token,
                user_id: tokens.raw?.user_id ? String(tokens.raw.user_id) : null,
                expires_at: tokens.expires_at || null
            });
        }
    } else {
        jsonResponse(res, 404, { error: `${platform} not connected` });
    }
}

// ==================== HELPERS ====================
function getRequestBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
    });
}

function getRawBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

function jsonResponse(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

function htmlResponse(res, html) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
}

function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
}

function serveStaticFile(filePath, res) {
    const ext = path.extname(filePath);
    const mimeType = MIME[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
    });
}

// ==================== ASSET SAVING (per-user) ====================
const ASSETS_DIR = path.join(__dirname, 'assets');

function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function uploadToTempHost(filePath, filename) {
    return new Promise((resolve, reject) => {
        const boundary = '----FormBoundary' + Date.now().toString(36);
        const fileBuffer = fs.readFileSync(filePath);
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n24h\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`;
        const footer = `\r\n--${boundary}--\r\n`;
        const body = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);
        const options = {
            hostname: 'litterbox.catbox.moe',
            path: '/resources/internals/api.php',
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const url = data.trim();
                if (url.startsWith('http')) resolve(url);
                else reject(new Error(`Upload response: ${url.substring(0, 200)}`));
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function handleSaveAsset(req, res) {
    // Accept userId from JWT or from body (for n8n workflow callbacks)
    let userId = getUserIdFromReq(req);
    const body = await getRequestBody(req);
    try {
        const parsed = JSON.parse(body);
        const { url, base64, type, executionId, prompt, metadata } = parsed;
        // Allow userId from body for n8n callbacks
        if (!userId && parsed.userId) userId = parseInt(parsed.userId);
        if (!userId) { jsonResponse(res, 401, { error: 'userId required' }); return; }

        if ((!url && !base64) || !type) {
            jsonResponse(res, 400, { error: 'url or base64 required, plus type (image|video)' });
            return;
        }

        // Per-user asset directories
        const userDir = path.join(ASSETS_DIR, String(userId));
        const subdir = type === 'video' ? 'videos' : 'images';
        const targetDir = path.join(userDir, subdir);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const ext = type === 'video' ? '.mp4' : '.png';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${timestamp}_exec${executionId || 'unknown'}${ext}`;
        const savePath = path.join(targetDir, filename);

        let fileData;
        if (base64) {
            console.log(`💾 Decoding base64 ${type} (${(base64.length * 0.75 / 1024).toFixed(1)} KB)...`);
            fileData = Buffer.from(base64, 'base64');
        } else {
            console.log(`💾 Downloading ${type}: ${url.substring(0, 60)}...`);
            fileData = await downloadFile(url);
        }
        fs.writeFileSync(savePath, fileData);
        console.log(`✅ Saved ${type}: ${filename} (${(fileData.length / 1024).toFixed(1)} KB) for user ${userId}`);

        let publicUrl = url || null;
        if (base64 && type === 'image') {
            try {
                publicUrl = await uploadToTempHost(savePath, filename);
                console.log(`🌐 Public URL: ${publicUrl}`);
            } catch (uploadErr) {
                console.error('Temp upload failed:', uploadErr.message);
            }
        }

        // Log to database
        const assetRow = await db.logAsset(userId, {
            type,
            filename,
            path: `/assets/${userId}/${subdir}/${filename}`,
            sourceUrl: url || 'gemini-base64',
            publicUrl,
            executionId: executionId || null,
            prompt: prompt || null,
            metadata: metadata || {},
            size: fileData.length
        });

        jsonResponse(res, 200, { success: true, asset: assetRow });
    } catch (err) {
        console.error('Asset save error:', err.message);
        jsonResponse(res, 500, { error: 'Failed to save asset: ' + err.message });
    }
}

async function handleAssetsGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const assets = await db.getAssets(userId);
    // Map to same format the frontend expects
    const mapped = assets.map(a => ({
        id: String(a.id),
        type: a.type,
        filename: a.filename,
        path: a.path,
        sourceUrl: a.source_url,
        publicUrl: a.public_url,
        executionId: a.execution_id,
        prompt: a.prompt,
        metadata: a.metadata || {},
        savedAt: a.created_at,
        size: a.size
    }));
    jsonResponse(res, 200, mapped);
}

// ==================== PIPELINE EVENT LOG READER ====================
const N8N_EVENT_LOG = path.join(process.env.HOME || '/Users/loki', '.n8n', 'n8nEventLog.log');

function handlePipelineEvents(execId, req, res) {
    try {
        const logContent = fs.readFileSync(N8N_EVENT_LOG, 'utf8');
        const lines = logContent.trim().split('\n');
        const recentLines = lines.slice(-500);

        const nodeEvents = {};
        for (const line of recentLines) {
            try {
                const evt = JSON.parse(line);
                if (evt.payload && evt.payload.executionId === execId) {
                    const nodeName = evt.payload.nodeName;
                    if (!nodeName) continue;
                    if (!nodeEvents[nodeName]) {
                        nodeEvents[nodeName] = { started: 0, finished: 0, errors: 0, lastEvent: null, lastTime: null };
                    }
                    if (evt.eventName === 'n8n.node.started') {
                        nodeEvents[nodeName].started++;
                        nodeEvents[nodeName].lastEvent = 'started';
                        nodeEvents[nodeName].lastTime = evt.ts;
                    } else if (evt.eventName === 'n8n.node.finished') {
                        nodeEvents[nodeName].finished++;
                        nodeEvents[nodeName].lastEvent = 'finished';
                        nodeEvents[nodeName].lastTime = evt.ts;
                    } else if (evt.eventName && evt.eventName.includes('error')) {
                        nodeEvents[nodeName].errors++;
                        nodeEvents[nodeName].lastEvent = 'error';
                        nodeEvents[nodeName].lastTime = evt.ts;
                    }
                }
            } catch (e) { /* skip unparseable lines */ }
        }

        jsonResponse(res, 200, { executionId: execId, nodes: nodeEvents });
    } catch (err) {
        jsonResponse(res, 500, { error: 'Could not read event log: ' + err.message });
    }
}

// ==================== MUSIC POOL (per-user, stored in config_json) ====================
async function handleUploadMusic(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        jsonResponse(res, 400, { error: 'Content-Type must be multipart/form-data' });
        return;
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
        jsonResponse(res, 400, { error: 'Missing boundary in multipart request' });
        return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
        try {
            const body = Buffer.concat(chunks);
            const boundaryBuf = Buffer.from('--' + boundary);

            let start = body.indexOf(boundaryBuf) + boundaryBuf.length;
            let end = body.indexOf(boundaryBuf, start);
            const parts = [];
            while (end !== -1) {
                parts.push(body.slice(start, end));
                start = end + boundaryBuf.length;
                end = body.indexOf(boundaryBuf, start);
            }

            let fileData = null;
            let originalName = 'track.mp3';
            let trackName = '';

            for (const part of parts) {
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd === -1) continue;
                const headers = part.slice(0, headerEnd).toString();
                const content = part.slice(headerEnd + 4, part.length - 2);

                if (headers.includes('filename=')) {
                    const fnMatch = headers.match(/filename="([^"]+)"/);
                    if (fnMatch) originalName = fnMatch[1];
                    fileData = content;
                } else if (headers.includes('name="name"')) {
                    trackName = content.toString().trim();
                }
            }

            if (!fileData || fileData.length === 0) {
                jsonResponse(res, 400, { error: 'No file data received' });
                return;
            }

            // Per-user music directory
            const musicDir = path.join(ASSETS_DIR, String(userId), 'music');
            if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir, { recursive: true });

            const ext = path.extname(originalName) || '.mp3';
            const safeName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const savePath = path.join(musicDir, safeName);
            fs.writeFileSync(savePath, fileData);

            // Add to config_json in DB
            const row = await db.getActiveConfig(userId);
            if (!row) { jsonResponse(res, 404, { error: 'No active config' }); return; }
            const config = row.config || {};
            if (!config.music) config.music = [];
            const nextId = config.music.length > 0 ? Math.max(...config.music.map(m => m.id || 0)) + 1 : 1;
            const entry = {
                id: nextId,
                name: trackName || path.basename(originalName, ext),
                file: safeName,
                pinned: false
            };
            config.music.push(entry);
            await db.saveActiveConfig(userId, config);

            console.log(`🎵 Music uploaded: ${safeName} (${(fileData.length / 1024).toFixed(1)} KB) for user ${userId}`);
            jsonResponse(res, 200, { success: true, track: entry });
        } catch (err) {
            console.error('Music upload error:', err);
            jsonResponse(res, 500, { error: 'Upload failed: ' + err.message });
        }
    });
}

async function handleUploadMotionReference(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        jsonResponse(res, 400, { error: 'Content-Type must be multipart/form-data' });
        return;
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
        jsonResponse(res, 400, { error: 'Missing boundary' });
        return;
    }

    const chunks = [];
    let totalSize = 0;
    req.on('data', chunk => {
        totalSize += chunk.length;
        if (totalSize > 50 * 1024 * 1024) { // 50MB limit
            req.destroy();
            jsonResponse(res, 400, { error: 'File too large (max 50MB)' });
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', async () => {
        try {
            const body = Buffer.concat(chunks);
            const boundaryBuf = Buffer.from('--' + boundary);
            let start = body.indexOf(boundaryBuf) + boundaryBuf.length;
            let end = body.indexOf(boundaryBuf, start);
            const parts = [];
            while (end !== -1) {
                parts.push(body.slice(start, end));
                start = end + boundaryBuf.length;
                end = body.indexOf(boundaryBuf, start);
            }

            let fileData = null;
            let originalName = 'motion.mp4';
            for (const part of parts) {
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd === -1) continue;
                const headers = part.slice(0, headerEnd).toString();
                const content = part.slice(headerEnd + 4, part.length - 2);
                if (headers.includes('filename=')) {
                    const fnMatch = headers.match(/filename="([^"]+)"/);
                    if (fnMatch) originalName = fnMatch[1];
                    fileData = content;
                }
            }

            if (!fileData || fileData.length === 0) {
                jsonResponse(res, 400, { error: 'No file data received' });
                return;
            }

            const motionDir = path.join(ASSETS_DIR, String(userId), 'motion');
            if (!fs.existsSync(motionDir)) fs.mkdirSync(motionDir, { recursive: true });

            const ext = path.extname(originalName) || '.mp4';
            const safeName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const savePath = path.join(motionDir, safeName);
            fs.writeFileSync(savePath, fileData);

            const url = `/assets/${userId}/motion/${safeName}`;
            console.log(`🎬 Motion ref uploaded: ${safeName} (${(fileData.length / 1024 / 1024).toFixed(1)} MB) for user ${userId}`);
            jsonResponse(res, 200, { url });
        } catch (err) {
            jsonResponse(res, 500, { error: err.message });
        }
    });
}

// ==================== MOTION LIBRARY HANDLERS ====================

async function handleMotionLibraryGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const search = url.searchParams.get('search') || '';
        const category = url.searchParams.get('category') || 'all';
        const motions = await db.getMotionLibrary(userId, { search, category });
        jsonResponse(res, 200, motions);
    } catch (err) {
        console.error('Motion library get error:', err);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleMotionUpload(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        jsonResponse(res, 400, { error: 'Content-Type must be multipart/form-data' });
        return;
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
        jsonResponse(res, 400, { error: 'Missing boundary' });
        return;
    }

    const chunks = [];
    let totalSize = 0;
    req.on('data', chunk => {
        totalSize += chunk.length;
        if (totalSize > 50 * 1024 * 1024) {
            req.destroy();
            jsonResponse(res, 400, { error: 'File too large (max 50MB)' });
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', async () => {
        try {
            const body = Buffer.concat(chunks);
            const boundaryBuf = Buffer.from('--' + boundary);
            let start = body.indexOf(boundaryBuf) + boundaryBuf.length;
            let end = body.indexOf(boundaryBuf, start);
            const parts = [];
            while (end !== -1) {
                parts.push(body.slice(start, end));
                start = end + boundaryBuf.length;
                end = body.indexOf(boundaryBuf, start);
            }

            let fileData = null;
            let originalName = 'motion.mp4';
            let motionName = '';
            let motionCategory = 'dance';
            for (const part of parts) {
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd === -1) continue;
                const headers = part.slice(0, headerEnd).toString();
                const content = part.slice(headerEnd + 4, part.length - 2);
                if (headers.includes('filename=')) {
                    const fnMatch = headers.match(/filename="([^"]+)"/);
                    if (fnMatch) originalName = fnMatch[1];
                    fileData = content;
                } else if (headers.includes('name="name"')) {
                    motionName = content.toString().trim();
                } else if (headers.includes('name="category"')) {
                    motionCategory = content.toString().trim();
                }
            }

            if (!fileData || fileData.length === 0) {
                jsonResponse(res, 400, { error: 'No file data received' });
                return;
            }

            const motionDir = path.join(ASSETS_DIR, String(userId), 'motion');
            if (!fs.existsSync(motionDir)) fs.mkdirSync(motionDir, { recursive: true });

            const ext = path.extname(originalName) || '.mp4';
            const safeName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const savePath = path.join(motionDir, safeName);
            fs.writeFileSync(savePath, fileData);

            const localUrl = `/assets/${userId}/motion/${safeName}`;

            // Upload to catbox for public URL
            let publicUrl = localUrl;
            try {
                publicUrl = await uploadToTempHost(savePath, safeName);
            } catch (e) {
                console.warn('Catbox upload failed for motion, using local URL:', e.message);
            }

            const motion = await db.createMotion(userId, {
                name: motionName || originalName.replace(ext, ''),
                video_url: publicUrl,
                thumbnail_url: null,
                category: motionCategory,
                source: 'user',
                file_size: fileData.length,
            });

            console.log(`🎬 Motion uploaded to library: ${safeName} (${(fileData.length / 1024 / 1024).toFixed(1)} MB) for user ${userId}`);
            jsonResponse(res, 200, motion);
        } catch (err) {
            console.error('Motion upload error:', err);
            jsonResponse(res, 500, { error: 'Upload failed: ' + err.message });
        }
    });
}

async function handleMotionDelete(motionId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const motion = await db.getMotion(motionId);
        if (!motion) { jsonResponse(res, 404, { error: 'Motion not found' }); return; }
        if (motion.user_id !== userId) { jsonResponse(res, 403, { error: 'Not your motion' }); return; }
        await db.deleteMotion(motionId);
        jsonResponse(res, 200, { ok: true });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleMotionWebSearch(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
    if (!APIFY_API_TOKEN) {
        jsonResponse(res, 500, { error: 'APIFY_API_TOKEN not configured. Add it in Railway env vars.' });
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = url.searchParams.get('query') || 'trending dance';
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 30);

    // Build hashtag URLs for Instagram reels tab
    const hashtags = query.split(/[\s,]+/).filter(Boolean).map(t => t.replace(/^#/, ''));
    const searchUrls = hashtags.map(tag => `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/reels/`);

    console.log(`🔍 Motion web search: "${query}" → reels hashtags: ${hashtags.join(', ')}`);

    try {
        // Use apify/instagram-scraper targeting the reels tab of hashtag pages
        const actorId = 'apify~instagram-scraper';
        const runUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;

        const inputBody = JSON.stringify({
            directUrls: searchUrls,
            resultsType: 'posts',
            resultsLimit: limit,
            searchType: 'hashtag',
            searchLimit: 1,
            addParentData: false,
        });

        const apifyRes = await new Promise((resolve, reject) => {
            const pReq = https.request(runUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(inputBody),
                },
                timeout: 180000,
            }, (resp) => {
                let data = '';
                resp.on('data', chunk => data += chunk);
                resp.on('end', () => {
                    try { resolve({ status: resp.statusCode, data: JSON.parse(data) }); }
                    catch { reject(new Error(`Invalid Apify response (${resp.statusCode}): ${data.substring(0, 300)}`)); }
                });
            });
            pReq.on('error', reject);
            pReq.on('timeout', () => { pReq.destroy(); reject(new Error('Apify request timed out')); });
            pReq.write(inputBody);
            pReq.end();
        });

        if (apifyRes.status !== 200 && apifyRes.status !== 201) {
            console.error('Apify error:', JSON.stringify(apifyRes.data).substring(0, 500));
            throw new Error(`Apify API error ${apifyRes.status}`);
        }

        const posts = Array.isArray(apifyRes.data) ? apifyRes.data : [];

        // Debug: log first post structure to understand field names
        if (posts.length > 0) {
            const sample = posts[0];
            console.log(`🔍 Sample post keys: ${Object.keys(sample).join(', ')}`);
            console.log(`🔍 Sample post type=${sample.type}, isVideo=${sample.isVideo}, videoUrl=${(sample.videoUrl || '').substring(0, 80)}, url=${(sample.url || '').substring(0, 80)}`);
        }

        // Extract videos — try multiple field name patterns from Apify output
        const results = posts
            .filter(p => {
                return p.type === 'Video' || p.isVideo === true ||
                       p.videoUrl || p.video_url ||
                       (p.videoVersions && p.videoVersions.length > 0) ||
                       p.type === 'Sidecar';
            })
            .map(p => {
                const videoUrl = p.videoUrl || p.video_url ||
                    (p.videoVersions && p.videoVersions[0]?.url) || '';
                if (!videoUrl) return null;

                const caption = (p.caption || p.text || '').substring(0, 60);
                const ownerName = p.ownerUsername || p.ownerFullName || p.owner?.username || 'Instagram';
                const displayName = caption || `@${ownerName} reel`;
                const thumb = p.displayUrl || p.thumbnailUrl || p.thumbnail_url ||
                    (p.imageVersions && p.imageVersions[0]?.url) || null;

                return {
                    id: p.id || p.shortCode || p.pk || String(Date.now() + Math.random()),
                    name: displayName,
                    thumbnail_url: thumb,
                    video_url: videoUrl,
                    duration: p.videoDuration || p.video_duration || 0,
                    source: 'instagram',
                    pexels_video_id: null,
                    ig_shortcode: p.shortCode || null,
                    ig_owner: ownerName,
                    ig_likes: p.likesCount || p.likes || 0,
                    ig_views: p.videoViewCount || p.videoPlayCount || p.views || 0,
                };
            })
            .filter(Boolean);

        console.log(`🔍 Motion search returned ${results.length} videos from ${posts.length} posts`);
        jsonResponse(res, 200, results);
    } catch (err) {
        console.error('Instagram motion search error:', err);
        jsonResponse(res, 500, { error: 'Search failed: ' + err.message });
    }
}

async function handleMotionSaveFromWeb(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    try {
        const body = JSON.parse(await getRequestBody(req));
        const { pexelsVideoUrl, videoUrl, name, category, tags, thumbnailUrl, duration, pexelsVideoId, igShortcode } = body;
        const sourceVideoUrl = videoUrl || pexelsVideoUrl;

        if (!sourceVideoUrl) {
            jsonResponse(res, 400, { error: 'videoUrl required' });
            return;
        }

        // Download the video server-side
        const motionDir = path.join(ASSETS_DIR, String(userId), 'motion');
        if (!fs.existsSync(motionDir)) fs.mkdirSync(motionDir, { recursive: true });

        const safeName = `ig_${Date.now()}.mp4`;
        const savePath = path.join(motionDir, safeName);

        await new Promise((resolve, reject) => {
            const download = (url) => {
                const client = url.startsWith('https') ? https : http;
                client.get(url, (resp) => {
                    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                        download(resp.headers.location);
                        return;
                    }
                    const ws = fs.createWriteStream(savePath);
                    resp.pipe(ws);
                    ws.on('finish', () => { ws.close(); resolve(); });
                    ws.on('error', reject);
                }).on('error', reject);
            };
            download(sourceVideoUrl);
        });

        const fileSize = fs.statSync(savePath).size;

        // Upload to catbox for public URL
        let publicUrl = `/assets/${userId}/motion/${safeName}`;
        try {
            publicUrl = await uploadToTempHost(savePath, safeName);
        } catch (e) {
            console.warn('Catbox upload failed for motion:', e.message);
        }

        const motion = await db.createMotion(userId, {
            name: name || 'Instagram Motion',
            video_url: publicUrl,
            thumbnail_url: thumbnailUrl || null,
            category: category || 'dance',
            source: igShortcode ? 'instagram' : 'pexels',
            tags: tags || [],
            duration_seconds: duration || null,
            file_size: fileSize,
            pexels_video_id: pexelsVideoId || igShortcode || null,
        });

        console.log(`🎬 Motion saved from web: ${safeName} (${(fileSize / 1024 / 1024).toFixed(1)} MB) for user ${userId}`);
        jsonResponse(res, 200, motion);
    } catch (err) {
        console.error('Save from web error:', err);
        jsonResponse(res, 500, { error: err.message });
    }
}

// ==================== MUSIC HANDLERS ====================

async function handleDeleteMusic(id, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const row = await db.getActiveConfig(userId);
    if (!row) { jsonResponse(res, 404, { error: 'No active config' }); return; }
    const config = row.config || {};
    if (!config.music) config.music = [];
    const idx = config.music.findIndex(m => m.id === id);
    if (idx === -1) {
        jsonResponse(res, 404, { error: 'Track not found' });
        return;
    }
    const track = config.music[idx];
    const filePath = path.join(ASSETS_DIR, String(userId), 'music', track.file);
    try { fs.unlinkSync(filePath); } catch (e) { console.log('Music file delete:', e.message); }
    config.music.splice(idx, 1);
    await db.saveActiveConfig(userId, config);
    console.log(`🗑️  Music deleted: ${track.name} (${track.file}) for user ${userId}`);
    jsonResponse(res, 200, { success: true });
}

// ==================== RUN LIMITING ====================
async function handleWorkflowTrigger(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    // Check run limit
    const limit = await db.checkRunLimit(userId);
    if (!limit.allowed) {
        jsonResponse(res, 429, { error: limit.reason, runs_used: limit.runs_used, runs_limit: limit.runs_limit });
        return;
    }

    // Increment run count
    const updated = await db.incrementRunsUsed(userId);

    // Get active config to create execution record
    const configRow = await db.getActiveConfig(userId);

    // Return approval to trigger — frontend will proxy to n8n
    jsonResponse(res, 200, {
        approved: true,
        runs_used: updated.runs_used,
        runs_limit: updated.runs_limit,
        userId: userId,
        configId: configRow?.id || null,
    });
}

// ==================== EXECUTION TRACKING ====================
async function handleExecutionCreate(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { n8nExecutionId, configId, mode } = JSON.parse(body);
        const execution = await db.createExecution(userId, configId, n8nExecutionId, mode);
        jsonResponse(res, 201, execution);
    } catch (err) {
        jsonResponse(res, 400, { error: err.message });
    }
}

async function handleExecutionUpdate(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { executionId, status, durationMs, errorMessage } = JSON.parse(body);
        await db.updateExecution(executionId, status, durationMs, errorMessage);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        jsonResponse(res, 400, { error: err.message });
    }
}

async function handleExecutionsList(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const executions = await db.getExecutions(userId);
    jsonResponse(res, 200, executions);
}

// ==================== STRIPE BILLING ====================
let stripe = null;
if (STRIPE_SECRET) {
    stripe = require('stripe')(STRIPE_SECRET);
}

async function handleCreateCheckout(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    if (!stripe) {
        jsonResponse(res, 503, { error: 'Billing not configured. Set STRIPE_SECRET_KEY.' });
        return;
    }

    const body = await getRequestBody(req);
    try {
        const { plan } = JSON.parse(body);
        const priceId = STRIPE_PRICE_IDS[plan];
        if (!priceId) {
            jsonResponse(res, 400, { error: 'Invalid plan. Choose starter, pro, or premium.' });
            return;
        }

        const user = await db.getUserById(userId);
        let customerId = user.stripe_customer_id;

        if (!customerId) {
            const customer = await stripe.customers.create({ email: user.email, metadata: { userId: String(userId) } });
            customerId = customer.id;
            await db.updateStripeCustomer(userId, customerId, null);
        }

        const baseUrl = TUNNEL_BASE_URL || `http://localhost:${PORT}`;
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            success_url: `${baseUrl}/?billing=success`,
            cancel_url: `${baseUrl}/?billing=cancelled`,
            metadata: { userId: String(userId), plan },
        });

        jsonResponse(res, 200, { url: session.url });
    } catch (err) {
        console.error('Stripe checkout error:', err);
        jsonResponse(res, 500, { error: 'Checkout creation failed: ' + err.message });
    }
}

async function handleStripeWebhook(req, res) {
    if (!stripe) { jsonResponse(res, 503, { error: 'Billing not configured' }); return; }

    const rawBody = await getRawBody(req);
    let event;

    if (STRIPE_WEBHOOK_SECRET) {
        const sig = req.headers['stripe-signature'];
        try {
            event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            console.error('Stripe webhook signature failed:', err.message);
            jsonResponse(res, 400, { error: 'Invalid signature' });
            return;
        }
    } else {
        try {
            event = JSON.parse(rawBody.toString());
        } catch {
            jsonResponse(res, 400, { error: 'Invalid JSON' });
            return;
        }
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = parseInt(session.metadata?.userId);
                const plan = session.metadata?.plan;
                if (userId && plan && db.PLANS[plan]) {
                    await db.updateUserPlan(userId, plan);
                    await db.updateStripeCustomer(userId, session.customer, session.subscription);
                    console.log(`💳 User ${userId} upgraded to ${plan}`);
                }
                break;
            }
            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const user = await db.getUserByStripeCustomer(sub.customer);
                if (user) {
                    await db.updateUserPlan(user.id, 'starter');
                    console.log(`💳 User ${user.id} subscription cancelled, downgraded to starter`);
                }
                break;
            }
        }
    } catch (err) {
        console.error('Webhook processing error:', err);
    }

    jsonResponse(res, 200, { received: true });
}

async function handleBillingStatus(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const user = await db.getUserById(userId);
    if (!user) { jsonResponse(res, 404, { error: 'User not found' }); return; }
    jsonResponse(res, 200, {
        plan: user.plan,
        runs_used: user.runs_used,
        runs_limit: user.runs_limit,
        plans: db.PLANS,
        stripe_configured: !!stripe,
    });
}

// ==================== META APP REVIEW COMPLIANCE ====================
function generatePrivacyPolicy() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Privacy Policy - Loki AI Generator</title>
<style>
body{font-family:Inter,system-ui,sans-serif;max-width:800px;margin:0 auto;padding:40px 20px;color:#333;line-height:1.7}
h1{color:#1a1a2e;border-bottom:2px solid #10b981;padding-bottom:12px}
h2{color:#1a1a2e;margin-top:30px}
.updated{color:#666;font-size:0.9em;margin-bottom:30px}
</style></head><body>
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${new Date().toISOString().split('T')[0]}</p>
<h2>1. Introduction</h2>
<p>Loki AI Generator operates a social media content management platform. This Privacy Policy explains how we collect, use, and protect information when you use our service.</p>
<h2>2. Information We Collect</h2>
<p>We collect: email address, name, hashed password for account creation. When connecting social media accounts: OAuth tokens, user IDs. Content you create and publish through our service.</p>
<h2>3. How We Use Information</h2>
<ul><li>Provide and maintain our service</li><li>Publish content to your connected social media accounts</li><li>Process subscription payments</li></ul>
<h2>4. Data Storage</h2>
<p>Data is stored in encrypted PostgreSQL databases. Passwords are hashed with bcrypt. We use HTTPS for data in transit.</p>
<h2>5. Data Deletion</h2>
<p>You can delete your account and all data at any time. Contact us at <strong>bvon878@gmail.com</strong>.</p>
<h2>6. Contact</h2>
<p>For privacy inquiries: <strong>bvon878@gmail.com</strong></p>
</body></html>`;
}

function generateTermsOfService() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Terms of Service - Loki AI Generator</title>
<style>
body{font-family:Inter,system-ui,sans-serif;max-width:800px;margin:0 auto;padding:40px 20px;color:#333;line-height:1.7}
h1{color:#1a1a2e;border-bottom:2px solid #10b981;padding-bottom:12px}
h2{color:#1a1a2e;margin-top:30px}
</style></head><body>
<h1>Terms of Service</h1>
<p>Last updated: ${new Date().toISOString().split('T')[0]}</p>
<h2>1. Service</h2><p>Loki AI Generator is a SaaS platform for AI-powered content automation.</p>
<h2>2. Subscriptions</h2><p>Paid plans are billed monthly. You can cancel at any time.</p>
<h2>3. Acceptable Use</h2><p>You agree to comply with all applicable laws and platform terms of service.</p>
<h2>4. Contact</h2><p>Questions: <strong>bvon878@gmail.com</strong></p>
</body></html>`;
}

function generateDataDeletionInfo() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Data Deletion - Loki AI Generator</title>
<style>
body{font-family:Inter,system-ui,sans-serif;max-width:800px;margin:0 auto;padding:40px 20px;color:#333;line-height:1.7}
h1{color:#1a1a2e;border-bottom:2px solid #10b981;padding-bottom:12px}
.info-box{background:#f0fdf4;border:1px solid #10b981;border-radius:8px;padding:20px;margin:20px 0}
</style></head><body>
<h1>Data Deletion Request</h1>
<div class="info-box">
<p>To delete your data, disconnect your account in the dashboard or email <strong>bvon878@gmail.com</strong>.</p>
</div>
</body></html>`;
}

async function handleDataDeletion(req, res) {
    try {
        const body = await getRequestBody(req);
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = querystring.parse(body); }
        console.log(`🗑️  Data deletion request received`);
        const confirmationCode = crypto.randomBytes(16).toString('hex');
        const baseUrl = TUNNEL_BASE_URL || `http://localhost:${PORT}`;
        jsonResponse(res, 200, {
            url: `${baseUrl}/data-deletion?confirmation=${confirmationCode}`,
            confirmation_code: confirmationCode
        });
    } catch (err) {
        console.error('Data deletion error:', err);
        jsonResponse(res, 200, { url: '/data-deletion', confirmation_code: 'error' });
    }
}

async function handleDeauthorize(req, res) {
    try {
        console.log(`🔓 Deauthorize callback received`);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        console.error('Deauthorize error:', err);
        jsonResponse(res, 200, { success: true });
    }
}

// ==================== PIPELINE API HANDLERS ====================

async function handlePipelineRun(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    // Check run limit
    const limit = await db.checkRunLimit(userId);
    if (!limit.allowed) {
        jsonResponse(res, 429, { error: limit.reason, runs_used: limit.runs_used, runs_limit: limit.runs_limit });
        return;
    }

    const body = await getRequestBody(req);
    try {
        const jobData = JSON.parse(body);

        // Fetch character card reference image if card IDs were provided
        if (jobData.characterCardIds && jobData.characterCardIds.length > 0) {
            const card = await db.getCharacterCard(jobData.characterCardIds[0]);
            if (card) {
                jobData.characterCardData = card.character_data || {};
                const images = await db.getCharacterImages(card.id);
                const primaryImage = images.find(i => i.is_primary) || images[0];
                if (primaryImage) {
                    jobData.characterCardData.referenceImageUrl = primaryImage.url;
                } else if (card.thumbnail_url) {
                    jobData.characterCardData.referenceImageUrl = card.thumbnail_url;
                }
                // Collect ALL image URLs for Kling 3.0 elements (2-4 refs = better consistency)
                const allUrls = images.map(i => i.url).filter(Boolean);
                if (allUrls.length > 0) {
                    jobData.characterCardData.allReferenceImageUrls = allUrls.slice(0, 4);
                }
            }
        }

        // Increment run count
        const updated = await db.incrementRunsUsed(userId);

        const job = await submitPipelineJob(userId, jobData);
        jsonResponse(res, 200, {
            success: true,
            jobId: job.id,
            status: 'queued',
            runs_used: updated.runs_used,
            runs_limit: updated.runs_limit,
        });
    } catch (err) {
        jsonResponse(res, 500, { error: 'Failed to submit job: ' + err.message });
    }
}

async function handlePipelineStatus(jobId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    try {
        const job = await db.getJob(parseInt(jobId));
        if (!job) { jsonResponse(res, 404, { error: 'Job not found' }); return; }
        jsonResponse(res, 200, {
            id: job.id,
            status: job.status,
            currentPhase: job.current_phase,
            result: job.result,
            error: job.error,
            createdAt: job.created_at,
            completedAt: job.completed_at,
        });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handlePipelineHistory(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    try {
        const jobs = await db.getUserJobs(userId, 20);
        jsonResponse(res, 200, jobs.map(j => ({
            id: j.id, status: j.status, currentPhase: j.current_phase,
            error: j.error, createdAt: j.created_at, completedAt: j.completed_at,
            input: j.input,
        })));
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handlePipelineStats(req, res) {
    // No auth required for stats (lightweight)
    try {
        const stats = await getQueueStats();
        jsonResponse(res, 200, stats);
    } catch (err) {
        jsonResponse(res, 200, { waiting: 0, active: 0, completed: 0, failed: 0 });
    }
}

async function handleScheduleGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const schedule = await db.getSchedule(userId);
    jsonResponse(res, 200, schedule || { cron_times: ['06:00', '09:00', '12:00', '18:00', '21:00', '00:00'], enabled: false });
}

async function handleScheduleSave(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const body = await getRequestBody(req);
    try {
        const { cronTimes, enabled } = JSON.parse(body);
        await db.saveSchedule(userId, cronTimes, enabled);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        jsonResponse(res, 400, { error: err.message });
    }
}

// ==================== SAVED LOOKS API ====================
async function handleLooksGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const looks = await db.getSavedLooks(userId);
        jsonResponse(res, 200, looks);
    } catch (err) {
        console.error('Looks GET error:', err);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleLooksCreate(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const data = JSON.parse(body);
        if (!data.name) {
            jsonResponse(res, 400, { error: 'name is required' });
            return;
        }
        const look = await db.createSavedLook(userId, data);
        jsonResponse(res, 201, look);
    } catch (err) {
        console.error('Looks CREATE error:', err);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleLooksDelete(lookId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        // Verify ownership
        const look = await db.getSavedLook(lookId);
        if (!look) {
            jsonResponse(res, 404, { error: 'Look not found' });
            return;
        }
        if (look.user_id !== userId) {
            jsonResponse(res, 403, { error: 'Not authorized' });
            return;
        }
        await db.deleteSavedLook(lookId);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        console.error('Looks DELETE error:', err);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleLooksRun(lookId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        // Verify ownership
        const look = await db.getSavedLook(lookId);
        if (!look) {
            jsonResponse(res, 404, { error: 'Look not found' });
            return;
        }
        if (look.user_id !== userId) {
            jsonResponse(res, 403, { error: 'Not authorized' });
            return;
        }
        // Increment use count
        await db.incrementLookUseCount(lookId);
        // Submit a pipeline job using the look's settings
        const settings = look.settings || {};
        const jobId = await submitPipelineJob(userId, {
            ...settings,
            savedLookId: lookId,
            savedLookName: look.name,
        });
        jsonResponse(res, 200, { success: true, jobId });
    } catch (err) {
        console.error('Looks RUN error:', err);
        jsonResponse(res, 500, { error: err.message });
    }
}

// ==================== CALENDAR SCHEDULE API ====================
async function handleCalendarGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const calendar = await db.getCalendarSchedule(userId);
        jsonResponse(res, 200, calendar || {});
    } catch (err) {
        console.error('Calendar GET error:', err);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCalendarSave(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const calendarData = JSON.parse(body);
        await db.saveCalendarSchedule(userId, calendarData);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        console.error('Calendar SAVE error:', err);
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleTestAgent(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const body = await getRequestBody(req);
    try {
        const parsed = body ? JSON.parse(body) : {};
        const provider = parsed.llmProvider || 'gemini';

        // Load user's active config from DB
        const configRow = await db.getActiveConfig(userId);
        const userConfig = configRow?.config || {};

        const result = await generatePrompt(userConfig, provider, null);
        jsonResponse(res, 200, {
            Prompt: result.imagePrompt,
            Action: result.action,
            OutfitNote: result.scene,
        });
    } catch (err) {
        jsonResponse(res, 500, { error: 'Test generation failed: ' + err.message });
    }
}

// ==================== CONTENT AGENT ====================

async function handleAgentGenerateContent(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const body = await getRequestBody(req);
    try {
        const { characterCardId, contentType, theme, mood } = JSON.parse(body);
        if (!characterCardId) { jsonResponse(res, 400, { error: 'characterCardId required' }); return; }

        // Load character card with full bio
        const card = await db.getCharacterCard(characterCardId);
        if (!card) { jsonResponse(res, 404, { error: 'Character card not found' }); return; }

        const cd = card.character_data || {};

        // Build rich system prompt
        const systemPrompt = `You are a content director for a social media character.
You create viral short-form video concepts that are 100% in-character.

CHARACTER PROFILE:
Name: ${card.name || 'Unknown'}
Bio: ${cd.bio || 'Not specified'}
Personality: ${cd.personality || 'Not specified'}
Backstory: ${cd.backstory || 'Not specified'}
Location: ${cd.location || 'Not specified'}
Interests: ${cd.interests || 'Not specified'}
Humor Style: ${cd.humorStyle || 'Not specified'}
Catchphrases: ${cd.catchphrases || 'None'}
Content Voice: ${cd.contentVoice || 'Casual, natural'}
Visual Style: ${cd.appearance || 'Not specified'}, ${cd.outfit || 'Not specified'}

Generate a complete content package. The content MUST:
- Sound exactly like this character would talk
- Reference their backstory/personality naturally
- Use their humor style and catchphrases where fitting
- Be designed for short-form vertical video (5-10 seconds)

Respond in valid JSON only with these exact keys: imagePrompt, videoAction, caption, voiceScript, hashtags
- imagePrompt: A detailed image generation prompt describing the visual scene (include character appearance, outfit, setting, camera angle)
- videoAction: The physical action/movement for the video (what happens in the 5-10 second clip)
- caption: Social media caption with emojis and personality
- voiceScript: What the character says in first person (2-3 sentences max)
- hashtags: Array of 5-8 relevant hashtags as strings`;

        const userMessage = `Create a content idea${theme ? ` about: ${theme}` : ''}${mood ? `. Mood: ${mood}` : ''}. Make it feel authentic to this character.`;

        // Determine LLM provider from user config
        const configRow = await db.getActiveConfig(userId);
        const userConfig = configRow?.config || {};
        const provider = userConfig.llmProvider || 'gemini';

        let llmResponse;

        if (provider === 'claude') {
            llmResponse = await callClaude(systemPrompt, userMessage);
        } else {
            llmResponse = await callGemini(systemPrompt, userMessage);
        }

        // Parse JSON from response (handle markdown code blocks)
        let parsed;
        try {
            let jsonStr = llmResponse.trim();
            // Strip markdown code fences if present
            if (jsonStr.startsWith('```')) {
                jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
            }
            parsed = JSON.parse(jsonStr);
        } catch (parseErr) {
            // Try to extract JSON from response
            const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('Failed to parse content agent response as JSON');
            }
        }

        jsonResponse(res, 200, {
            imagePrompt: parsed.imagePrompt || '',
            videoAction: parsed.videoAction || '',
            caption: parsed.caption || '',
            voiceScript: parsed.voiceScript || '',
            hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : (parsed.hashtags || '').split(/[,\s]+/).filter(Boolean),
            characterName: card.name,
        });
    } catch (err) {
        console.error('[content-agent] Error:', err.message);
        jsonResponse(res, 500, { error: 'Content generation failed: ' + err.message });
    }
}

// ==================== MASTER AGENT ====================

async function handleAgentChat(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const body = await getRequestBody(req);
    try {
        const { message, conversationHistory } = JSON.parse(body);
        if (!message) { jsonResponse(res, 400, { error: 'message required' }); return; }

        // Gather system context
        const cards = await db.getCharacterCards(userId, {});
        const schedule = await db.getSchedule(userId);
        const configRow = await db.getActiveConfig(userId);
        const userConfig = configRow?.config || {};

        // Build character list for system prompt
        const characterList = cards.map(c => {
            const cd = c.character_data || {};
            return `- ${c.name} (ID: ${c.id}) — ${cd.personality || cd.bio || 'No bio'}${cd.location ? `, based in ${cd.location}` : ''}`;
        }).join('\n');

        // Get connected platforms
        let connectedPlatforms = [];
        try {
            const status = await db.getSocialStatus(userId);
            if (status) {
                for (const [platform, data] of Object.entries(status)) {
                    if (data && data.connected) connectedPlatforms.push(platform);
                }
            }
        } catch (e) { /* ignore */ }

        // Get saved node workflows for context
        let nodeWorkflowNames = [];
        try {
            const nwList = await db.getNodeWorkflows(userId);
            nodeWorkflowNames = nwList.map(w => w.name);
        } catch (e) { /* ignore */ }

        const systemPrompt = `You are Loki Agent, an AI assistant that manages a social media content automation system.
You have full knowledge of the user's setup and can take actions on their behalf.

SYSTEM STATE:
Characters (${cards.length} total):
${characterList || '(none)'}

Schedule: ${schedule?.enabled ? 'ENABLED' : 'DISABLED'}, times: ${(schedule?.cron_times || []).join(', ') || 'none set'}
Connected Platforms: ${connectedPlatforms.length > 0 ? connectedPlatforms.join(', ') : 'none'}
Current Config: LLM=${userConfig.llmProvider || 'gemini'}, Image=${userConfig.imageModel || 'nano-banana-pro'}, Video=${userConfig.videoModel || 'kling-2.6/image-to-video'}
Saved Node Workflows: ${nodeWorkflowNames.length > 0 ? nodeWorkflowNames.join(', ') : '(none)'}

AVAILABLE ACTIONS (include in your response as JSON actions array when you want to execute them):
- create_character: Create a new character card with full bio. Params: { name: "string", bio?: "string", personality?: "string", backstory?: "string", location?: "string", interests?: "string", humorStyle?: "string", catchphrases?: "string", contentVoice?: "string", appearance?: "string", style?: "string", outfit?: "string" }
- run_pipeline: Generate content now. Params: { characterId: "uuid", theme?: "string" }
- update_schedule: Change posting times. Params: { times: ["HH:MM", ...], enabled: boolean }
- update_config: Change a setting. Params: { field: "string", value: any }
- workflow_create_node: Create a node in the workflow editor. Params: { type: "text|upload|imageGen|videoGen|lipsync|upscaler|audioTrim", x: number, y: number, config?: object }
- workflow_run_all: Execute all nodes in the workflow editor.
- workflow_load: Load a saved workflow. Params: { name: "string" }
- workflow_save: Save the current workflow. Params: { name: "string" }
- switch_tab: Switch dashboard tab. Params: { tab: "command-center|social|config|assets|workflows" }

When the user asks to create characters, ALWAYS use the create_character action. Fill in as many fields as possible based on what the user describes — be creative and rich with bios, personality, backstory, etc. If they give you a vibe or personality archetype, flesh it out into full character data.

When you want to take action, include an "actions" array in your response JSON.
When just chatting/answering, set actions to an empty array.

ALWAYS respond in this exact JSON format:
{
  "reply": "Your message to the user",
  "actions": []
}

Be helpful, concise, and proactive. If the user asks to do something, do it (include the action). If they ask a question, answer it clearly. You can include multiple actions in a single response (e.g., creating multiple characters at once).`;

        // Build conversation for LLM
        const history = (conversationHistory || []).slice(-16);
        const conversationText = history.map(m =>
            `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
        ).join('\n\n');

        const userMessage = conversationText
            ? `Previous conversation:\n${conversationText}\n\nUser's latest message: ${message}`
            : message;

        const provider = userConfig.llmProvider || 'gemini';

        let llmResponse;
        if (provider === 'claude') {
            llmResponse = await callClaude(systemPrompt, userMessage);
        } else {
            llmResponse = await callGemini(systemPrompt, userMessage);
        }

        // Parse response
        let parsed;
        try {
            let jsonStr = llmResponse.trim();
            if (jsonStr.startsWith('```')) {
                jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
            }
            parsed = JSON.parse(jsonStr);
        } catch (parseErr) {
            const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
            } else {
                // Fallback: treat entire response as reply text
                parsed = { reply: llmResponse, actions: [] };
            }
        }

        jsonResponse(res, 200, {
            reply: parsed.reply || llmResponse,
            actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        });
    } catch (err) {
        console.error('[master-agent] Error:', err.message);
        jsonResponse(res, 500, { error: 'Agent chat failed: ' + err.message });
    }
}

// ==================== CHARACTER CARD API HANDLERS ====================

async function handleCardsGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const category = url.searchParams.get('category') || undefined;
        const search = url.searchParams.get('search') || undefined;
        const sortBy = url.searchParams.get('sortBy') || undefined;
        const cards = await db.getCharacterCards(userId, { category, search, sortBy });
        jsonResponse(res, 200, cards);
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCardCreate(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const data = JSON.parse(body);
        if (!data.name) { jsonResponse(res, 400, { error: 'Name is required' }); return; }
        // Auto-set thumbnail_url from character_data.referenceImageUrl if missing
        if (!data.thumbnail_url && data.character_data?.referenceImageUrl) {
            data.thumbnail_url = data.character_data.referenceImageUrl;
        }
        const card = await db.createCharacterCard(userId, data);
        jsonResponse(res, 201, card);
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCardGet(cardId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const card = await db.getCharacterCard(cardId);
        if (!card) { jsonResponse(res, 404, { error: 'Card not found' }); return; }
        const images = await db.getCharacterImages(cardId);
        const voice = await db.getVoiceConfig(cardId);
        jsonResponse(res, 200, { ...card, images, voice });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCardUpdate(cardId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const data = JSON.parse(body);
        // Auto-set thumbnail_url from character_data.referenceImageUrl if missing
        if (!data.thumbnail_url && data.character_data?.referenceImageUrl) {
            data.thumbnail_url = data.character_data.referenceImageUrl;
        }
        const card = await db.updateCharacterCard(cardId, data);
        if (!card) { jsonResponse(res, 404, { error: 'Card not found' }); return; }
        jsonResponse(res, 200, card);
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCardDelete(cardId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        await db.deleteCharacterCard(cardId);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCardClone(cardId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const overrides = body ? JSON.parse(body) : {};
        const card = await db.cloneCharacterCard(cardId, userId, overrides);
        if (!card) { jsonResponse(res, 404, { error: 'Original card not found' }); return; }
        jsonResponse(res, 201, card);
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCardGenerateThumbnail(cardId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const card = await db.getCharacterCard(cardId);
        if (!card) { jsonResponse(res, 404, { error: 'Card not found' }); return; }

        const cd = card.character_data || {};
        const appearance = cd.appearance || '';
        const style = cd.style || '';
        const promptText = `Generate a photorealistic portrait thumbnail of: ${appearance}. Style: ${style}. Close-up face shot, studio lighting, 1:1 square format.`;

        // Use Gemini to generate thumbnail
        const { generateImage } = require('./pipeline');
        const result = await generateImage(promptText, 'nano-banana-pro');
        if (result && result.url) {
            await db.updateCharacterCard(cardId, { thumbnail_url: result.url });
            await db.addCharacterImage(cardId, {
                url: result.url, type: 'generated', is_primary: true,
                generation_prompt: promptText,
            });
            jsonResponse(res, 200, { thumbnail_url: result.url });
        } else {
            jsonResponse(res, 500, { error: 'Image generation failed' });
        }
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCardImageUpload(cardId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        jsonResponse(res, 400, { error: 'Content-Type must be multipart/form-data' });
        return;
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) {
        jsonResponse(res, 400, { error: 'Missing boundary' });
        return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
        try {
            const body = Buffer.concat(chunks);
            if (body.length > 10 * 1024 * 1024) {
                jsonResponse(res, 400, { error: 'File too large (max 10MB)' });
                return;
            }
            const boundaryBuf = Buffer.from('--' + boundary);
            let start = body.indexOf(boundaryBuf) + boundaryBuf.length;
            let end = body.indexOf(boundaryBuf, start);
            const parts = [];
            while (end !== -1) {
                parts.push(body.slice(start, end));
                start = end + boundaryBuf.length;
                end = body.indexOf(boundaryBuf, start);
            }

            let fileData = null;
            let originalName = 'image.jpg';
            for (const part of parts) {
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd === -1) continue;
                const headers = part.slice(0, headerEnd).toString();
                const content = part.slice(headerEnd + 4, part.length - 2);
                if (headers.includes('filename=')) {
                    const fnMatch = headers.match(/filename="([^"]+)"/);
                    if (fnMatch) originalName = fnMatch[1];
                    fileData = content;
                }
            }

            if (!fileData || fileData.length === 0) {
                jsonResponse(res, 400, { error: 'No file data received' });
                return;
            }

            const imgDir = path.join(ASSETS_DIR, String(userId), 'images');
            if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

            const ext = path.extname(originalName) || '.jpg';
            const safeName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const savePath = path.join(imgDir, safeName);
            fs.writeFileSync(savePath, fileData);

            const imageUrl = `/assets/${userId}/images/${safeName}`;
            await db.updateCharacterCard(cardId, { thumbnail_url: imageUrl });
            await db.addCharacterImage(cardId, {
                url: imageUrl, type: 'uploaded', is_primary: true,
            });

            console.log(`📷 Card image uploaded: ${safeName} for card ${cardId}`);
            jsonResponse(res, 200, { thumbnail_url: imageUrl });
        } catch (err) {
            jsonResponse(res, 500, { error: err.message });
        }
    });
}

async function handleCardsCompose(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { card_ids, scene_context } = JSON.parse(body);
        if (!card_ids || !card_ids.length) {
            jsonResponse(res, 400, { error: 'At least one card_id is required' }); return;
        }
        const parts = [];
        for (const id of card_ids) {
            const card = await db.getCharacterCard(id);
            if (!card) continue;
            const cd = card.character_data || {};
            const template = cd.promptTemplate || cd.appearance || '';
            parts.push(`[${card.name}]: ${template}`);
        }
        let composed = parts.join('\n');
        if (scene_context) {
            composed += `\nScene: ${scene_context}`;
        }
        jsonResponse(res, 200, { composed_prompt: composed, card_count: parts.length });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

// ==================== SCENE API HANDLERS ====================

async function handleScenesGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const scenes = await db.getScenes(userId);
        jsonResponse(res, 200, scenes);
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleSceneCreate(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const data = JSON.parse(body);
        if (!data.name) { jsonResponse(res, 400, { error: 'Name is required' }); return; }
        const scene = await db.createScene(userId, data);
        // Add characters if provided
        if (data.characters && data.characters.length) {
            for (const char of data.characters) {
                await db.addSceneCharacter(scene.id, char);
            }
        }
        const characters = await db.getSceneCharacters(scene.id);
        jsonResponse(res, 201, { ...scene, characters });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleSceneUpdate(sceneId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const data = JSON.parse(body);
        const scene = await db.updateScene(sceneId, data);
        if (!scene) { jsonResponse(res, 404, { error: 'Scene not found' }); return; }
        // Update characters if provided
        if (data.characters) {
            // Remove existing and re-add
            const existing = await db.getSceneCharacters(sceneId);
            for (const ec of existing) {
                await db.removeSceneCharacter(sceneId, ec.character_card_id);
            }
            for (const char of data.characters) {
                await db.addSceneCharacter(sceneId, char);
            }
        }
        const characters = await db.getSceneCharacters(sceneId);
        jsonResponse(res, 200, { ...scene, characters });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleSceneDelete(sceneId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        await db.deleteScene(sceneId);
        jsonResponse(res, 200, { success: true });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleSceneGenerate(sceneId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const limit = await db.checkRunLimit(userId);
        if (!limit.allowed) {
            jsonResponse(res, 429, { error: limit.reason }); return;
        }

        const scene = await db.getScene(sceneId);
        if (!scene) { jsonResponse(res, 404, { error: 'Scene not found' }); return; }

        const characters = await db.getSceneCharacters(sceneId);
        // Compose prompt from characters
        const parts = [];
        for (const char of characters) {
            const cd = char.character_data || {};
            const template = cd.promptTemplate || cd.appearance || '';
            let part = `[${char.character_name}]: ${template}`;
            if (char.action) part += ` Action: ${char.action}`;
            if (char.outfit_override) part += ` Wearing: ${char.outfit_override}`;
            parts.push(part);
        }
        let composedPrompt = parts.join('\n');
        if (scene.settings?.context) {
            composedPrompt += `\nScene: ${scene.settings.context}`;
        }

        // Update scene with composed prompt
        await db.updateScene(sceneId, { composed_prompt: composedPrompt, status: 'generating' });

        // Increment card use counts
        for (const char of characters) {
            await db.incrementCardUseCount(char.character_card_id);
        }

        const body = await getRequestBody(req);
        const jobData = body ? JSON.parse(body) : {};

        // Load voice config from first character card (if available)
        let voiceConfig = null;
        if (characters.length > 0) {
            const vc = await db.getVoiceConfig(characters[0].character_card_id);
            if (vc) voiceConfig = vc;
        }

        // Extract reference images from first character for Kling 3.0 elements
        let referenceImageUrl = null;
        let allReferenceImageUrls = [];
        if (characters.length > 0) {
            const firstChar = characters[0];
            const firstCharData = firstChar.character_data || {};
            referenceImageUrl = firstCharData.referenceImageUrl || null;
            const imgs = await db.getCharacterImages(firstChar.character_card_id);
            if (!referenceImageUrl) {
                const primary = imgs.find(i => i.is_primary) || imgs[0];
                if (primary) referenceImageUrl = primary.url;
                else if (firstChar.thumbnail_url) referenceImageUrl = firstChar.thumbnail_url;
            }
            allReferenceImageUrls = imgs.map(i => i.url).filter(Boolean).slice(0, 4);
        }

        // Extract voice script from scene settings
        const voiceScript = scene.settings?.voiceScript || null;

        const updated = await db.incrementRunsUsed(userId);
        const job = await submitPipelineJob(userId, {
            ...jobData,
            composedPrompt,
            action: scene.settings?.context || '',
            sceneId: scene.id,
            source: 'scene_composer',
            characterName: characters[0]?.character_name || null,
            ...(voiceConfig ? { voiceConfig } : {}),
            ...(voiceScript ? { voiceScript } : {}),
            ...(referenceImageUrl ? {
                characterCardData: {
                    referenceImageUrl,
                    allReferenceImageUrls,
                    promptTemplate: characters[0]?.character_data?.promptTemplate,
                }
            } : {}),
        });

        jsonResponse(res, 200, {
            success: true, jobId: job.id, status: 'queued',
            runs_used: updated.runs_used, runs_limit: updated.runs_limit,
        });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

// ==================== VOICE API HANDLERS ====================

let voiceListCache = null;
let voiceListCacheTime = 0;
const VOICE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchElevenLabsVoices() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return [];
    if (voiceListCache && Date.now() - voiceListCacheTime < VOICE_CACHE_TTL) {
        return voiceListCache;
    }
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.elevenlabs.io',
            path: '/v1/voices',
            method: 'GET',
            headers: { 'xi-api-key': apiKey },
        };
        const req = https.request(options, (resp) => {
            let data = '';
            resp.on('data', chunk => data += chunk);
            resp.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    voiceListCache = (parsed.voices || []).map(v => ({
                        voice_id: v.voice_id, name: v.name,
                        category: v.category, preview_url: v.preview_url,
                        labels: v.labels || {},
                    }));
                    voiceListCacheTime = Date.now();
                    resolve(voiceListCache);
                } catch { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.end();
    });
}

async function handleVoicesList(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        if (!process.env.ELEVENLABS_API_KEY) {
            jsonResponse(res, 200, { voices: [], error: 'ELEVENLABS_API_KEY not configured' });
            return;
        }
        const voices = await fetchElevenLabsVoices();
        jsonResponse(res, 200, { voices });
    } catch (err) {
        jsonResponse(res, 200, { voices: [], error: err.message });
    }
}

function elevenLabsRequest(path, method, body, apiKey) {
    return new Promise((resolve, reject) => {
        const postData = body ? JSON.stringify(body) : '';
        const options = {
            hostname: 'api.elevenlabs.io',
            path,
            method,
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
            },
        };
        const req = https.request(options, (resp) => {
            if (resp.headers['content-type']?.includes('audio/')) {
                // Binary audio response
                const chunks = [];
                resp.on('data', chunk => chunks.push(chunk));
                resp.on('end', () => resolve({ audio: Buffer.concat(chunks), contentType: resp.headers['content-type'] }));
            } else {
                let data = '';
                resp.on('data', chunk => data += chunk);
                resp.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
                });
            }
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

async function handleVoicePreview(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) { jsonResponse(res, 400, { error: 'ELEVENLABS_API_KEY not configured' }); return; }

    const body = await getRequestBody(req);
    try {
        const { voice_id, text } = JSON.parse(body);
        if (!voice_id || !text) { jsonResponse(res, 400, { error: 'voice_id and text required' }); return; }

        const previewText = text.substring(0, 200); // Short preview
        const result = await elevenLabsRequest(
            `/v1/text-to-speech/${voice_id}`,
            'POST',
            { text: previewText, model_id: 'eleven_multilingual_v2',
              voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
            apiKey
        );

        if (result.audio) {
            res.writeHead(200, {
                'Content-Type': result.contentType,
                'Access-Control-Allow-Origin': '*',
            });
            res.end(result.audio);
        } else {
            jsonResponse(res, 500, { error: 'Voice preview failed', detail: result });
        }
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleVoiceGenerate(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) { jsonResponse(res, 400, { error: 'ELEVENLABS_API_KEY not configured' }); return; }

    const body = await getRequestBody(req);
    try {
        const { voice_id, text, settings } = JSON.parse(body);
        if (!voice_id || !text) { jsonResponse(res, 400, { error: 'voice_id and text required' }); return; }

        const voiceSettings = settings || { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };
        const result = await elevenLabsRequest(
            `/v1/text-to-speech/${voice_id}`,
            'POST',
            { text, model_id: 'eleven_multilingual_v2', voice_settings: voiceSettings },
            apiKey
        );

        if (result.audio) {
            // Save audio file locally
            const audioDir = path.join(__dirname, 'assets', 'audio');
            if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
            const filename = `voice_${Date.now()}.mp3`;
            const filePath = path.join(audioDir, filename);
            fs.writeFileSync(filePath, result.audio);

            jsonResponse(res, 200, {
                url: `/assets/audio/${filename}`,
                size: result.audio.length,
                filename,
            });
        } else {
            jsonResponse(res, 500, { error: 'Voice generation failed', detail: result });
        }
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleVoiceClone(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) { jsonResponse(res, 400, { error: 'ELEVENLABS_API_KEY not configured' }); return; }

    const body = await getRequestBody(req);
    try {
        const { name, description, files } = JSON.parse(body);
        if (!name || !files?.length) {
            jsonResponse(res, 400, { error: 'name and files[] (base64 audio) required' }); return;
        }
        // ElevenLabs voice cloning requires multipart - simplified approach
        jsonResponse(res, 501, { error: 'Voice cloning requires multipart upload - use ElevenLabs dashboard for now' });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleVoiceConfigSave(cardId, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const data = JSON.parse(body);
        if (!data.voice_id) { jsonResponse(res, 400, { error: 'voice_id required' }); return; }
        const config = await db.saveVoiceConfig(userId, cardId, data);
        jsonResponse(res, 200, config);
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

// ==================== ONBOARDING ====================

const onboardingSessions = new Map();

// Auto-cleanup stale sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of onboardingSessions) {
        if (now - session.createdAt > 30 * 60 * 1000) {
            onboardingSessions.delete(id);
        }
    }
}, 5 * 60 * 1000);

const ONBOARDING_POSES = [
    'standing confidently, three-quarter view, full body',
    'looking over shoulder, soft lighting, full body',
    'seated elegantly, dramatic side lighting, full body',
    'walking forward, eye contact, full body',
    'leaning against wall, editorial pose, full body',
    'dynamic confident stance, waist-up portrait',
];

async function handleOnboardingGenerate(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { mode, description, referenceImageUrl } = JSON.parse(body);
        if (!mode || (mode === 'create' && !description) || (mode === 'clone' && !referenceImageUrl)) {
            jsonResponse(res, 400, { error: 'Missing required fields for mode: ' + mode });
            return;
        }

        // Check run limit
        const runCheck = await db.checkRunLimit(userId);
        if (!runCheck.allowed) {
            jsonResponse(res, 403, { error: runCheck.reason });
            return;
        }

        // Deduct 1 run
        await db.incrementRunsUsed(userId);

        const sessionId = crypto.randomUUID();
        const session = {
            userId,
            mode,
            description: description || '',
            referenceImageUrl: referenceImageUrl || null,
            images: [],
            status: 'generating',
            total: 6,
            createdAt: Date.now(),
        };
        onboardingSessions.set(sessionId, session);

        // Kick off async generation (don't await)
        generateOnboardingImages(session, ONBOARDING_POSES).catch(err => {
            console.error(`[onboarding] Generation error for session ${sessionId}:`, err.message);
            session.status = 'error';
            session.error = err.message;
        });

        jsonResponse(res, 200, { sessionId, status: 'generating' });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function generateOnboardingImages(session, poses) {
    // Process 2 at a time to respect rate limits
    for (let i = 0; i < poses.length; i += 2) {
        const batch = poses.slice(i, i + 2);
        const results = await Promise.all(batch.map(async (pose) => {
            const prompt = session.mode === 'clone'
                ? `Photorealistic portrait of a person, ${pose}. Match the person's likeness from the reference image exactly.`
                : `${session.description}, ${pose}`;
            const refUrl = session.referenceImageUrl || null;
            return generateImageBounded(prompt, refUrl, 5);
        }));

        for (const result of results) {
            if (result) {
                session.images.push({ url: result.url, prompt: result.prompt || '' });
            } else {
                session.images.push({ url: null, failed: true });
            }
        }
    }
    session.status = 'complete';
}

async function handleOnboardingStatus(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const sessionId = urlObj.pathname.split('/').pop();
    const session = onboardingSessions.get(sessionId);
    if (!session || session.userId !== userId) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
    }
    jsonResponse(res, 200, {
        status: session.status,
        completed: session.images.length,
        total: session.total,
        images: session.images,
        error: session.error || null,
    });
}

async function handleOnboardingComplete(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { sessionId, selectedIndex, name, voiceId, voiceName } = JSON.parse(body);
        if (!sessionId || selectedIndex === undefined || !name) {
            jsonResponse(res, 400, { error: 'sessionId, selectedIndex, and name are required' });
            return;
        }

        const session = onboardingSessions.get(sessionId);
        if (!session || session.userId !== userId) {
            jsonResponse(res, 404, { error: 'Session not found' });
            return;
        }

        const selectedImage = session.images[selectedIndex];
        if (!selectedImage || !selectedImage.url) {
            jsonResponse(res, 400, { error: 'Selected image is invalid or failed' });
            return;
        }

        // Create the character card
        const card = await db.createCharacterCard(userId, {
            name,
            description: session.description || `AI-generated ${session.mode === 'clone' ? 'clone' : 'character'}`,
            thumbnail_url: selectedImage.url,
            category: session.mode === 'clone' ? 'clone' : 'character',
            tags: [session.mode, 'onboarding'],
            character_data: {
                referenceImageUrl: selectedImage.url,
                onboardingMode: session.mode,
            },
        });

        // Save all successful images to character_images
        for (let i = 0; i < session.images.length; i++) {
            const img = session.images[i];
            if (img.url) {
                await db.addCharacterImage(card.id, {
                    url: img.url,
                    type: 'generated',
                    is_primary: i === selectedIndex,
                    sort_order: i,
                    generation_prompt: img.prompt || null,
                });
            }
        }

        // Save voice config if provided
        if (voiceId) {
            await db.saveVoiceConfig(userId, card.id, {
                voice_id: voiceId,
                voice_name: voiceName || null,
            });
        }

        // Mark onboarding complete
        await db.markOnboardingComplete(userId);

        // Clean up session
        onboardingSessions.delete(sessionId);

        jsonResponse(res, 200, { card });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleOnboardingGenerateMore(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
            jsonResponse(res, 400, { error: 'sessionId required' });
            return;
        }

        const session = onboardingSessions.get(sessionId);
        if (!session || session.userId !== userId) {
            jsonResponse(res, 404, { error: 'Session not found' });
            return;
        }

        // Check run limit
        const runCheck = await db.checkRunLimit(userId);
        if (!runCheck.allowed) {
            jsonResponse(res, 403, { error: runCheck.reason });
            return;
        }

        // Deduct 1 more run
        await db.incrementRunsUsed(userId);

        session.status = 'generating';
        session.total += 6;

        // Kick off async generation with same poses
        generateOnboardingImages(session, ONBOARDING_POSES).catch(err => {
            console.error(`[onboarding] Generate-more error:`, err.message);
            session.status = 'error';
            session.error = err.message;
        });

        jsonResponse(res, 200, { status: 'generating', total: session.total });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

// ==================== CARD PORTRAIT GENERATION ====================

const cardPortraitSessions = new Map();

// Auto-cleanup stale card portrait sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of cardPortraitSessions) {
        if (now - session.createdAt > 30 * 60 * 1000) {
            cardPortraitSessions.delete(id);
        }
    }
}, 5 * 60 * 1000);

async function handleCardGeneratePortraits(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { appearance, style } = JSON.parse(body);
        if (!appearance) {
            jsonResponse(res, 400, { error: 'Appearance description is required' });
            return;
        }

        // Check run limit
        const runCheck = await db.checkRunLimit(userId);
        if (!runCheck.allowed) {
            jsonResponse(res, 403, { error: runCheck.reason });
            return;
        }

        // Deduct 1 run
        await db.incrementRunsUsed(userId);

        const sessionId = crypto.randomUUID();
        const description = style ? `${appearance}, ${style}` : appearance;
        const session = {
            userId,
            description,
            images: [],
            status: 'generating',
            total: 6,
            createdAt: Date.now(),
        };
        cardPortraitSessions.set(sessionId, session);

        // Kick off async generation (don't await)
        generateOnboardingImages(session, ONBOARDING_POSES).catch(err => {
            console.error(`[cardPortrait] Generation error for session ${sessionId}:`, err.message);
            session.status = 'error';
            session.error = err.message;
        });

        jsonResponse(res, 200, { sessionId, status: 'generating' });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

async function handleCardPortraitStatus(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const sessionId = urlObj.pathname.split('/').pop();
    const session = cardPortraitSessions.get(sessionId);
    if (!session || session.userId !== userId) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
    }
    jsonResponse(res, 200, {
        status: session.status,
        completed: session.images.length,
        total: session.total,
        images: session.images,
        error: session.error || null,
    });
}

async function handleCardGenerateMorePortraits(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const body = await getRequestBody(req);
    try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
            jsonResponse(res, 400, { error: 'sessionId required' });
            return;
        }

        const session = cardPortraitSessions.get(sessionId);
        if (!session || session.userId !== userId) {
            jsonResponse(res, 404, { error: 'Session not found' });
            return;
        }

        // Check run limit
        const runCheck = await db.checkRunLimit(userId);
        if (!runCheck.allowed) {
            jsonResponse(res, 403, { error: runCheck.reason });
            return;
        }

        // Deduct 1 more run
        await db.incrementRunsUsed(userId);

        session.status = 'generating';
        session.total += 6;

        // Kick off async generation with same poses
        generateOnboardingImages(session, ONBOARDING_POSES).catch(err => {
            console.error(`[cardPortrait] Generate-more error:`, err.message);
            session.status = 'error';
            session.error = err.message;
        });

        jsonResponse(res, 200, { status: 'generating', total: session.total });
    } catch (err) {
        jsonResponse(res, 500, { error: err.message });
    }
}

// ==================== WORKFLOW EDITOR HANDLERS ====================

const FREEPIK_BASE_URL = 'https://api.freepik.com';

function uploadBufferToTempHost(buffer, filename) {
    return new Promise((resolve, reject) => {
        const boundary = '----FormBoundary' + Date.now().toString(36);
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n24h\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const footer = `\r\n--${boundary}--\r\n`;
        const body = Buffer.concat([Buffer.from(header), buffer, Buffer.from(footer)]);
        const req = https.request({
            hostname: 'litterbox.catbox.moe',
            path: '/resources/internals/api.php',
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const resultUrl = data.trim();
                if (resultUrl.startsWith('http')) resolve(resultUrl);
                else reject(new Error(`Upload failed: ${resultUrl.substring(0, 200)}`));
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function weParseMultipart(buffer, boundary) {
    const parts = [];
    const boundaryBuf = Buffer.from('--' + boundary);
    let start = 0;
    while (true) {
        const idx = buffer.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) {
            const partData = buffer.slice(start, idx);
            const headerEnd = partData.indexOf('\r\n\r\n');
            if (headerEnd !== -1) {
                const headers = partData.slice(0, headerEnd).toString('utf8');
                const body = partData.slice(headerEnd + 4, partData.length - 2);
                const nameMatch = headers.match(/name="([^"]+)"/);
                const filenameMatch = headers.match(/filename="([^"]+)"/);
                parts.push({ name: nameMatch ? nameMatch[1] : '', filename: filenameMatch ? filenameMatch[1] : null, data: body });
            }
        }
        start = idx + boundaryBuf.length + 2;
    }
    return parts;
}

function weHttpsRequest(targetUrl, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(targetUrl);
        const client = urlObj.protocol === 'https:' ? https : http;
        const postData = options.body || '';
        const reqOptions = {
            hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search, method: options.method || 'GET', headers: { ...options.headers },
        };
        if (postData && !reqOptions.headers['Content-Length']) {
            const bodyBuf = typeof postData === 'string' ? Buffer.from(postData) : postData;
            reqOptions.headers['Content-Length'] = bodyBuf.length;
        }
        const req = client.request(reqOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return weHttpsRequest(res.headers.location, options).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, data: JSON.parse(raw), raw, headers: res.headers }); }
                catch { resolve({ status: res.statusCode, data: null, raw, headers: res.headers }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(options.timeout || 120000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (postData) req.write(postData);
        req.end();
    });
}

async function handleWorkflowFreepikProxy(req, res, apiPath) {
    const freepikKey = process.env.FREEPIK_API_KEY;
    if (!freepikKey) { jsonResponse(res, 500, { error: 'FREEPIK_API_KEY not configured' }); return; }
    const targetUrl = FREEPIK_BASE_URL + apiPath;
    const method = req.method;
    const headers = { 'x-freepik-api-key': freepikKey, 'Content-Type': 'application/json' };
    let body = '';
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        body = await getRequestBody(req);
    }
    try {
        console.log(`[we-proxy] ${method} ${apiPath}`);
        const resp = await weHttpsRequest(targetUrl, { method, headers, body: body || undefined });
        const respBody = resp.raw || JSON.stringify(resp.data) || '';
        res.writeHead(resp.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(respBody);
    } catch (err) {
        console.error(`[we-proxy] Error: ${err.message}`);
        jsonResponse(res, 502, { error: `Proxy error: ${err.message}` });
    }
}

async function handleWorkflowUpload(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
        if (!boundaryMatch) { jsonResponse(res, 400, { error: 'Missing multipart boundary' }); return; }
        const rawBody = await getRawBody(req);
        const parts = weParseMultipart(rawBody, boundaryMatch[1] || boundaryMatch[2]);
        const filePart = parts.find(p => p.filename);
        if (!filePart) { jsonResponse(res, 400, { error: 'No file in upload' }); return; }
        console.log(`[we-upload] Uploading ${filePart.filename} (${(filePart.data.length / 1024).toFixed(1)} KB)`);
        const publicUrl = await uploadBufferToTempHost(filePart.data, filePart.filename);
        jsonResponse(res, 200, { url: publicUrl, filename: filePart.filename });
    } catch (err) {
        console.error(`[we-upload] Error: ${err.message}`);
        jsonResponse(res, 500, { error: `Upload failed: ${err.message}` });
    }
}

async function handleWorkflowReupload(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const body = await getRequestBody(req);
        const data = JSON.parse(body);
        if (!data.url) { jsonResponse(res, 400, { error: 'Missing url' }); return; }
        const fileBuffer = await new Promise((resolve, reject) => {
            const client = data.url.startsWith('https') ? https : http;
            const doGet = (targetUrl) => {
                client.get(targetUrl, (resp) => {
                    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) return doGet(resp.headers.location);
                    if (resp.statusCode !== 200) { resp.resume(); return reject(new Error(`Download failed: HTTP ${resp.statusCode}`)); }
                    const chunks = []; resp.on('data', c => chunks.push(c)); resp.on('end', () => resolve(Buffer.concat(chunks))); resp.on('error', reject);
                }).on('error', reject);
            };
            doGet(data.url);
        });
        const filename = data.filename || 'file_' + Date.now() + '.png';
        const publicUrl = await uploadBufferToTempHost(fileBuffer, filename);
        jsonResponse(res, 200, { url: publicUrl });
    } catch (err) {
        jsonResponse(res, 500, { error: `Reupload failed: ${err.message}` });
    }
}

async function handleWorkflowChatProxy(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { jsonResponse(res, 500, { error: 'ANTHROPIC_API_KEY not configured' }); return; }
    try {
        const rawBody = await getRequestBody(req);
        console.log(`[we-chat] Proxying to Claude API (${(rawBody.length / 1024).toFixed(1)} KB)`);
        const resp = await weHttpsRequest('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: rawBody, timeout: 180000,
        });
        const respBody = resp.raw || JSON.stringify(resp.data) || '';
        res.writeHead(resp.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(respBody);
    } catch (err) {
        console.error(`[we-chat] Proxy error: ${err.message}`);
        jsonResponse(res, 502, { error: `Chat proxy error: ${err.message}` });
    }
}

async function handleNodeWorkflowList(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const workflows = await db.getNodeWorkflows(userId);
        jsonResponse(res, 200, workflows);
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
}

async function handleNodeWorkflowSave(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const body = JSON.parse(await getRequestBody(req));
        if (!body.name) { jsonResponse(res, 400, { error: 'Missing workflow name' }); return; }
        const result = await db.saveNodeWorkflow(userId, body.name, body.workflow);
        jsonResponse(res, 200, { saved: result.name });
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
}

async function handleNodeWorkflowLoad(name, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const data = await db.getNodeWorkflow(userId, name);
        if (!data) { jsonResponse(res, 404, { error: `Workflow "${name}" not found` }); return; }
        jsonResponse(res, 200, data);
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
}

async function handleNodeWorkflowDelete(name, req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        await db.deleteNodeWorkflow(userId, name);
        jsonResponse(res, 200, { deleted: name });
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
}

async function handleWorkflowAgentMemoryGet(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const memory = await db.getWorkflowAgentMemory(userId);
        jsonResponse(res, 200, memory);
    } catch (err) { jsonResponse(res, 200, { skills: {}, patterns: {}, history: [] }); }
}

async function handleWorkflowAgentMemorySave(req, res) {
    const userId = requireAuth(req, res);
    if (!userId) return;
    try {
        const body = JSON.parse(await getRequestBody(req));
        await db.saveWorkflowAgentMemory(userId, body);
        jsonResponse(res, 200, { saved: true });
    } catch (err) { jsonResponse(res, 500, { error: err.message }); }
}

// ==================== HTTP SERVER ====================
const server = http.createServer(async (req, res) => {
    // CORS
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }

    const urlPath = req.url.split('?')[0];

    // === Health Check (Railway uses this) ===
    if (urlPath === '/health') {
        jsonResponse(res, 200, { status: 'ok', uptime: process.uptime() });
        return;
    }

    // === Auth Routes (no JWT required) ===
    if (urlPath === '/auth/signup' && req.method === 'POST') {
        await handleSignup(req, res); return;
    }
    if (urlPath === '/auth/login' && req.method === 'POST') {
        await handleLogin(req, res); return;
    }
    if (urlPath === '/auth/me' && req.method === 'GET') {
        await handleMe(req, res); return;
    }

    // === Google Sign-In (full redirect flow, no JWT) ===
    if (urlPath === '/auth/google' && req.method === 'GET') {
        handleGoogleLogin(req, res); return;
    }

    // === OAuth Callbacks (no JWT — browser redirect) ===
    if (urlPath.match(/^\/auth\/callback\//)) {
        const platform = urlPath.split('/')[3];
        // Check if this is a Google login callback (reuses /auth/callback/youtube URI)
        const cbUrl = new URL(req.url, `http://localhost:${PORT}`);
        const cbState = cbUrl.searchParams.get('state');
        if (cbState && pendingAuth[cbState]?.platform === 'google-login') {
            await handleGoogleLoginCallback(req, res);
            return;
        }
        await handleAuthCallback(platform, req, res);
        return;
    }

    // === Stripe Webhook (no JWT — Stripe sends directly) ===
    if (urlPath === '/billing/webhook' && req.method === 'POST') {
        await handleStripeWebhook(req, res); return;
    }

    // === Public pages ===
    if (urlPath === '/privacy-policy') { htmlResponse(res, generatePrivacyPolicy()); return; }
    if (urlPath === '/terms') { htmlResponse(res, generateTermsOfService()); return; }
    if (urlPath === '/data-deletion') {
        if (req.method === 'POST') { await handleDataDeletion(req, res); }
        else { htmlResponse(res, generateDataDeletionInfo()); }
        return;
    }
    if (urlPath === '/deauthorize') {
        if (req.method === 'POST') { await handleDeauthorize(req, res); }
        else { htmlResponse(res, '<html><body><h1>Deauthorize Callback</h1></body></html>'); }
        return;
    }

    // === Static files (login page, assets, etc.) ===
    if (urlPath === '/login' || urlPath === '/login.html') {
        if (process.env.BYPASS_AUTH === 'true') {
            // Auto-login: redirect to dashboard with bypass token
            res.writeHead(302, { Location: '/' }); res.end(); return;
        }
        serveStaticFile(path.join(__dirname, 'login.html'), res); return;
    }
    if (urlPath === '/auth/bypass' && process.env.BYPASS_AUTH === 'true') {
        const user = await db.getUserByEmail('test@lokesai.dev');
        if (user) {
            const token = generateToken(user);
            jsonResponse(res, 200, { token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, runs_used: user.runs_used, runs_limit: user.runs_limit } });
        } else {
            jsonResponse(res, 500, { error: 'Bypass user not found' });
        }
        return;
    }
    // Assets API (must come before static /assets/ handler)
    if (urlPath === '/assets/log' && req.method === 'GET') {
        await handleAssetsGet(req, res); return;
    }
    // Serve per-user assets as static files
    if (urlPath.startsWith('/assets/')) {
        const filePath = path.join(__dirname, urlPath);
        serveStaticFile(filePath, res);
        return;
    }
    // Other static files (css, js, etc.)
    if (urlPath.match(/\.(css|js|png|svg|jpg|jpeg|gif|webp|mp4|webm|mp3|wav|ogg|m4a|ico|woff2?)$/)) {
        const filePath = path.join(__dirname, urlPath);
        serveStaticFile(filePath, res);
        return;
    }

    // === n8n-compatible data endpoints (used by workflow, accepts userId query param) ===
    if (urlPath.match(/^\/n8n-data\/(prompts|actions|scenes|variations)$/)) {
        const collection = urlPath.split('/')[2];
        await handleDataN8n(collection, req, res);
        return;
    }

    // === Platform Token (for n8n workflow, accepts userId query param) ===
    if (urlPath.match(/^\/platform-token\/(youtube|instagram|facebook|tiktok)$/) && req.method === 'GET') {
        const platform = urlPath.split('/')[2];
        await handlePlatformToken(platform, req, res);
        return;
    }

    // === Kling JWT Generator ===
    if (urlPath === '/kling-jwt' && req.method === 'GET') {
        jsonResponse(res, 200, { token: generateKlingJWT() });
        return;
    }

    // === Pipeline Events (no auth — polling endpoint) ===
    if (urlPath.startsWith('/pipeline/events/')) {
        const execId = urlPath.split('/')[3];
        handlePipelineEvents(execId, req, res);
        return;
    }

    // === Upload video to temp public host ===
    if (urlPath === '/upload-video-public' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { filePath } = JSON.parse(body);
                if (!filePath || !fs.existsSync(filePath)) {
                    jsonResponse(res, 400, { error: 'filePath required and must exist' });
                    return;
                }
                const filename = path.basename(filePath);
                const fileBuffer = fs.readFileSync(filePath);
                const boundary = '----FormBoundary' + Date.now().toString(36);
                const header = `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n24h\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`;
                const footer = `\r\n--${boundary}--\r\n`;
                const reqBody = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);
                const options = {
                    hostname: 'litterbox.catbox.moe',
                    path: '/resources/internals/api.php',
                    method: 'POST',
                    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': reqBody.length }
                };
                const uploadReq = https.request(options, (uploadRes) => {
                    let data = '';
                    uploadRes.on('data', chunk => data += chunk);
                    uploadRes.on('end', () => {
                        const url = data.trim();
                        if (url.startsWith('http')) {
                            console.log(`🌐 Video public URL: ${url}`);
                            jsonResponse(res, 200, { publicUrl: url });
                        } else {
                            jsonResponse(res, 500, { error: 'Upload failed', detail: data.substring(0, 200) });
                        }
                    });
                });
                uploadReq.on('error', (err) => jsonResponse(res, 500, { error: err.message }));
                uploadReq.write(reqBody);
                uploadReq.end();
            } catch (e) {
                jsonResponse(res, 500, { error: e.message });
            }
        });
        return;
    }

    // =============================================
    // All routes below require JWT authentication
    // =============================================

    // === Social Media Routes ===
    if (urlPath.match(/^\/social\/connect\//)) {
        const platform = urlPath.split('/')[3];
        await handleSocialConnect(platform, req, res);
        return;
    }
    if (urlPath.match(/^\/social\/status/)) {
        const platform = urlPath.split('/')[3] || null;
        await handleSocialStatus(platform, req, res);
        return;
    }
    if (urlPath.match(/^\/social\/disconnect\//) && req.method === 'POST') {
        const platform = urlPath.split('/')[3];
        await handleSocialDisconnect(platform, req, res);
        return;
    }

    // === Agent Config API ===
    if (urlPath === '/agent-config') {
        if (req.method === 'GET') { await handleAgentConfigGet(req, res); return; }
        if (req.method === 'POST') { await handleAgentConfigPost(req, res); return; }
    }
    if (urlPath === '/agent-config/list' && req.method === 'GET') {
        await handleAgentConfigList(req, res); return;
    }
    if (urlPath === '/agent-config/switch' && req.method === 'POST') {
        await handleAgentConfigSwitch(req, res); return;
    }
    if (urlPath === '/agent-config/rename' && req.method === 'POST') {
        await handleAgentConfigRename(req, res); return;
    }

    // === Data Manager API ===
    if (urlPath.match(/^\/data\/(prompts|actions|scenes|variations)$/)) {
        const collection = urlPath.split('/')[2];
        if (req.method === 'GET') { await handleDataGet(collection, req, res); return; }
        if (req.method === 'POST') { await handleDataPost(collection, req, res); return; }
    }

    // === Asset Saving ===
    if (urlPath === '/save-asset' && req.method === 'POST') {
        await handleSaveAsset(req, res); return;
    }
    if (urlPath === '/assets/log' && req.method === 'GET') {
        await handleAssetsGet(req, res); return;
    }

    // === Music Pool ===
    if (urlPath === '/upload-music' && req.method === 'POST') {
        await handleUploadMusic(req, res); return;
    }
    if (urlPath === '/api/upload-motion-reference' && req.method === 'POST') {
        await handleUploadMotionReference(req, res); return;
    }

    // === Motion Library ===
    if (urlPath === '/api/motions/search-web' && req.method === 'GET') {
        await handleMotionWebSearch(req, res); return;
    }
    if (urlPath === '/api/motions/save-from-web' && req.method === 'POST') {
        await handleMotionSaveFromWeb(req, res); return;
    }
    if (urlPath === '/api/motions' && req.method === 'GET') {
        await handleMotionLibraryGet(req, res); return;
    }
    if (urlPath === '/api/motions' && req.method === 'POST') {
        await handleMotionUpload(req, res); return;
    }
    const motionIdMatch = urlPath.match(/^\/api\/motions\/([a-f0-9-]+)$/);
    if (motionIdMatch && req.method === 'DELETE') {
        await handleMotionDelete(motionIdMatch[1], req, res); return;
    }
    const motionUseMatch = urlPath.match(/^\/api\/motions\/([a-f0-9-]+)\/use$/);
    if (motionUseMatch && req.method === 'POST') {
        const userId = requireAuth(req, res);
        if (!userId) return;
        try { await db.incrementMotionUseCount(motionUseMatch[1]); } catch {}
        jsonResponse(res, 200, { ok: true });
        return;
    }

    if (urlPath.match(/^\/data\/music\/(\d+)$/) && req.method === 'DELETE') {
        const id = parseInt(urlPath.split('/')[3]);
        await handleDeleteMusic(id, req, res); return;
    }

    // === Run Limiting / Workflow Trigger ===
    if (urlPath === '/workflow/trigger' && req.method === 'POST') {
        await handleWorkflowTrigger(req, res); return;
    }

    // === Execution Tracking ===
    if (urlPath === '/executions' && req.method === 'GET') {
        await handleExecutionsList(req, res); return;
    }
    if (urlPath === '/executions' && req.method === 'POST') {
        await handleExecutionCreate(req, res); return;
    }
    if (urlPath === '/executions/update' && req.method === 'POST') {
        await handleExecutionUpdate(req, res); return;
    }

    // === Billing ===
    if (urlPath === '/billing/create-checkout' && req.method === 'POST') {
        await handleCreateCheckout(req, res); return;
    }
    if (urlPath === '/billing/status' && req.method === 'GET') {
        await handleBillingStatus(req, res); return;
    }

    // === Pipeline API (built-in engine, replaces n8n workflow execution) ===
    if (urlPath === '/api/pipeline/run' && req.method === 'POST') {
        await handlePipelineRun(req, res); return;
    }
    if (urlPath.match(/^\/api\/pipeline\/status\/(\d+)$/) && req.method === 'GET') {
        const jobId = urlPath.split('/')[4];
        await handlePipelineStatus(jobId, req, res); return;
    }
    if (urlPath === '/api/pipeline/history' && req.method === 'GET') {
        await handlePipelineHistory(req, res); return;
    }
    if (urlPath === '/api/pipeline/stats' && req.method === 'GET') {
        await handlePipelineStats(req, res); return;
    }

    // === Schedule API ===
    if (urlPath === '/api/schedule' && req.method === 'GET') {
        await handleScheduleGet(req, res); return;
    }
    if (urlPath === '/api/schedule' && req.method === 'POST') {
        await handleScheduleSave(req, res); return;
    }

    // === Calendar Schedule API ===
    if (urlPath === '/api/schedule/calendar' && req.method === 'GET') {
        await handleCalendarGet(req, res); return;
    }
    if (urlPath === '/api/schedule/calendar' && req.method === 'POST') {
        await handleCalendarSave(req, res); return;
    }

    // === Saved Looks API ===
    if (urlPath === '/api/looks' && req.method === 'GET') {
        await handleLooksGet(req, res); return;
    }
    if (urlPath === '/api/looks' && req.method === 'POST') {
        await handleLooksCreate(req, res); return;
    }
    if (urlPath.match(/^\/api\/looks\/([0-9a-f-]+)$/) && req.method === 'DELETE') {
        const lookId = urlPath.split('/')[3];
        await handleLooksDelete(lookId, req, res); return;
    }
    if (urlPath.match(/^\/api\/looks\/([0-9a-f-]+)\/run$/) && req.method === 'POST') {
        const lookId = urlPath.split('/')[3];
        await handleLooksRun(lookId, req, res); return;
    }

    // === Test Agent ===
    if (urlPath === '/api/test-agent' && req.method === 'POST') {
        await handleTestAgent(req, res); return;
    }

    // === Content Agent ===
    if (urlPath === '/api/agent/generate-content' && req.method === 'POST') {
        await handleAgentGenerateContent(req, res); return;
    }

    // === Master Agent Chat ===
    if (urlPath === '/api/agent/chat' && req.method === 'POST') {
        await handleAgentChat(req, res); return;
    }

    // === Workflow Editor API ===
    if (urlPath.startsWith('/api/workflow-editor/freepik/')) {
        const userId = requireAuth(req, res);
        if (!userId) return;
        const apiPath = urlPath.replace('/api/workflow-editor/freepik', '');
        await handleWorkflowFreepikProxy(req, res, apiPath); return;
    }
    if (urlPath === '/api/workflow-editor/upload' && req.method === 'POST') {
        await handleWorkflowUpload(req, res); return;
    }
    if (urlPath === '/api/workflow-editor/reupload' && req.method === 'POST') {
        await handleWorkflowReupload(req, res); return;
    }
    if (urlPath === '/api/workflow-editor/chat' && req.method === 'POST') {
        await handleWorkflowChatProxy(req, res); return;
    }
    if (urlPath === '/api/workflow-editor/workflows' && req.method === 'GET') {
        await handleNodeWorkflowList(req, res); return;
    }
    if (urlPath === '/api/workflow-editor/workflows' && req.method === 'POST') {
        await handleNodeWorkflowSave(req, res); return;
    }
    if (urlPath.startsWith('/api/workflow-editor/workflows/') && req.method === 'GET') {
        const name = decodeURIComponent(urlPath.split('/api/workflow-editor/workflows/')[1]);
        await handleNodeWorkflowLoad(name, req, res); return;
    }
    if (urlPath.startsWith('/api/workflow-editor/workflows/') && req.method === 'DELETE') {
        const name = decodeURIComponent(urlPath.split('/api/workflow-editor/workflows/')[1]);
        await handleNodeWorkflowDelete(name, req, res); return;
    }
    if (urlPath === '/api/workflow-editor/agent-memory' && req.method === 'GET') {
        await handleWorkflowAgentMemoryGet(req, res); return;
    }
    if (urlPath === '/api/workflow-editor/agent-memory' && req.method === 'POST') {
        await handleWorkflowAgentMemorySave(req, res); return;
    }

    // === Onboarding API ===
    if (urlPath === '/api/onboarding/generate' && req.method === 'POST') {
        await handleOnboardingGenerate(req, res); return;
    }
    if (urlPath.match(/^\/api\/onboarding\/status\//) && req.method === 'GET') {
        await handleOnboardingStatus(req, res); return;
    }
    if (urlPath === '/api/onboarding/complete' && req.method === 'POST') {
        await handleOnboardingComplete(req, res); return;
    }
    if (urlPath === '/api/onboarding/generate-more' && req.method === 'POST') {
        await handleOnboardingGenerateMore(req, res); return;
    }

    // === Card Portrait Generation API ===
    if (urlPath === '/api/cards/generate-portraits' && req.method === 'POST') {
        await handleCardGeneratePortraits(req, res); return;
    }
    if (urlPath.match(/^\/api\/cards\/portrait-status\//) && req.method === 'GET') {
        await handleCardPortraitStatus(req, res); return;
    }
    if (urlPath === '/api/cards/generate-more-portraits' && req.method === 'POST') {
        await handleCardGenerateMorePortraits(req, res); return;
    }

    // === Character Card API ===
    if (urlPath === '/api/cards' && req.method === 'GET') {
        await handleCardsGet(req, res); return;
    }
    if (urlPath === '/api/cards' && req.method === 'POST') {
        await handleCardCreate(req, res); return;
    }
    if (urlPath === '/api/cards/compose' && req.method === 'POST') {
        await handleCardsCompose(req, res); return;
    }
    if (urlPath.match(/^\/api\/cards\/([0-9a-f-]{36})$/) && req.method === 'GET') {
        const cardId = urlPath.split('/')[3];
        await handleCardGet(cardId, req, res); return;
    }
    if (urlPath.match(/^\/api\/cards\/([0-9a-f-]{36})$/) && req.method === 'PUT') {
        const cardId = urlPath.split('/')[3];
        await handleCardUpdate(cardId, req, res); return;
    }
    if (urlPath.match(/^\/api\/cards\/([0-9a-f-]{36})$/) && req.method === 'DELETE') {
        const cardId = urlPath.split('/')[3];
        await handleCardDelete(cardId, req, res); return;
    }
    if (urlPath.match(/^\/api\/cards\/([0-9a-f-]{36})\/clone$/) && req.method === 'POST') {
        const cardId = urlPath.split('/')[3];
        await handleCardClone(cardId, req, res); return;
    }
    if (urlPath.match(/^\/api\/cards\/([0-9a-f-]{36})\/generate-thumbnail$/) && req.method === 'POST') {
        const cardId = urlPath.split('/')[3];
        await handleCardGenerateThumbnail(cardId, req, res); return;
    }
    if (urlPath.match(/^\/api\/cards\/([0-9a-f-]{36})\/upload-image$/) && req.method === 'POST') {
        const cardId = urlPath.split('/')[3];
        await handleCardImageUpload(cardId, req, res); return;
    }
    if (urlPath.match(/^\/api\/cards\/([0-9a-f-]{36})\/voice$/) && req.method === 'POST') {
        const cardId = urlPath.split('/')[3];
        await handleVoiceConfigSave(cardId, req, res); return;
    }

    // === Scene API ===
    if (urlPath === '/api/scenes' && req.method === 'GET') {
        await handleScenesGet(req, res); return;
    }
    if (urlPath === '/api/scenes' && req.method === 'POST') {
        await handleSceneCreate(req, res); return;
    }
    if (urlPath.match(/^\/api\/scenes\/([0-9a-f-]{36})$/) && req.method === 'PUT') {
        const sceneId = urlPath.split('/')[3];
        await handleSceneUpdate(sceneId, req, res); return;
    }
    if (urlPath.match(/^\/api\/scenes\/([0-9a-f-]{36})$/) && req.method === 'DELETE') {
        const sceneId = urlPath.split('/')[3];
        await handleSceneDelete(sceneId, req, res); return;
    }
    if (urlPath.match(/^\/api\/scenes\/([0-9a-f-]{36})\/generate$/) && req.method === 'POST') {
        const sceneId = urlPath.split('/')[3];
        await handleSceneGenerate(sceneId, req, res); return;
    }

    // === Voice API ===
    if (urlPath === '/api/voices' && req.method === 'GET') {
        await handleVoicesList(req, res); return;
    }
    if (urlPath === '/api/voices/preview' && req.method === 'POST') {
        await handleVoicePreview(req, res); return;
    }
    if (urlPath === '/api/voices/generate' && req.method === 'POST') {
        await handleVoiceGenerate(req, res); return;
    }
    if (urlPath === '/api/voices/clone' && req.method === 'POST') {
        await handleVoiceClone(req, res); return;
    }

    // === v1 route aliases (backwards compat with current frontend) ===
    if (urlPath === '/v1/pipeline/run' && req.method === 'POST') {
        await handlePipelineRun(req, res); return;
    }
    if (urlPath.match(/^\/v1\/pipeline\/status\/(\d+)$/) && req.method === 'GET') {
        const jobId = urlPath.split('/')[4];
        await handlePipelineStatus(jobId, req, res); return;
    }
    if (urlPath === '/v1/pipeline/history' && req.method === 'GET') {
        await handlePipelineHistory(req, res); return;
    }
    if (urlPath === '/v1/pipeline/stats' && req.method === 'GET') {
        await handlePipelineStats(req, res); return;
    }
    if (urlPath === '/v1/schedule' && req.method === 'GET') {
        await handleScheduleGet(req, res); return;
    }
    if (urlPath === '/v1/schedule' && req.method === 'POST') {
        await handleScheduleSave(req, res); return;
    }
    if (urlPath === '/v1/test-agent' && req.method === 'POST') {
        await handleTestAgent(req, res); return;
    }

    // === n8n API Proxy (fallback for any remaining n8n calls) ===
    if (urlPath.startsWith('/api/')) {
        const n8nPath = req.url.replace('/api/', '/rest/');
        proxyToN8n(req, res, n8nPath);
        return;
    }

    // === Default: serve index.html (SPA) ===
    const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
    serveStaticFile(filePath, res);
});

// ==================== HTTPS SERVER ====================
let httpsServer = null;
try {
    const keyPath = path.join(__dirname, 'localhost-key.pem');
    const certPath = path.join(__dirname, 'localhost-cert.pem');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        const sslOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
        httpsServer = https.createServer(sslOptions, server._events.request);
    }
} catch (e) {
    console.log('HTTPS server skipped (no SSL certs)');
}

// ==================== STARTUP ====================
// Ensure base assets directory exists
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// Monthly run reset — runs at midnight on the 1st of each month
function scheduleMonthlyReset() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
    const msUntilReset = nextMonth - now;
    setTimeout(async () => {
        await db.resetMonthlyRuns();
        scheduleMonthlyReset(); // Schedule next month
    }, msUntilReset);
    console.log(`📅 Monthly run reset scheduled in ${Math.round(msUntilReset / 86400000)}d`);
}

(async () => {
    // Initialize database
    try {
        await db.initDB();
    } catch (err) {
        console.error('❌ Failed to initialize database:', err.message);
        console.error('   Make sure PostgreSQL is running and database "loki_saas" exists.');
        console.error('   Create it with: createdb loki_saas');
        process.exit(1);
    }

    // Bypass auth: create test user on startup
    if (process.env.BYPASS_AUTH === 'true') {
        try {
            let user = await db.getUserByEmail('test@lokesai.dev');
            if (!user) {
                const bcrypt = require('bcryptjs');
                const hash = await bcrypt.hash('test123', 12);
                user = await db.createUser('test@lokesai.dev', hash, 'Test User');
                console.log(`🧪 Bypass auth: created test user (ID: ${user.id})`);
            }
            _bypassUserId = user.id;
            console.log(`🧪 Auth bypass ON — all requests use user ID ${_bypassUserId}`);
        } catch (err) {
            console.error('Bypass user setup error:', err.message);
            _bypassUserId = 1;
        }
    }

    // Initialize pipeline queue
    try {
        initQueue();
    } catch (err) {
        console.error('Queue init error:', err.message);
    }

    // Start pipeline scheduler
    startScheduler();

    // Login to n8n (optional fallback proxy)
    try {
        await loginToN8n();
    } catch (err) {
        console.log('n8n login skipped (not running):', err.message);
    }

    // Schedule monthly run reset
    scheduleMonthlyReset();

    // One-time config seed: populate empty user configs with default Valhalla Girls data
    try {
        const seedConfig = {
            character_description: "2 sexy 19 years old women, one swedish viking girl with sexy silver hair pale skin and viking irish girl with blond hair golden tan and green eyes, string bikini, tiny triangle viking viking bikini top, leather straps only, riding on a dangerous mountain side with steep drop winter storm, close up side profile, snowing, riding horses, under boob showing, tiny micro bikini just covering nipples, close up side profile, covered in baby oil, massive breast",
            prompts: [
                {id:1,text:"2 sexy 19 years old women, one swedish viking girl with sexy silver hair pale skin and viking Ukrainian girl with blond hair golden tan and green eyes, string bikini, tiny triangle viking viking bikini top, leather straps only, riding on a dangerous mountain side with steep drop winter storm, close up side profile, snowing, riding horses, under boob showing, tiny micro bikni just covering nipples, close up side profile, baby oil covered body, eye shadow, war paint"},
                {id:2,text:"2 sexy 19 years old women, one finish girl with sexy red hair freckles hair, german girl with blond hair and green eyes, very large double d size breast, the womens giant breasts are very perky and pushed up to show cleavage, define abs, tiny waist, low waisted string bikini, tiny triangle viking bikini top pushing tight against breasts, leather straps only, both riding beautiful horses through mountain trails, the womens giant breasts and abs dominating frame, close up side profile, sunset, golden hour lighting, viking armlet armor, winter, shot Sony a7 v5 55mm lens, baby oil covered, close up side profile, covered in baby oil, eye shadow, war paint"},
                {id:3,text:"2 sexy 19 years old women, one irish viking girl with sexy silver hair pale skin and viking Swedish girl with red head hair freckles pale skin and green eyes, string bikini, tiny triangle viking viking bikini top, leather straps only, riding horses on a dangerous mountain side with steep drop winter, close up side profile, snowing, gothic eyeshadow and and war paint, just bikinis, swords on backs, covered in baby oil, eye shadow, war paint"},
                {id:4,text:"2 sexy 19 years old women, one Swedish viking girl with sexy silver hair pale skin and viking Swedish girl with red head hair freckles pale skin and green eyes, string bikini, tiny triangle viking viking bikini top, leather straps only, riding horses on a dangerous mountain side with steep drop winter, close up side profile, snowing, gothic eyeshadow and and war paint, just bikinis, swords on backs, eye shadow, war paint"},
                {id:5,text:"2 sexy 19 years old women, one Swedish viking girl with sexy silver hair pale skin and viking Swedish girl with red head hair freckles pale skin and green eyes, string bikini, tiny triangle viking viking bikini top, leather straps only, riding horses on a dangerous mountain side with steep drop winter, close up side profile, snowing, gothic eyeshadow and and war paint, just bikinis, swords on backs, eye shadow, war paint"}
            ],
            actions: [
                {id:1,text:"slow motion horse gallop and boobs bounce and jiggle shot heavy breathing cinematic sony a7 50mm"},
                {id:2,text:"Walking towards camera confidently"},{id:3,text:"Stretching and warming up"},
                {id:4,text:"Dancing slowly to music"},{id:5,text:"Turning around showing outfit"},
                {id:6,text:"Sitting down gracefully"},{id:7,text:"Riding a horse"},
                {id:8,text:"Jumping to celebrate"},{id:9,text:"Rocking on a boat"}
            ],
            scenes: [
                {id:1,text:"Beach sunset with golden hour lighting, waves crashing in background"},
                {id:2,text:"mountain trail"},{id:3,text:"mountain trail snow"},
                {id:4,text:"Medieval castle courtyard with torches and stone walls"},
                {id:5,text:"Snowy mountain cabin with warm firelight"},
                {id:6,text:"Luxury yacht deck with ocean view"},
                {id:7,text:"Ancient Greek temple ruins at dusk"},
                {id:8,text:"Mountain trails on horseback, sunset, golden hour lighting, winter"},
                {id:9,text:"Neon-lit Tokyo side street at night, rain-slicked pavement reflecting pink and blue signs"},
                {id:10,text:"Tropical waterfall lagoon surrounded by lush green jungle"},
                {id:11,text:"Viking longship deck under the northern lights, icy ocean"},
                {id:12,text:"Rooftop pool overlooking a city skyline at sunset"}
            ],
            variations: {
                hair:["brown","red head","dirty blond","black","light green with dark green highlight","light blue","Blond","white and grey"],
                background:["European","Asian","American","Russian","Ukrainian","finish","Danish"],
                skin_tone:["Pale skin","pale skin with freckles","golden tan"],
                eye_color:["bright Green","bright Blue","Gray","ice blue","dark green"],
                hair_type:["viking style","shoulder length viking","pixie cut"]
            },
            content_rules: "",
            reference_image_url: "https://res.cloudinary.com/dxthotpnl/image/upload/v1770041171/thumb_7b0bb3af-f0ee-4b41-b1fc-de25324757c5_nb6kt8.png",
            caption_template: "🔥 Just a Viking Girl\n\n#ai #aiart #reels #viking #aigirl"
        };
        const allUsers = await db.pool.query('SELECT id FROM users');
        for (const u of allUsers.rows) {
            const existing = await db.getActiveConfig(u.id);
            const cfg = existing?.config || {};
            if (!cfg.prompts || cfg.prompts.length === 0) {
                await db.saveActiveConfig(u.id, seedConfig);
                console.log(`📋 Seeded default config for user ${u.id}`);
            }
        }
    } catch (e) { console.log('Config seed skipped:', e.message); }

    // One-time migration: Update Config 2 (slot 1) with optimized photography-language prompts
    try {
        const optimizedConfig2 = {
            character_description: "2 young 19-year-old women: Swedish viking girl with silver hair, pale skin, and an Irish viking girl with blonde hair, golden tan, green eyes. Both with voluptuous athletic builds, full ample bustlines with visible underboob and deep cleavage. Wearing minimal string bikinis — tiny triangle viking-style tops barely containing their bust, leather strap accents only. Riding horses on a dangerous mountainside with steep drop, winter storm, snowfall. Close-up side profile, bodies glistening with oil. Photorealistic, cinematic photography.",
            prompts: [
                {id:1,text:"Photorealistic cinematic portrait, Sony A7 IV, 85mm f/1.4, golden hour rim lighting, 9:16 vertical frame:\n\nTwo 19-year-old women on horseback, extreme close-up side profile, shallow depth of field.\n\nWOMAN 1 — Swedish viking. Silver-white hair in loose battle braids. Pale porcelain skin, ice-blue eyes. Extremely voluptuous figure with very large, full, heavy breasts — barely contained by a micro sling bikini top: a single thin bronze-colored strip running vertically between her breasts, breasts overflowing and spilling out on both sides, maximum cleavage, full round underboob visible, prominent side-boob. Micro leather g-string bottom. Bronze Norse-knotwork shoulder pauldron on left shoulder, bronze wolf-head upper-arm cuff, leather forearm bracers with bronze rivets. Paper-thin fabric straining against her bust. Oiled torso glistening, catching warm golden light.\n\nWOMAN 2 — Irish viking. Golden blonde warrior braids, tanned skin, emerald green eyes. Equally voluptuous with very large, round, perky breasts — barely covered by a micro triangle string bikini top: two tiny leather triangle patches barely covering nipples, connected by the thinnest strings, extreme cleavage, full underboob, side-boob all visible, breasts straining against the minimal fabric. Micro leather string bikini bottom with a single iron ring clasp. Blackened steel Celtic-spiral shoulder armor on right shoulder, dark leather forearm vambraces with raven engravings, spiked steel wrist cuffs. Oiled skin with warm golden sheen.\n\nBoth mounted on powerful war horses galloping along a narrow mountain ridge. Steep deadly cliff drop on one side. Heavy snowfall, winter storm clouds. Bodies drenched in oil catching the golden hour backlight, every curve highlighted. Smoky dark eyeshadow, tribal war paint on cheekbones. Swords strapped across bare backs.\n\nDynamic side-profile composition, figures dominating the frame, creamy bokeh background, cinematic color grading."},
                {id:2,text:"Photorealistic portrait, Sony A7V, 55mm f/1.8, dramatic winter sunset backlight, 9:16 vertical:\n\nTwo 19-year-old women riding horses at full gallop, close-up side angle, shallow DOF.\n\nWOMAN 1 — Finnish. Fiery copper-red hair flowing loose in the wind. Freckled pale skin, hazel eyes. Tall statuesque figure with extremely large, full, heavy breasts — barely contained by a cupless chain halter: fine gold chains draped across her chest providing decorative framing only, breasts overflowing and spilling through the chains, deep plunging cleavage between massive breasts, full round underboob visible, side-boob prominent from every angle. Micro gold chainmail loincloth g-string bottom. Gold Viking pauldrons on both shoulders with Odin's ravens embossed, gold serpent arm-rings wrapping biceps, leather fingerless gauntlets with gold studs. Toned abs visible, oiled wet skin catching the sunset.\n\nWOMAN 2 — Ukrainian. Platinum blonde hair in crown braids, golden tan skin, bright green eyes. Athletic curvaceous figure with very large, round, perky breasts — barely covered by a single-strap bandeau: the thinnest possible copper-colored strip wound once across her chest, everything above and below fully visible, extreme deep cleavage, full underboob, side-boob from all angles, breasts barely contained and overflowing. Thin leather cord micro g-string bottom with copper ring detail. Burnished copper open-frame Viking chest harness framing the ribcage below. Copper scale-mail shoulder guards, copper snake arm coils, leather wrist guards with Norse rune inlays. Oil-slicked golden skin.\n\nBoth at full gallop along a frozen mountain river, icy cliffs on both sides, snow blowing horizontally. Oiled skin catching golden-orange sunset light, breath visible in cold air. Heavy smoky eye makeup, dark tribal war paint streaks on cheeks.\n\nCinematic portrait composition, close-up side angle, warm-cool color contrast, dreamy shallow depth of field."},
                {id:3,text:"Photorealistic portrait, Sony A7 IV, 85mm f/1.4, moody overcast diffused winter light, 9:16 vertical:\n\nTwo 19-year-old women on horseback, tight side-profile framing, figures filling the frame, cinematic shallow DOF.\n\nWOMAN 1 — Danish viking. White-grey pixie cut hair, ghostly pale skin, steel-grey eyes. Voluptuous powerful build with very large, full, heavy breasts — barely contained by a ring-connect micro top: two small blackened iron rings holding minimal leather patches over nipples, connected by fine dark chains, deep visible cleavage, complete round underboob on display, side-boob prominent, breasts overflowing the minimal coverage. Micro leather thong bottom with iron ring details. Dark blackened steel asymmetric shoulder pauldron with dire wolf skull motif on right shoulder, articulated steel upper-arm guard, heavy spiked leather vambraces, steel finger-claws on left hand, dark fur half-cape from shoulder armor. Oil-slicked pale skin catching cold diffused light.\n\nWOMAN 2 — Russian viking. Jet-black long hair in warrior braids with silver beads, pale skin, dark green eyes. Equally voluptuous with extremely large, round breasts — barely covered by a micro sling bikini top: a single thin dark leather strip running vertically between her breasts, breasts spilling out on both sides, extreme cleavage, full underboob, side-boob all visible, barely containing her bust. Diagonal leather strap accent from left hip to right shoulder. Leather micro thong bottom. Polished dark steel backless breastplate covering only spine and ribs, steel scale-mail hip panels, blued steel forearm guards with bear claw engravings, steel-tipped leather gloves. Oil-slicked skin glistening.\n\nBoth navigating a treacherous mountain switchback in heavy snowstorm, dramatic cliffside drop behind them. Gothic black eyeshadow, bold geometric war paint on faces and collarbones. Axes strapped to saddles.\n\nTight moody composition, desaturated cool tones, figures dominating frame, cinematic shallow DOF."},
                {id:4,text:"Photorealistic portrait, Sony A7 IV, 135mm telephoto f/2, blue-hour twilight, 9:16 vertical:\n\nTwo 19-year-old women riding white horses, close side-profile composition, telephoto compression, dreamy bokeh.\n\nWOMAN 1 — Swedish viking. Long silver hair flowing in the wind, pale skin with light freckles, bright ice-blue eyes. Tall voluptuous build with very large, generous, heavy breasts — barely covered by a micro triangle string bikini top: two tiny silver-fabric triangle patches barely covering nipples, connected by delicate silver chains, maximum deep cleavage, full round underboob completely visible, side-boob prominent, breasts straining against the paper-thin fabric. Sheer micro g-string bottom, silver chain waistlet with dangling crystal charms. Polished mirror-silver Valkyrie wing shoulder guard on right shoulder, silver torque necklace with crystal terminals, delicate silver chain arm-drape from shoulder to wrist, silver shin greaves with frost-fern patterns. Oiled skin catching ethereal blue-green northern lights glow.\n\nWOMAN 2 — Swedish. Vibrant red hair with braids and bone beads, pale freckled skin, deep green eyes. Curvaceous powerful figure with very large, full, perky breasts — barely contained by a cupless chain halter: fine iron chains draped across her chest providing decorative framing only, breasts overflowing through the chains, extreme cleavage, full underboob, side-boob from every angle. Leather cord micro g-string bottom with iron ring. Heavy weathered iron beast-skull pauldron on left shoulder with real fur trim, thick scarred leather arm wraps with iron plates, iron-banded leather war belt with dagger sheath. Oiled freckled skin catching blue twilight.\n\nBoth riding through a frozen mountain pass at twilight, northern lights shimmering green and blue above, ice crystals floating in the air. Glistening oiled bodies catching the ethereal aurora light. Shimmering silver eyeshadow, luminous blue war paint markings. Spears held upright.\n\nTelephoto compression, dreamy bokeh background, cool blue-green color palette, ethereal mood."},
                {id:5,text:"Photorealistic portrait, Sony A7 IV, 50mm f/1.4, harsh dramatic side-lighting, 9:16 vertical:\n\nTwo 19-year-old women charging on dark horses, aggressive dynamic close-up side profile, sharp cinematic contrast.\n\nWOMAN 1 — Norwegian viking. Dirty blonde hair in messy battle braids, tanned skin, fierce amber eyes. Muscular yet voluptuous figure with very large, full, heavy breasts — barely covered by a single-strap bandeau: the thinnest possible blood-red leather strip wound once across her chest, breasts barely contained and overflowing above and below, extreme deep cleavage, complete underboob visible, side-boob from both sides. Blood-red leather cord micro g-string bottom. Bone-and-leather Viking armor: real animal bone shoulder piece lashed with sinew on right shoulder, bone-fragment chest harness framing below, red-dyed leather arm wraps with bone spike studs, necklace of animal teeth and claws, blood-red torn war cape flowing behind. Battle-slicked oiled skin catching harsh firelight.\n\nWOMAN 2 — Icelandic. Jet black hair shaved on left side with long braids on right, pale skin, storm-blue eyes. Athletic voluptuous build with extremely large, round, perky breasts — barely contained by a ring-connect micro top: two small bone rings holding minimal animal-hide patches over nipples, connected by thin sinew chains, extreme cleavage, full underboob, side-boob prominent, breasts overflowing the minimal coverage. Leather strip micro g-string bottom with iron buckles. Raw Viking bone armor: asymmetric rib-bone pauldron on right shoulder, bone-plated leather gauntlets, leather thigh guards with embedded bone fragments, skull-fragment belt buckle. Sweat and oil catching harsh warm firelight.\n\nBoth charging across a blood-red sunset mountain battlefield, war banners flying, snow mixed with ash falling. Intense black war paint covering half their faces, dark kohl-rimmed eyes. Battle axes raised overhead.\n\nAggressive dynamic angle, harsh warm/cool contrast, sharp cinematic grading, shallow DOF."}
            ],
            actions: [
                {id:1,text:"slow motion gallop, breasts bouncing heavily with each stride, hair flowing in wind, close-up tracking shot, cinematic Sony A7 IV 50mm shallow DOF"}
            ],
            scenes: [
                {id:1,text:"narrow mountain ridge, steep cliff drop, heavy snowfall"},
                {id:2,text:"frozen mountain river, icy cliffs, blowing snow"},
                {id:3,text:"mountain switchback trail, snowstorm, dramatic cliffside"},
                {id:4,text:"frozen mountain pass, northern lights, ice crystals in air"},
                {id:5,text:"mountain battlefield, blood-red sunset, snow and ash falling"}
            ],
            variations: {
                hair:["platinum blonde","copper red","jet black","dirty blonde","silver white","dark brown","strawberry blonde","ash grey"],
                background:["Swedish","Norwegian","Finnish","Danish","Icelandic","Russian","Ukrainian","Irish"],
                skin_tone:["pale porcelain","pale with freckles","golden tan","olive","fair with rosy cheeks"],
                eye_color:["ice blue","bright green","amber","storm grey","dark green","hazel","violet"],
                hair_type:["loose battle braids","flowing loose in wind","pixie cut","shaved one side with long braids","crown braids","messy warrior braids","waist-length straight"]
            },
            content_rules: "",
            reference_image_url: "https://res.cloudinary.com/dxthotpnl/image/upload/v1770041171/thumb_7b0bb3af-f0ee-4b41-b1fc-de25324757c5_nb6kt8.png",
            music: [{id:1,name:"Fire In My Viens 6",file:"1771022687243_Fire_In_My_Viens_6.wav",pinned:true}],
            caption_template: "🔥 Just a Viking Girl\n\n#ai #aiart #reels #viking #aigirl",
            skip_llm_merge: false
        };
        const allUsers2 = await db.pool.query('SELECT id FROM users');
        let updatedCount = 0;
        for (const u of allUsers2.rows) {
            const res = await db.pool.query(
                `UPDATE user_configs SET config_json = $1 WHERE user_id = $2 AND slot = 1 RETURNING id`,
                [JSON.stringify(optimizedConfig2), u.id]
            );
            updatedCount += res.rowCount;
        }
        console.log(`Config 2 migration: updated ${updatedCount} rows for ${allUsers2.rows.length} users`);
        // Verify: read back first user's Config 2 to confirm skip_llm_merge is set
        if (allUsers2.rows.length > 0) {
            const verify = await db.pool.query(
                `SELECT config_json FROM user_configs WHERE user_id = $1 AND slot = 1`,
                [allUsers2.rows[0].id]
            );
            const verifiedConfig = verify.rows[0]?.config_json || {};
            console.log(`Config 2 verify: skip_llm_merge=${verifiedConfig.skip_llm_merge}, prompts=${verifiedConfig.prompts?.length}, first_prompt_start="${(verifiedConfig.prompts?.[0]?.text || '').substring(0, 50)}..."`);
        }
    } catch (e) { console.log('Config 2 migration error:', e.message); }

    // Reset all runs and give admin unlimited
    try {
        await db.pool.query("UPDATE users SET runs_used = 0");
        await db.pool.query(
            "UPDATE users SET runs_limit = 9999 WHERE email = 'admin@lokiai.com'"
        );
        console.log('👑 All runs reset, admin set to unlimited');
    } catch (e) { console.log('Run reset skipped:', e.message); }

    // Clean up stale processing/queued jobs (killed by server restart)
    try {
        const stale = await db.pool.query(
            "UPDATE jobs SET status = 'failed', error = 'Server restarted' WHERE status IN ('processing', 'queued') RETURNING id"
        );
        if (stale.rows.length > 0) {
            console.log(`🧹 Cleaned up ${stale.rows.length} stale jobs: ${stale.rows.map(r => r.id).join(', ')}`);
        }
    } catch (e) { console.log('Stale job cleanup skipped:', e.message); }

    // Backfill assets from completed jobs that aren't in assets table yet
    try {
        const completedJobs = await db.pool.query(
            "SELECT j.id, j.user_id, j.result FROM jobs j WHERE j.status = 'completed' AND j.result IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.execution_id = CAST(j.id AS TEXT))"
        );
        for (const job of completedJobs.rows) {
            const r = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
            if (r?.image?.url) {
                await db.logAsset(job.user_id, {
                    type: 'image', filename: `job${job.id}_image.png`,
                    path: r.image.url, sourceUrl: r.image.url, publicUrl: r.image.url,
                    executionId: String(job.id), prompt: r.prompt?.imagePrompt || '',
                    metadata: {}, size: 0
                });
            }
            if (r?.video?.url) {
                await db.logAsset(job.user_id, {
                    type: 'video', filename: `job${job.id}_video.mp4`,
                    path: r.video.url, sourceUrl: r.video.url, publicUrl: r.video.url,
                    executionId: String(job.id), prompt: r.prompt?.action || '',
                    metadata: { image_prompt: r.prompt?.imagePrompt }, size: 0
                });
            }
            console.log(`🖼️ Backfilled assets for job ${job.id}`);
        }
    } catch (e) { console.log('Asset backfill skipped:', e.message); }

    // One-time fix: patch Instagram tokens missing user_id in metadata
    try {
        const allUsers = await db.query('SELECT DISTINCT user_id FROM platform_tokens WHERE platform = $1', ['instagram']);
        for (const row of allUsers.rows) {
            const token = await db.getPlatformToken(row.user_id, 'instagram');
            if (token && token.access_token && (!token.metadata?.user_id)) {
                console.log(`🔧 Patching Instagram user_id for user ${row.user_id}...`);
                try {
                    const meResp = await httpsGet(`https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${token.access_token}`);
                    const igUserId = meResp.user_id || meResp.id;
                    if (igUserId) {
                        await db.savePlatformToken(row.user_id, 'instagram', token.access_token, token.refresh_token, token.expires_at, { user_id: String(igUserId) });
                        console.log(`✅ Instagram user_id patched: ${igUserId} (user ${row.user_id})`);
                    }
                } catch (e) { console.log(`⚠️ Instagram user_id patch failed for user ${row.user_id}:`, e.message); }
            }
        }
    } catch (e) { console.log('Instagram token patch skipped:', e.message); }

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 SaaS Platform running on port ${PORT}`);
        console.log(`🔧 Pipeline engine: built-in (queue: ${process.env.REDIS_URL ? 'Redis + BullMQ' : 'in-memory'})`);
        console.log(`🔐 JWT auth enabled`);
        console.log(`💳 Stripe billing: ${stripe ? 'configured' : 'not configured (set STRIPE_SECRET_KEY)'}`);
        console.log('');
    });

    if (httpsServer) {
        httpsServer.listen(HTTPS_PORT, () => {
            console.log(`🔒 HTTPS server running on port ${HTTPS_PORT}`);
        }).on('error', (err) => {
            console.warn(`⚠️  HTTPS server failed to start on port ${HTTPS_PORT}: ${err.message}`);
        });
    }
})();
