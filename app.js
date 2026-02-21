/* ========================================================
   Loki AI Generator
   Dashboard Controller with Creative Director Agent
   ======================================================== */

// ==================== AUTH ====================
function getAuthToken() {
    return localStorage.getItem('saas_token');
}

function getAuthUser() {
    try { return JSON.parse(localStorage.getItem('saas_user') || 'null'); } catch { return null; }
}

function authHeaders() {
    const token = getAuthToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

function requireLogin() {
    if (!getAuthToken()) {
        window.location.href = '/login';
        return false;
    }
    return true;
}

function logout() {
    localStorage.removeItem('saas_token');
    localStorage.removeItem('saas_user');
    window.location.href = '/login';
}

async function refreshUserProfile() {
    try {
        const res = await fetch('/auth/me', { headers: authHeaders() });
        if (res.status === 401) { logout(); return null; }
        if (!res.ok) return null;
        const user = await res.json();
        localStorage.setItem('saas_user', JSON.stringify(user));
        updateUserDisplay(user);
        return user;
    } catch { return null; }
}

function updateUserDisplay(user) {
    if (!user) return;
    const nameEl = document.getElementById('userDisplayName');
    const planEl = document.getElementById('userPlanBadge');
    const runsEl = document.getElementById('userRunsDisplay');
    const emailEl = document.getElementById('userDropdownEmail');
    if (nameEl) nameEl.textContent = user.name || user.email.split('@')[0];
    if (planEl) {
        planEl.textContent = (user.plan || 'starter').charAt(0).toUpperCase() + (user.plan || 'starter').slice(1);
        planEl.className = 'user-plan-badge plan-' + (user.plan || 'starter');
    }
    if (runsEl) runsEl.textContent = `${user.runs_used}/${user.runs_limit} runs`;
    if (emailEl) emailEl.textContent = user.email || '';
}

// Auto-inject auth header on all same-origin fetch calls
const _originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
    if (typeof url === 'string' && url.startsWith('/')) {
        options.headers = { ...authHeaders(), ...(options.headers || {}) };
    }
    return _originalFetch.call(this, url, options);
};

// Pipeline engine — no external workflow dependency

// --- Social Platform Definitions ---
const PLATFORMS = {
    youtube: { name: 'YouTube Shorts', color: '#FF0000' },
    instagram: { name: 'Instagram', color: '#E4405F' },
    facebook: { name: 'Facebook', color: '#1877F2' },
    twitter: { name: 'X (Twitter)', color: '#1DA1F2' },
    tiktok: { name: 'TikTok', color: '#00F2EA' }
};

// --- Default Agent System Prompt ---
const DEFAULT_AGENT_PROMPT = `You are an expert prompt creator which follows instructions very well but very carefully ensuring and double checking you're not messing up.

You will be given:
- Base Prompt (the core character description)
- A Scene (setting/background for the image)
- An Action (what the character is doing)
- Variations (hair color, background ethnicity, skin tone, eye color, hair type)

Your job is to ALTER the base prompt to incorporate the new scene, action, and variations while keeping the visual intent the same.

CRITICAL — MULTIPLE CHARACTERS MUST LOOK DIFFERENT:
If the base prompt describes two or more characters (e.g. "one swedish girl... and one irish girl"), you MUST keep them visually distinct:
- The provided Variations apply to ONLY ONE of the characters (pick one randomly). The OTHER character(s) MUST keep their original appearance from the base prompt.
- Never give both characters the same hair color, eye color, or skin tone. Each character must have clearly different features.
- Describe each character separately in the prompt — e.g. "first woman with [X hair, Y eyes, Z skin], second woman with [A hair, B eyes, C skin]" — so the image generator treats them as distinct people.
- If the base prompt already specifies distinct features for each character (e.g. "silver hair pale skin" vs "blond hair golden tan"), preserve those differences. Only apply the Variations to one of them.

CRITICAL — ACTION IS FOR VIDEO, NOT IMAGE:
The Action field describes what happens in the VIDEO (slow motion, camera movement, cinematic shots, etc.). For the IMAGE prompt:
- Extract only the physical action (e.g. "riding horses", "walking", "posing") — what the characters are physically doing.
- Do NOT include video/motion terms like: slow motion, cinematic, camera movement, heavy breathing, jiggle, bounce, gallop motion, dynamic movement.
- The image is a STILL photograph. Describe a frozen moment, not motion.

Keep the clothing, outfit, and body descriptions EXACTLY as written in the base prompt — do not tone down, censor, or rephrase them. Preserve every detail about what the characters are wearing and how they look.

Keep outfit details (viking style, armor, emeralds, etc) intact. Keep scene and action details intact.

Only output the final merged prompt — no quotation marks, no explanations, no JSON wrapping, no markdown.

Ensure that no iphone should actually be visible.`;

const DEFAULT_APPROVAL_MSG = 'above is the video generated upon your request Brandon. Please Approve, Reject or Cancel';

// --- Creative Director Config (loaded from server) ---
let cdConfig = {
    character_description: '',
    prompts: [],
    actions: [],
    scenes: [],
    variations: {},
    content_rules: '',
    reference_image_url: '',
    music: [],
    caption_template: ''
};

// ==================== HELPERS ====================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function showToast(message, type = 'info') {
    const container = $('#toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 250); }, 3500);
}

async function apiFetch(endpoint, options = {}) {
    try {
        const res = await fetch(endpoint, {
            headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options.headers },
            ...options,
        });
        if (res.status === 401) {
            logout();
            return null;
        }
        if (!res.ok) {
            let errMsg = `HTTP ${res.status}`;
            try { const body = await res.json(); if (body.message || body.error) errMsg = body.message || body.error; } catch {}
            const err = new Error(errMsg);
            err.status = res.status;
            throw err;
        }
        return await res.json();
    } catch (err) {
        console.error('API error:', err);
        // Return error info so callers can show meaningful messages
        return { _error: true, message: err.message || 'Network error' };
    }
}

// Authenticated fetch for our own endpoints (non-n8n)
async function authFetch(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options.headers },
        ...options,
    });
    if (res.status === 401) { logout(); return null; }
    return res;
}

function formatDuration(ms) {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const diff = Date.now() - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getNextScheduledRun() {
    const times = Array.from($$('.input-time')).map(el => el.value);
    const now = new Date();
    const currentMin = now.getHours() * 60 + now.getMinutes();
    let closest = Infinity;
    for (const t of times) {
        const [h, m] = t.split(':').map(Number);
        let diff = (h * 60 + m) - currentMin;
        if (diff <= 0) diff += 1440;
        if (diff < closest) closest = diff;
    }
    if (closest < 60) return `${closest}m`;
    return `${Math.floor(closest / 60)}h ${closest % 60}m`;
}

// ==================== STATE ====================
let state = {
    agentPrompt: localStorage.getItem('n8n_agent_prompt') || DEFAULT_AGENT_PROMPT,
    llmProvider: localStorage.getItem('n8n_llm_provider') || 'gemini',
    workflowActive: false,
    platforms: JSON.parse(localStorage.getItem('n8n_platforms') || 'null') || {
        youtube: { connected: false, enabled: false },
        instagram: { connected: false, enabled: false },
        facebook: { connected: false, enabled: false },
        twitter: { connected: false, enabled: false },
        tiktok: { connected: false, enabled: false }
    },
    settings: JSON.parse(localStorage.getItem('n8n_settings') || 'null') || {
        videoModel: 'kling-2.6/image-to-video',
        videoDuration: '5',
        videoResolution: '1080p',
        imageModel: 'nano-banana-pro',
        aspectRatio: '9:16',
        imageResolution: '1K',
        telegramChatId: '7700134015',
        approvalMessage: DEFAULT_APPROVAL_MSG,
        schedule: ['06:00', '09:00', '12:00', '18:00', '21:00', '00:00']
    }
};

function saveState() {
    localStorage.setItem('n8n_agent_prompt', state.agentPrompt);
    localStorage.setItem('n8n_settings', JSON.stringify(state.settings));
    localStorage.setItem('n8n_platforms', JSON.stringify(state.platforms));
}

// ==================== CINEMATIC BACKGROUND ====================
function initCinematicBackground() {
    const canvas = document.getElementById('bgCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h, particles, orbs, mouseX = -1000, mouseY = -1000;

    function resize() {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Track mouse for particle interaction
    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    // Particle starfield (3 depth layers)
    function seededRandom(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    particles = Array.from({ length: 180 }, (_, i) => ({
        x: Math.random() * 2000,
        y: Math.random() * 2000,
        z: Math.random() * 3, // depth layer: 0=far, 2=close
        size: 0.5 + Math.random() * 1.5,
        speed: 0.1 + Math.random() * 0.3,
        opacity: 0.15 + Math.random() * 0.35,
        angle: Math.random() * Math.PI * 2,
    }));

    // Cinematic orbs (ported from CinematicOrbs.tsx)
    const orbColors = [
        'rgba(198, 166, 100, 0.04)',   // gold
        'rgba(229, 201, 141, 0.03)',   // light gold
        'rgba(2, 75, 85, 0.05)',       // teal
        'rgba(198, 166, 100, 0.025)',  // gold dim
        'rgba(99, 102, 241, 0.03)',    // indigo
    ];

    orbs = Array.from({ length: 5 }, (_, i) => ({
        x: seededRandom(77 + i * 17) * 80 + 10,
        y: seededRandom(77 + i * 23) * 80 + 10,
        size: 200 + seededRandom(77 + i * 31) * 350,
        color: orbColors[i % orbColors.length],
        speed: 0.2 + seededRandom(77 + i * 41) * 0.4,
        phase: seededRandom(77 + i * 53) * Math.PI * 2,
    }));

    let lastTime = 0;
    function animate(timestamp) {
        const dt = (timestamp - lastTime) / 1000;
        lastTime = timestamp;
        const time = timestamp / 1000;

        ctx.clearRect(0, 0, w, h);

        // Draw orbs
        orbs.forEach(orb => {
            const xOffset = Math.sin(time * orb.speed + orb.phase) * 30;
            const yOffset = Math.cos(time * orb.speed * 0.7 + orb.phase) * 20;
            const scaleBreath = 0.85 + (Math.sin(time * orb.speed * 0.5 + orb.phase) + 1) * 0.15;
            const ox = (orb.x + xOffset) / 100 * w;
            const oy = (orb.y + yOffset) / 100 * h;
            const os = orb.size * scaleBreath;

            const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, os);
            grad.addColorStop(0, orb.color);
            grad.addColorStop(0.7, 'transparent');
            ctx.fillStyle = grad;
            ctx.fillRect(ox - os, oy - os, os * 2, os * 2);
        });

        // Draw particles
        particles.forEach(p => {
            const parallax = 0.3 + p.z * 0.35;
            p.x += Math.cos(p.angle) * p.speed * parallax;
            p.y += Math.sin(p.angle) * p.speed * parallax;

            // Wrap around
            if (p.x < -10) p.x = w + 10;
            if (p.x > w + 10) p.x = -10;
            if (p.y < -10) p.y = h + 10;
            if (p.y > h + 10) p.y = -10;

            // Mouse repulsion
            const dx = p.x - mouseX;
            const dy = p.y - mouseY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 120) {
                const force = (120 - dist) / 120 * 2;
                p.x += (dx / dist) * force;
                p.y += (dy / dist) * force;
            }

            const sz = p.size * (0.5 + p.z * 0.3);
            ctx.beginPath();
            ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(198, 166, 100, ${p.opacity * (0.3 + p.z * 0.3)})`;
            ctx.fill();
        });

        // Draw connection lines between nearby particles
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 100) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(198, 166, 100, ${0.03 * (1 - dist / 100)})`;
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                }
            }
        }

        requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

// ==================== 3D CARD TILT ====================
function initCardTilt() {
    const cards = document.querySelectorAll('.stat-card, .social-card, .asset-card');
    cards.forEach(card => {
        card.classList.add('card-3d');
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const rotateY = ((x - centerX) / centerX) * 5;
            const rotateX = ((centerY - y) / centerY) * 5;
            card.style.transform = `perspective(1200px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-2px)`;
        });
        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
        });
    });
}

// ==================== SCROLL REVEAL ====================
function initScrollReveal() {
    const reveals = document.querySelectorAll('.reveal-up, .reveal-scale, .reveal-left, .reveal-right');
    if (!reveals.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('revealed');
                observer.unobserve(entry.target);

                // Auto-stagger grid children
                const gridChildren = entry.target.querySelectorAll('.stat-card, .social-card, .pipeline-stage');
                gridChildren.forEach((child, i) => {
                    child.classList.add(`stagger-${Math.min(i + 1, 6)}`);
                    child.classList.add('reveal-scale');
                    requestAnimationFrame(() => {
                        child.classList.add('revealed');
                    });
                });
            }
        });
    }, { threshold: 0.15 });

    reveals.forEach(el => observer.observe(el));
}

// ==================== STAT COUNTERS ====================
function initStatCounters() {
    const counters = ['totalExecutions', 'successCount', 'failedCount'];
    // Store original updateExecutions to intercept value changes
    const origInnerHTML = {};
    counters.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach(m => {
                    const text = el.textContent;
                    const num = parseInt(text);
                    if (!isNaN(num) && num > 0 && !el.dataset.counted) {
                        el.dataset.counted = 'true';
                        animateCounter(el, 0, num, 1500);
                    }
                });
            });
            observer.observe(el, { childList: true, characterData: true, subtree: true });
        }
    });
}

function animateCounter(el, start, end, duration) {
    const startTime = performance.now();
    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out quad
        const eased = 1 - (1 - progress) * (1 - progress);
        const current = Math.round(start + (end - start) * eased);
        el.textContent = current;
        if (progress < 1) {
            requestAnimationFrame(step);
        } else {
            el.textContent = end;
        }
    }
    requestAnimationFrame(step);
}

// ==================== BUTTON RIPPLE ====================
function initButtonRipple() {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn');
        if (!btn) return;

        const rect = btn.getBoundingClientRect();
        const ripple = document.createElement('span');
        ripple.className = 'btn-ripple';
        const size = Math.max(rect.width, rect.height);
        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
        ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
        btn.appendChild(ripple);
        ripple.addEventListener('animationend', () => ripple.remove());
    });
}

// ==================== TOP TAB NAVIGATION ====================
function switchTab(tabName) {
    // Deactivate all tabs and pages
    document.querySelectorAll('.top-nav-tab').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-page').forEach(page => page.classList.remove('active'));

    // Update header breadcrumb
    const breadcrumbMap = {
        'command-center': 'Command Center \u203A Studio',
        'social': 'Social \u203A Connections',
        'config': 'Config \u203A Settings',
        'assets': 'Assets \u203A Library',
        'workflows': 'Workflows \u203A Editor'
    };
    const breadcrumb = document.getElementById('headerBreadcrumb');
    if (breadcrumb) breadcrumb.textContent = breadcrumbMap[tabName] || tabName;

    // Activate selected tab and page
    const tab = document.querySelector(`.top-nav-tab[data-tab="${tabName}"]`);
    const page = document.querySelector(`.tab-page[data-page="${tabName}"]`);
    if (tab) tab.classList.add('active');
    if (page) {
        page.classList.add('active');

        // Force reveal animations on elements that were already observed
        // (IntersectionObserver unobserves after first reveal, but elements
        // inside hidden pages may never have been visible)
        page.querySelectorAll('.reveal-up, .reveal-scale, .reveal-left, .reveal-right').forEach(el => {
            el.classList.add('revealed');
        });

        // Also stagger grid children that may not have animated
        page.querySelectorAll('.stat-card, .social-card, .pipeline-stage').forEach((child, i) => {
            if (!child.classList.contains('revealed')) {
                child.classList.add(`stagger-${Math.min(i + 1, 6)}`);
                child.classList.add('reveal-scale');
                requestAnimationFrame(() => child.classList.add('revealed'));
            }
        });
    }

    // Lazy-init workflow editor when first switching to workflows tab
    if (tabName === 'workflows' && typeof WorkflowEditor !== 'undefined' && !WorkflowEditor.initialized) {
        WorkflowEditor.init();
    }

    // Scroll to top of main content
    const main = document.querySelector('.main');
    if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initTopNav() {
    // Default to command-center tab (already set via HTML class="active")
    const activePage = document.querySelector('.tab-page.active');
    if (activePage) {
        activePage.querySelectorAll('.reveal-up, .reveal-scale, .reveal-left, .reveal-right').forEach(el => {
            // These will be handled by the existing IntersectionObserver
            // since they're visible on load
        });
    }
}

// ==================== INIT ====================
function initFullDashboard() {
    const safeInit = (fn, name) => {
        try { fn(); } catch (e) { console.warn(`[init] ${name} failed:`, e); }
    };

    safeInit(initTopNav, 'top-nav');
    safeInit(initCinematicBackground, 'cinematic-bg');
    safeInit(initScrollReveal, 'scroll-reveal');
    safeInit(initStatCounters, 'stat-counters');
    safeInit(initButtonRipple, 'button-ripple');
    safeInit(initAgentPrompt, 'agent-prompt');
    safeInit(loadAgentConfig, 'agent-config');
    safeInit(initSettings, 'settings');
    safeInit(initSchedule, 'schedule');
    safeInit(initSocialMedia, 'social-media');
    safeInit(initEventListeners, 'event-listeners');
    safeInit(loadPipelineStatus, 'pipeline-status');
    safeInit(loadExecutions, 'executions');
    safeInit(loadSocialStatus, 'social-status');
    safeInit(updateNextRun, 'next-run');
    safeInit(initPipeline, 'pipeline');
    safeInit(enhanceTriggerButton, 'trigger-button');
    safeInit(loadMotionLibrary, 'motion-library');
    safeInit(loadAssets, 'assets');
    safeInit(loadCharacterCards, 'character-cards');
    safeInit(initMotionRefUpload, 'motion-ref-upload');
    safeInit(initLLMProviderToggle, 'llm-provider');
    safeInit(loadScheduleFromServer, 'load-schedule');
    safeInit(initBillingUI, 'billing-ui');
    safeInit(initSocialStrip, 'social-strip');
    safeInit(initSectionCollapse, 'section-collapse');
    safeInit(initQuickSettings, 'quick-settings');
    safeInit(initWorkspaceLayout, 'workspace-layout');
    safeInit(loadSavedLooks, 'saved-looks');
    safeInit(loadCalendar, 'calendar');

    setTimeout(initCardTilt, 500);

    setInterval(() => {
        loadPipelineStatus();
        loadExecutions();
        updateNextRun();
    }, 30000);
}

document.addEventListener('DOMContentLoaded', async () => {
    // Auth gate: redirect to login if no token
    if (!requireLogin()) return;

    // Show user info in header
    const user = getAuthUser();
    if (user) updateUserDisplay(user);

    // Refresh profile from server and check onboarding
    const profile = await refreshUserProfile();
    if (profile && !profile.onboarding_completed) {
        showOnboarding();
        return; // Don't init dashboard yet
    }

    initFullDashboard();
});

// ==================== CREATIVE DIRECTOR AGENT ====================
function initAgentPrompt() {
    const editor = $('#agentSystemPrompt');
    if (!editor) return;
    editor.value = state.agentPrompt;
    updateAgentCharCount();
    editor.addEventListener('input', () => {
        state.agentPrompt = editor.value;
        updateAgentCharCount();
    });
}

function updateAgentCharCount() {
    const editor = $('#agentSystemPrompt');
    const counter = $('#agentCharCount');
    if (!editor || !counter) return;
    counter.textContent = `${editor.value.length} characters`;
}

function resetAgentPrompt() {
    if (confirm('Reset agent prompt to default? This will not save until you click "Save to Workflow".')) {
        $('#agentSystemPrompt').value = DEFAULT_AGENT_PROMPT;
        state.agentPrompt = DEFAULT_AGENT_PROMPT;
        updateAgentCharCount();
        showToast('Agent prompt reset to default', 'info');
    }
}

async function saveAgentPrompt() {
    state.agentPrompt = $('#agentSystemPrompt').value;
    saveState();
    showToast('Agent prompt saved locally', 'success');
}

async function testAgentPrompt() {
    const btn = $('#testAgentBtn');
    const box = $('#agentOutputBox');

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner-sm"></div> Generating...';
    box.innerHTML = '<div class="agent-output-loading"><div class="spinner"></div><span>Claude is generating content...</span></div>';

    try {
        // Use the server to proxy a test to Claude
        const res = await fetch('/v1/test-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: state.agentPrompt, llmProvider: state.llmProvider })
        });

        if (res.ok) {
            const data = await res.json();
            renderAgentOutput(data);
        } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.error || 'Test generation failed', 'error');
            box.innerHTML = '<div class="agent-output-loading"><span>Generation failed — check API keys</span></div>';
        }
    } catch (err) {
        showToast('Could not reach server', 'error');
        box.innerHTML = '<div class="agent-output-loading"><span>Server unreachable</span></div>';
    }

    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Test Generate';
}

function renderAgentOutput(data) {
    const box = $('#agentOutputBox');
    box.innerHTML = `
        <div class="agent-output-result">
            <div class="agent-output-field">
                <span class="agent-field-label">🎬 Scene</span>
                <span class="agent-field-value">${escapeHtml(data.Prompt || data.prompt || '')}</span>
            </div>
            <div class="agent-output-field">
                <span class="agent-field-label">🏃 Action</span>
                <span class="agent-field-value">${escapeHtml(data.Action || data.action || '')}</span>
            </div>
            <div class="agent-output-field">
                <span class="agent-field-label">👗 Outfit</span>
                <span class="agent-field-value">${escapeHtml(data.OutfitNote || data.outfitNote || '')}</span>
            </div>
        </div>
    `;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==================== CREATIVE DIRECTOR CONFIG ====================
let activeConfigIndex = 0;

async function loadAgentConfig() {
    try {
        const res = await fetch('/agent-config');
        if (res.ok) {
            cdConfig = await res.json();
            renderCreativeDirector();
        } else {
            showToast('Failed to load agent config', 'error');
        }
        await loadConfigTabs();
    } catch (e) {
        console.error('Load agent config:', e);
        showToast('Could not connect to server for config', 'error');
    }
}

async function loadConfigTabs() {
    try {
        const res = await fetch('/agent-config/list');
        if (!res.ok) return;
        const { activeConfig, configs } = await res.json();
        activeConfigIndex = activeConfig;
        const container = $('#cdTabs');
        if (!container) return;
        container.innerHTML = configs.map(c => `
            <button class="cd-tab${c.index === activeConfig ? ' active' : ''}" data-idx="${c.index}">
                <span class="cd-tab-name">${escapeHtml(c.name)}</span>
            </button>
        `).join('');
        // Click to switch
        container.querySelectorAll('.cd-tab').forEach(btn => {
            btn.addEventListener('click', () => switchConfigTab(parseInt(btn.dataset.idx)));
            btn.addEventListener('dblclick', (e) => {
                e.preventDefault();
                startTabRename(btn);
            });
        });
    } catch (e) {
        console.error('Load config tabs:', e);
    }
}

async function switchConfigTab(index) {
    if (index === activeConfigIndex) return;
    // Save current config first
    await saveAgentConfig();
    try {
        const res = await fetch('/agent-config/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index })
        });
        if (res.ok) {
            cdConfig = await res.json();
            activeConfigIndex = index;
            renderCreativeDirector();
            // Update tab active state
            $$('.cd-tab').forEach(t => t.classList.toggle('active', parseInt(t.dataset.idx) === index));
        }
    } catch (e) {
        showToast('Failed to switch config tab', 'error');
    }
}

function startTabRename(btn) {
    const nameSpan = btn.querySelector('.cd-tab-name');
    const currentName = nameSpan.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cd-tab-rename-input';
    input.value = currentName;
    input.maxLength = 24;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const finish = async () => {
        const newName = input.value.trim() || currentName;
        const span = document.createElement('span');
        span.className = 'cd-tab-name';
        span.textContent = newName;
        input.replaceWith(span);
        if (newName !== currentName) {
            await fetch('/agent-config/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: parseInt(btn.dataset.idx), name: newName })
            });
        }
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    });
}

let cdListenersAttached = false;

function renderCreativeDirector() {
    // Character description
    const descEl = $('#cdCharacterDesc');
    descEl.value = cdConfig.character_description || '';
    updateCdCharCount();

    // Content rules
    const rulesEl = $('#cdContentRules');
    rulesEl.value = cdConfig.content_rules || '';

    // Reference character dropdown
    populateCdCharacterDropdown();
    // Restore selection from config
    const sel = $('#cdRefCharacterSelect');
    if (sel && cdConfig.reference_image_url) {
        // Try to match a card by its thumbnail_url or referenceImageUrl
        let matched = false;
        for (const opt of sel.options) {
            if (opt.dataset.imageUrl === cdConfig.reference_image_url) {
                sel.value = opt.value;
                matched = true;
                break;
            }
        }
        if (!matched) sel.value = '';
    }
    const preview = $('#cdRefImagePreview');
    if (preview) preview.src = cdConfig.reference_image_url || '';

    // Attach input listeners only once
    if (!cdListenersAttached) {
        descEl.addEventListener('input', () => {
            cdConfig.character_description = descEl.value;
            updateCdCharCount();
        });
        rulesEl.addEventListener('input', () => { cdConfig.content_rules = rulesEl.value; });
        const captionEl = $('#cdCaptionTemplate');
        if (captionEl) {
            captionEl.addEventListener('input', () => { cdConfig.caption_template = captionEl.value; });
        }
        cdListenersAttached = true;
    }

    // Prompts list
    renderCdList('prompts');
    // Actions list
    renderCdList('actions');
    // Scenes list
    renderCdList('scenes');
    // Variations
    renderVariations();

    // Music pool
    renderMusicPool();

    // Caption template
    const captionEl = $('#cdCaptionTemplate');
    if (captionEl) {
        captionEl.value = cdConfig.caption_template || '';
    }
}

function updateCdCharCount() {
    const el = $('#cdCharCount');
    if (el) el.textContent = `${($('#cdCharacterDesc').value || '').length} characters`;
}

function populateCdCharacterDropdown() {
    const sel = $('#cdRefCharacterSelect');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">-- Select a character --</option>';
    (iphoneState.cards || []).forEach(card => {
        const imgUrl = card.thumbnail_url || card.character_data?.referenceImageUrl || '';
        const opt = document.createElement('option');
        opt.value = card.id;
        opt.textContent = card.name + (card.category ? ` (${card.category})` : '');
        opt.dataset.imageUrl = imgUrl;
        sel.appendChild(opt);
    });
    if (current) sel.value = current;
}

function onCdCharacterSelected() {
    const sel = $('#cdRefCharacterSelect');
    const selectedOpt = sel.options[sel.selectedIndex];
    const imageUrl = selectedOpt?.dataset?.imageUrl || '';
    const preview = $('#cdRefImagePreview');
    if (preview) preview.src = imageUrl;
    cdConfig.reference_image_url = imageUrl;
}

function renderCdList(type) {
    const containerMap = { actions: '#cdActionsList', scenes: '#cdScenesList', prompts: '#cdPromptsList' };
    const container = $(containerMap[type]);
    if (!container) return;
    const items = cdConfig[type] || [];
    const isPrompts = type === 'prompts';
    container.innerHTML = items.map((item, idx) => `
        <div class="cd-list-item ${isPrompts ? 'cd-list-item-tall' : ''}" data-idx="${idx}">
            <span class="cd-list-num">${idx + 1}</span>
            ${isPrompts
                ? `<textarea class="cd-prompt-textarea" oninput="updateCdItem('${type}', ${idx}, this.value)">${escapeHtml(item.text || '')}</textarea>`
                : `<input type="text" value="${escapeHtml(item.text || '')}" oninput="updateCdItem('${type}', ${idx}, this.value)">`
            }
            <button class="cd-delete-btn" onclick="removeCdItem('${type}', ${idx})" title="Remove">✕</button>
        </div>
    `).join('');
}

function addCdItem(type) {
    const items = cdConfig[type] || [];
    const nextId = items.length > 0 ? Math.max(...items.map(i => i.id || 0)) + 1 : 1;
    items.push({ id: nextId, text: '' });
    cdConfig[type] = items;
    renderCdList(type);
    // Focus the new input
    const containerMap = { actions: '#cdActionsList', scenes: '#cdScenesList', prompts: '#cdPromptsList' };
    const container = $(containerMap[type]);
    const inputs = container.querySelectorAll('input, textarea');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
}

function removeCdItem(type, idx) {
    cdConfig[type].splice(idx, 1);
    renderCdList(type);
}

function updateCdItem(type, idx, value) {
    if (cdConfig[type][idx]) {
        cdConfig[type][idx].text = value;
    }
}

function renderVariations() {
    const container = $('#cdVariations');
    if (!container) return;
    const vars = cdConfig.variations || {};
    const categories = [
        { key: 'hair', label: 'Hair Color' },
        { key: 'background', label: 'Background / Ethnicity' },
        { key: 'skin_tone', label: 'Skin Tone' },
        { key: 'eye_color', label: 'Eye Color' },
        { key: 'hair_type', label: 'Hair Type' }
    ];
    container.innerHTML = categories.map(cat => `
        <div class="cd-variation-row">
            <label class="cd-variation-label">${cat.label}</label>
            <input type="text" class="cd-variation-input" id="var-${cat.key}"
                value="${escapeHtml((vars[cat.key] || []).join(', '))}"
                oninput="updateVariation('${cat.key}', this.value)"
                placeholder="Comma-separated values...">
        </div>
    `).join('');
}

function updateVariation(key, value) {
    if (!cdConfig.variations) cdConfig.variations = {};
    cdConfig.variations[key] = value.split(',').map(v => v.trim()).filter(v => v);
}

async function saveAgentConfig() {
    // Collect from UI into cdConfig
    cdConfig.character_description = $('#cdCharacterDesc').value;
    cdConfig.content_rules = $('#cdContentRules').value;
    const cdSel = $('#cdRefCharacterSelect');
    if (cdSel) {
        const opt = cdSel.options[cdSel.selectedIndex];
        cdConfig.reference_image_url = opt?.dataset?.imageUrl || '';
    }
    cdConfig.caption_template = $('#cdCaptionTemplate')?.value || cdConfig.caption_template;
    // music array is already kept in sync by pin/delete/upload handlers
    // Collect variations from inputs
    const varKeys = ['hair', 'background', 'skin_tone', 'eye_color', 'hair_type'];
    varKeys.forEach(key => {
        const el = $(`#var-${key}`);
        if (el) {
            if (!cdConfig.variations) cdConfig.variations = {};
            cdConfig.variations[key] = el.value.split(',').map(v => v.trim()).filter(v => v);
        }
    });

    const statusEl = $('#cdSaveStatus');
    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--accent-amber)';

    try {
        const res = await fetch('/agent-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cdConfig)
        });
        if (res.ok) {
            statusEl.textContent = 'Saved!';
            statusEl.style.color = 'var(--accent-emerald)';
            showToast('Creative Director config saved!', 'success');
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        } else {
            throw new Error('Save failed');
        }
    } catch (e) {
        statusEl.textContent = 'Save failed';
        statusEl.style.color = 'var(--accent-red)';
        showToast('Failed to save config: ' + e.message, 'error');
    }
}

// ==================== SETTINGS ====================
function initSettings() {
    const s = state.settings;
    $('#videoModel').value = s.videoModel;
    $('#videoDuration').value = s.videoDuration;
    $('#videoResolution').value = s.videoResolution;
    $('#imageModel').value = s.imageModel;
    const refToggle = $('#useReferenceImage');
    const refToggle2 = $('#useReferenceImage2');
    const syncRef = (source, target) => { if (target) target.checked = source.checked; };
    if (refToggle) {
        refToggle.checked = s.useReferenceImage !== false;
        refToggle.addEventListener('change', () => syncRef(refToggle, refToggle2));
    }
    if (refToggle2) {
        refToggle2.checked = s.useReferenceImage !== false;
        refToggle2.addEventListener('change', () => syncRef(refToggle2, refToggle));
    }
    $('#aspectRatio').value = s.aspectRatio;
    $('#imageResolution').value = s.imageResolution;
    $('#telegramChatId').value = s.telegramChatId;
    $('#approvalMessage').value = s.approvalMessage;
}

// Settings are stored locally — no workflow to fetch from
function loadWorkflowSettings() {
    const s = state.settings;
    const detailEl = $('#detail-video-gen');
    if (detailEl) {
        if (s.videoModel.startsWith('kling')) detailEl.textContent = 'Kling 2.6';
        else if (s.videoModel.startsWith('wan')) detailEl.textContent = 'Wan 2.6';
        else detailEl.textContent = s.videoModel;
    }
}

function collectSettings() {
    const s = state.settings;
    s.videoModel = $('#videoModel').value;
    s.videoDuration = $('#videoDuration').value;
    s.videoResolution = $('#videoResolution').value;
    s.imageModel = $('#imageModel').value;
    s.useReferenceImage = $('#useReferenceImage')?.checked ?? true;
    s.aspectRatio = $('#aspectRatio').value;
    s.imageResolution = $('#imageResolution').value;
    s.telegramChatId = $('#telegramChatId').value;
    s.approvalMessage = $('#approvalMessage').value;
}

// ==================== CREDENTIALS (handled via pipeline engine) ====================

// ==================== SCHEDULE ====================
function initSchedule() {
    const times = $$('.input-time');
    state.settings.schedule.forEach((t, i) => { if (times[i]) times[i].value = t; });
    times.forEach((input, i) => { input.addEventListener('change', () => { state.settings.schedule[i] = input.value; }); });
}
function updateNextRun() { $('#nextRun').textContent = getNextScheduledRun(); }

async function loadScheduleFromServer() {
    try {
        const res = await fetch('/v1/schedule');
        if (!res.ok) return;
        const data = await res.json();
        if (data.cron_times) {
            state.settings.schedule = data.cron_times;
            const times = $$('.input-time');
            data.cron_times.forEach((t, i) => { if (times[i]) times[i].value = t; });
            updateNextRun();
        }
    } catch (e) { console.log('Schedule load:', e.message); }
}

// ==================== PIPELINE STATUS ====================
async function loadPipelineStatus() {
    const badge = $('#workflowStatus');
    try {
        const data = await apiFetch('/v1/pipeline/stats');
        if (data) {
            const active = data.active > 0;
            state.workflowActive = true; // Pipeline engine is always available
            badge.className = `status-badge ${active ? '' : ''}`;
            badge.querySelector('.status-text').textContent = active ? `${data.active} Running` : 'Ready';
        }
    } catch {
        badge.className = 'status-badge';
        badge.querySelector('.status-text').textContent = 'Ready';
    }
}

// ==================== EXECUTIONS ====================
async function loadExecutions() {
    const data = await apiFetch('/v1/pipeline/history');
    const tbody = $('#execTableBody');
    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No executions yet</td></tr>';
        $('#totalExecutions').textContent = '0';
        $('#successCount').textContent = '0';
        $('#failedCount').textContent = '0';
        return;
    }
    let sC = 0, fC = 0;
    tbody.innerHTML = data.map(e => {
        const st = e.status === 'completed' ? 'success' : (e.status === 'failed' ? 'error' : e.status);
        if (st === 'success') sC++;
        if (st === 'error') fC++;
        const dur = e.completedAt && e.createdAt ? new Date(e.completedAt) - new Date(e.createdAt) : null;
        return `<tr>
      <td style="font-family:var(--font-mono);font-size:.75rem;color:var(--text-tertiary)">#${e.id}</td>
      <td><span class="status-pill ${st}">${st}</span></td>
      <td>${formatDate(e.createdAt)}</td>
      <td style="font-family:var(--font-mono)">${formatDuration(dur)}</td>
      <td>${e.currentPhase || '—'}</td>
    </tr>`;
    }).join('');
    $('#totalExecutions').textContent = data.length;
    $('#successCount').textContent = sC;
    $('#failedCount').textContent = fC;
}

// ==================== SOCIAL MEDIA ====================
function initSocialMedia() {
    for (const [platform, config] of Object.entries(state.platforms)) {
        const toggle = $(`#toggle-${platform}`);
        const card = $(`#social-${platform}`);
        const statusEl = $(`#status-${platform}`);
        const connectBtn = $(`#connect-${platform}`);

        if (config.connected) {
            card.classList.add('connected');
            statusEl.textContent = 'Connected';
            statusEl.className = 'social-status status-connected';
            toggle.disabled = false;
            toggle.checked = config.enabled;
            connectBtn.innerHTML = '<span class="connect-icon">✓</span> Connected';
            connectBtn.className = 'social-connect-btn btn-connected';

            // Add disconnect button
            if (!$(`#disconnect-${platform}`)) {
                const disconnectBtn = document.createElement('button');
                disconnectBtn.id = `disconnect-${platform}`;
                disconnectBtn.className = 'social-connect-btn btn-disconnect';
                disconnectBtn.innerHTML = '<span class="connect-icon">✕</span> Disconnect';
                disconnectBtn.onclick = () => disconnectPlatform(platform);
                connectBtn.parentElement.appendChild(disconnectBtn);
            }
        }

        toggle.addEventListener('change', async () => {
            state.platforms[platform].enabled = toggle.checked;
            saveState();
            showToast(`${PLATFORMS[platform].name} posting ${toggle.checked ? 'enabled' : 'disabled'}`, 'info');

            // Persist enabledPlatforms to server/DB so the scheduler can read them
            const enabledPlatforms = Object.entries(state.platforms)
                .filter(([_, v]) => v.connected && v.enabled)
                .map(([k]) => k);
            apiFetch('/agent-config', {
                method: 'POST',
                body: JSON.stringify({ enabledPlatforms })
            });
        });
    }
}

async function loadSocialStatus() {
    try {
        let socialUrl = '/social/status';
        if (activeSocialCharacterId) socialUrl += `?characterCardId=${activeSocialCharacterId}`;
        const res = await fetch(socialUrl);
        if (!res.ok) return;
        const data = await res.json();

        for (const [platform, info] of Object.entries(data)) {
            const card = $(`#social-${platform}`);
            const statusEl = $(`#status-${platform}`);
            const toggle = $(`#toggle-${platform}`);
            const connectBtn = $(`#connect-${platform}`);
            if (!card || !statusEl || !toggle || !connectBtn) continue;

            if (info.connected) {
                state.platforms[platform].connected = true;
                card.classList.add('connected');
                statusEl.textContent = 'Connected';
                statusEl.className = 'social-status status-connected';
                toggle.disabled = false;
                connectBtn.innerHTML = '<span class="connect-icon">✓</span> Connected';
                connectBtn.className = 'social-connect-btn btn-connected';

                if (state.platforms[platform].enabled) {
                    toggle.checked = true;
                }

                // Add disconnect button
                if (!$(`#disconnect-${platform}`)) {
                    const disconnectBtn = document.createElement('button');
                    disconnectBtn.id = `disconnect-${platform}`;
                    disconnectBtn.className = 'social-connect-btn btn-disconnect';
                    disconnectBtn.innerHTML = '<span class="connect-icon">✕</span> Disconnect';
                    disconnectBtn.onclick = () => disconnectPlatform(platform);
                    connectBtn.parentElement.appendChild(disconnectBtn);
                }
            } else {
                // Token missing from DB — reset to disconnected so user can re-auth
                state.platforms[platform].connected = false;
                card.classList.remove('connected');
                statusEl.textContent = 'Not Connected';
                statusEl.className = 'social-status';
                toggle.disabled = true;
                toggle.checked = false;
                connectBtn.innerHTML = '<span class="connect-icon">🔗</span> Connect';
                connectBtn.className = 'social-connect-btn';
                const existingDisconnect = $(`#disconnect-${platform}`);
                if (existingDisconnect) existingDisconnect.remove();
            }
        }
        saveState();
    } catch (e) {
        console.log('Social status check:', e.message);
    }
}

async function connectPlatform(platform) {
    // Allow re-auth even if state says connected (token may be missing from DB)

    const card = $(`#social-${platform}`);
    const statusEl = $(`#status-${platform}`);
    const connectBtn = $(`#connect-${platform}`);

    // One-click auth for platforms with pre-configured credentials
    if (['youtube', 'instagram', 'facebook'].includes(platform)) {
        const platformLabel = PLATFORMS[platform].name;
        showAuthModal(platform, `Connecting ${platformLabel}...`);
        if (platform === 'instagram') {
            updateModalStep('Requires a Business or Creator account (not Personal)', 'pending');
        }
        updateModalStep(`Setting up ${platformLabel}...`, 'current');

        try {
            const connectBody = {};
            if (activeSocialCharacterId) connectBody.characterCardId = activeSocialCharacterId;
            const res = await fetch(`/social/connect/${platform}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(connectBody)
            });
            const data = await res.json();

            if (data.authUrl) {
                updateModalStep(`Setting up ${platformLabel}...`, 'done');
                updateModalStep('Opening sign-in page...', 'current');

                const popup = window.open(data.authUrl, 'oauth_popup', 'width=600,height=700,scrollbars=yes');
                const charParam = activeSocialCharacterId ? `&characterCardId=${activeSocialCharacterId}` : '';

                const pollInterval = setInterval(async () => {
                    try {
                        const statusRes = await fetch(`/social/status/${platform}?_=${Date.now()}${charParam}`);
                        const statusData = await statusRes.json();
                        if (statusData.connected) {
                            clearInterval(pollInterval);
                            if (popup && !popup.closed) popup.close();
                            onPlatformConnected(platform);
                            closeModal();
                        }
                    } catch (e) { }

                    if (popup && popup.closed) {
                        clearInterval(pollInterval);
                        setTimeout(async () => {
                            const statusRes = await fetch(`/social/status/${platform}?_=${Date.now()}${charParam}`);
                            const statusData = await statusRes.json();
                            if (statusData.connected) {
                                onPlatformConnected(platform);
                            } else {
                                const errorDetail = statusData.lastError || 'Connection was not completed';
                                statusEl.textContent = 'Failed';
                                statusEl.title = errorDetail;
                                showToast(errorDetail, 'error');
                            }
                            closeModal();
                        }, 1000);
                    }
                }, 2000);
            } else if (data.error) {
                showToast(data.error, 'error');
                closeModal();
            }
        } catch (err) {
            showToast(`Failed to start ${platformLabel} connection`, 'error');
            closeModal();
        }
        return;
    }

    // Platforms that still need manual app credentials
    if (platform === 'twitter') {
        showSetupModal(platform, 'twitter');
    } else if (platform === 'tiktok') {
        showSetupModal(platform, 'tiktok');
    }
}

function onPlatformConnected(platform) {
    state.platforms[platform].connected = true;
    state.platforms[platform].enabled = true;
    saveState();

    const card = $(`#social-${platform}`);
    const statusEl = $(`#status-${platform}`);
    const toggle = $(`#toggle-${platform}`);
    const connectBtn = $(`#connect-${platform}`);

    card.classList.remove('connecting');
    card.classList.add('connected');
    statusEl.textContent = 'Connected';
    statusEl.className = 'social-status status-connected';
    toggle.disabled = false;
    toggle.checked = true;
    connectBtn.innerHTML = '<span class="connect-icon">✓</span> Connected';
    connectBtn.className = 'social-connect-btn btn-connected';

    // Add disconnect button if not already present
    if (!$(`#disconnect-${platform}`)) {
        const disconnectBtn = document.createElement('button');
        disconnectBtn.id = `disconnect-${platform}`;
        disconnectBtn.className = 'social-connect-btn btn-disconnect';
        disconnectBtn.innerHTML = '<span class="connect-icon">✕</span> Disconnect';
        disconnectBtn.onclick = () => disconnectPlatform(platform);
        connectBtn.parentElement.appendChild(disconnectBtn);
    }

    showToast(`${PLATFORMS[platform].name} connected!`, 'success');
}

async function disconnectPlatform(platform) {
    const platformLabel = PLATFORMS[platform].name;
    if (!confirm(`Disconnect ${platformLabel}? You can reconnect anytime.`)) return;

    try {
        const disconnectBody = {};
        if (activeSocialCharacterId) disconnectBody.characterCardId = activeSocialCharacterId;
        const res = await fetch(`/social/disconnect/${platform}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(disconnectBody)
        });
        const data = await res.json();

        if (data.success) {
            state.platforms[platform].connected = false;
            state.platforms[platform].enabled = false;
            saveState();

            const card = $(`#social-${platform}`);
            const statusEl = $(`#status-${platform}`);
            const toggle = $(`#toggle-${platform}`);
            const connectBtn = $(`#connect-${platform}`);
            const disconnectBtn = $(`#disconnect-${platform}`);

            card.classList.remove('connected');
            statusEl.textContent = 'Not Connected';
            statusEl.className = 'social-status';
            statusEl.title = '';
            toggle.disabled = true;
            toggle.checked = false;
            connectBtn.innerHTML = `<span class="connect-icon">⚡</span> Connect ${platformLabel}`;
            connectBtn.className = 'social-connect-btn';
            if (disconnectBtn) disconnectBtn.remove();

            showToast(`${platformLabel} disconnected`, 'info');
        } else {
            showToast(data.error || 'Failed to disconnect', 'error');
        }
    } catch (err) {
        showToast(`Failed to disconnect ${platformLabel}`, 'error');
    }
}

// --- Auth Modal ---
function showAuthModal(platform, title) {
    const overlay = $('#modalOverlay');
    const modal = $('#authModal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = `
    <div class="modal-spinner"><div class="spinner"></div></div>
    <p id="modalMessage">Setting up connection...</p>
    <div class="modal-steps" id="modalSteps"></div>
  `;
    overlay.classList.add('visible');
}

function updateModalStep(text, status) {
    const steps = $('#modalSteps');
    if (!steps) return;

    steps.querySelectorAll('.modal-step-icon.current').forEach(el => {
        el.className = 'modal-step-icon done';
        el.textContent = '✓';
    });

    const icons = { done: '✓', current: '◉', pending: '○' };
    const step = document.createElement('div');
    step.className = 'modal-step';
    step.innerHTML = `
    <span class="modal-step-icon ${status}">${icons[status]}</span>
    <span>${text}</span>
  `;
    steps.appendChild(step);
}

function closeModal() {
    $('#modalOverlay').classList.remove('visible');
}

// --- Setup Modal ---
function showSetupModal(platform, type) {
    const overlay = $('#setupOverlay');
    const title = $('#setupTitle');
    const body = $('#setupBody');
    const footer = $('#setupFooter');

    if (type === 'meta') {
        title.textContent = `Connect ${PLATFORMS[platform].name}`;
        body.innerHTML = `
      <p style="text-align:left; margin-bottom:16px">To connect ${PLATFORMS[platform].name}, you need a Meta (Facebook) Developer App:</p>
      <div class="modal-steps">
        <div class="modal-step"><span class="modal-step-icon current">1</span><span>Go to <a href="https://developers.facebook.com/apps/" target="_blank" style="color:var(--accent-indigo)">Meta for Developers</a></span></div>
        <div class="modal-step"><span class="modal-step-icon pending">2</span><span>Create a "Business" app, add Facebook Login</span></div>
        <div class="modal-step"><span class="modal-step-icon pending">3</span><span>Set redirect URI: <code style="color:var(--accent-cyan)">http://localhost:3333/auth/callback/${platform}</code></span></div>
        <div class="modal-step"><span class="modal-step-icon pending">4</span><span>Copy your App ID and App Secret below</span></div>
      </div>
      <div class="modal-input-group"><label>App ID</label><input type="text" id="setup-app-id" placeholder="Enter your Meta App ID"></div>
      <div class="modal-input-group"><label>App Secret</label><input type="password" id="setup-app-secret" placeholder="Enter your Meta App Secret"></div>
    `;
        footer.innerHTML = `
      <button class="btn" onclick="closeSetupModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitSetup('${platform}', 'meta')">Connect ${PLATFORMS[platform].name}</button>
    `;
    } else if (type === 'twitter') {
        title.textContent = 'Connect X (Twitter)';
        body.innerHTML = `
      <p style="text-align:left; margin-bottom:16px">To connect X, you need a Twitter Developer account:</p>
      <div class="modal-steps">
        <div class="modal-step"><span class="modal-step-icon current">1</span><span>Go to <a href="https://developer.twitter.com" target="_blank" style="color:var(--accent-indigo)">Twitter Developer Portal</a></span></div>
        <div class="modal-step"><span class="modal-step-icon pending">2</span><span>Create a project with OAuth 2.0</span></div>
        <div class="modal-step"><span class="modal-step-icon pending">3</span><span>Set redirect URI: <code style="color:var(--accent-cyan)">http://localhost:3333/auth/callback/twitter</code></span></div>
        <div class="modal-step"><span class="modal-step-icon pending">4</span><span>Copy your Client ID and Secret below</span></div>
      </div>
      <div class="modal-input-group"><label>Client ID</label><input type="text" id="setup-app-id" placeholder="Enter Twitter Client ID"></div>
      <div class="modal-input-group"><label>Client Secret</label><input type="password" id="setup-app-secret" placeholder="Enter Twitter Client Secret"></div>
    `;
        footer.innerHTML = `
      <button class="btn" onclick="closeSetupModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitSetup('twitter', 'twitter')">Connect X</button>
    `;
    } else if (type === 'tiktok') {
        title.textContent = 'Connect TikTok';
        body.innerHTML = `
      <p style="text-align:left; margin-bottom:16px">To connect TikTok, you need a TikTok Developer account:</p>
      <div class="modal-steps">
        <div class="modal-step"><span class="modal-step-icon current">1</span><span>Go to <a href="https://developers.tiktok.com/" target="_blank" style="color:var(--accent-indigo)">TikTok for Developers</a></span></div>
        <div class="modal-step"><span class="modal-step-icon pending">2</span><span>Create an app with Content Posting API</span></div>
        <div class="modal-step"><span class="modal-step-icon pending">3</span><span>Set redirect URI: <code style="color:var(--accent-cyan)">http://localhost:3333/auth/callback/tiktok</code></span></div>
        <div class="modal-step"><span class="modal-step-icon pending">4</span><span>Copy your Client Key and Secret below</span></div>
      </div>
      <div class="modal-input-group"><label>Client Key</label><input type="text" id="setup-app-id" placeholder="Enter TikTok Client Key"></div>
      <div class="modal-input-group"><label>Client Secret</label><input type="password" id="setup-app-secret" placeholder="Enter TikTok Client Secret"></div>
    `;
        footer.innerHTML = `
      <button class="btn" onclick="closeSetupModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitSetup('tiktok', 'tiktok')">Connect TikTok</button>
    `;
    }

    overlay.classList.add('visible');
}

function closeSetupModal() {
    $('#setupOverlay').classList.remove('visible');
}

async function submitSetup(platform, type) {
    const appId = $('#setup-app-id').value.trim();
    const appSecret = $('#setup-app-secret').value.trim();

    if (!appId || !appSecret) {
        showToast('Please enter both App ID and Secret', 'error');
        return;
    }

    closeSetupModal();
    showAuthModal(platform, `Connecting ${PLATFORMS[platform].name}...`);
    updateModalStep('Saving app credentials...', 'current');

    try {
        const setupBody = { appId, appSecret };
        if (activeSocialCharacterId) setupBody.characterCardId = activeSocialCharacterId;
        const res = await fetch(`/social/connect/${platform}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(setupBody)
        });
        const data = await res.json();

        if (data.authUrl) {
            updateModalStep('Saving app credentials...', 'done');
            updateModalStep('Opening sign-in page...', 'current');

            const popup = window.open(data.authUrl, 'oauth_popup', 'width=600,height=700,scrollbars=yes');
            const charParam2 = activeSocialCharacterId ? `&characterCardId=${activeSocialCharacterId}` : '';

            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch(`/social/status/${platform}?_=${Date.now()}${charParam2}`);
                    const statusData = await statusRes.json();
                    if (statusData.connected) {
                        clearInterval(pollInterval);
                        if (popup && !popup.closed) popup.close();
                        onPlatformConnected(platform);
                        closeModal();
                    }
                } catch (e) { }
                if (popup && popup.closed) {
                    clearInterval(pollInterval);
                    setTimeout(async () => {
                        const statusRes = await fetch(`/social/status/${platform}?_=${Date.now()}${charParam2}`);
                        const statusData = await statusRes.json();
                        if (statusData.connected) {
                            onPlatformConnected(platform);
                        }
                        closeModal();
                    }, 1500);
                }
            }, 2000);
        } else {
            showToast(data.error || 'Failed to start connection', 'error');
            closeModal();
        }
    } catch (err) {
        showToast(`Failed to connect ${PLATFORMS[platform].name}`, 'error');
        closeModal();
    }
}

// ==================== EVENT LISTENERS ====================
function initEventListeners() {
    $('#refreshBtn').addEventListener('click', async () => {
        showToast('Refreshing...', 'info');
        await Promise.all([loadPipelineStatus(), loadExecutions(), loadSocialStatus(), loadAgentConfig()]);
        updateNextRun();
        showToast('Dashboard refreshed', 'success');
    });

    $('#triggerBtn').addEventListener('click', async () => {
        // Handled by enhanceTriggerButton
    });

    $('#saveScheduleBtn').addEventListener('click', async () => {
        collectSettings(); saveState();
        showToast('Saving schedule...', 'info');
        const times = state.settings.schedule;
        try {
            await fetch('/v1/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cronTimes: times, enabled: true })
            });
            showToast('Schedule saved!', 'success');
            updateNextRun();
        } catch (e) {
            showToast('Schedule save failed: ' + e.message, 'error');
        }
    });

    $('#saveVideoSettingsBtn').addEventListener('click', async () => {
        collectSettings(); saveState();
        const s = state.settings;
        // Update pipeline detail text
        const detailEl = $('#detail-video-gen');
        if (detailEl) {
            if (s.videoModel.startsWith('kling')) detailEl.textContent = 'Kling 2.6';
            else if (s.videoModel.startsWith('wan')) detailEl.textContent = 'Wan 2.6';
            else detailEl.textContent = s.videoModel;
        }
        showToast('Video settings saved! Will apply to next pipeline run.', 'success');
    });

    $('#saveTelegramBtn').addEventListener('click', async () => {
        collectSettings(); saveState();
        showToast('Telegram config saved!', 'success');
    });

    // Telegram custom prompt trigger
    $('#triggerWithPromptBtn').addEventListener('click', () => triggerWithCustomPrompt());

    // Telegram approval toggle
    const approvalToggle = $('#toggleTelegramApproval');
    approvalToggle.checked = localStorage.getItem('n8n_telegram_approval') !== 'false';
    approvalToggle.addEventListener('change', () => {
        localStorage.setItem('n8n_telegram_approval', approvalToggle.checked);
    });

    // Telegram trigger listener toggle
    const triggerToggle = $('#toggleTelegramTrigger');
    triggerToggle.checked = localStorage.getItem('n8n_telegram_trigger') !== 'false';
    triggerToggle.addEventListener('change', () => {
        localStorage.setItem('n8n_telegram_trigger', triggerToggle.checked);
    });
}

// ==================== WORKFLOW HELPERS (no-op, pipeline engine handles everything) ====================

// ==================== LLM PROVIDER SWAP ====================
function swapLLMProvider(provider) {
    state.llmProvider = provider;
    localStorage.setItem('n8n_llm_provider', provider);
    const label = provider === 'gemini' ? 'Gemini 2.5 Flash' : 'Claude Sonnet 4';
    showToast(`Switched to ${label} — applies to next pipeline run`, 'success');
}

function initLLMProviderToggle() {
    const dropdown = $('#llmProvider');
    if (!dropdown) return;
    const saved = localStorage.getItem('n8n_llm_provider');
    if (saved) {
        dropdown.value = saved;
        state.llmProvider = saved;
    }
    dropdown.addEventListener('change', () => swapLLMProvider(dropdown.value));
}

// Schedule and Telegram config are saved via /v1/schedule and locally
// No workflow to update — pipeline engine reads settings at job time

// ==================== TELEGRAM FUNCTIONS ====================

async function triggerWithCustomPrompt() {
    const promptEl = $('#telegramCustomPrompt');
    const customPrompt = promptEl.value.trim();
    if (!customPrompt) {
        showToast('Enter a prompt first', 'error');
        promptEl.focus();
        return;
    }

    showToast('Triggering with custom prompt...', 'info');
    const btn = $('#triggerWithPromptBtn');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
        collectSettings();
        const enabledPlatforms = Object.entries(state.platforms)
            .filter(([_, v]) => v.connected && v.enabled)
            .map(([k]) => k);

        const res = await apiFetch('/v1/pipeline/run', {
            method: 'POST',
            body: JSON.stringify({
                llmProvider: state.llmProvider,
                imageModel: state.settings.imageModel,
                videoModel: state.settings.videoModel,
                videoDuration: state.settings.videoDuration,
                useReferenceImage: state.settings.useReferenceImage !== false,
                platforms: enabledPlatforms,
                customPrompt: customPrompt,
                source: 'custom_prompt',
            })
        });

        if (res && res.jobId) {
            showToast('Pipeline triggered with custom prompt!', 'success');
            promptEl.value = '';
            startPipelineMonitor(res.jobId);
        } else if (res && res._error) {
            showToast('Trigger failed: ' + res.message, 'error');
        } else {
            showToast('Failed to trigger pipeline', 'error');
        }
    } catch (e) {
        showToast('Trigger error: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send`;
    }
}

// Telegram approval/trigger settings are stored locally
// Pipeline engine reads them at job submission time

// ==================== PIPELINE MONITOR ====================
const PIPELINE_STAGES = [
    { id: 'creative-director', phase: 'prompt_generation', label: 'Prompt Generation' },
    { id: 'image-gen', phase: 'image_generation', label: 'Image Generation' },
    { id: 'video-gen', phase: 'video_generation', label: 'Video Generation' },
    { id: 'review', phase: 'uploading', label: 'Review & Upload' }
];

let pipelineState = {
    active: false,
    jobId: null,
    pollInterval: null,
    timerInterval: null,
    startTime: null,
    contentRetries: 0,
    contentRetryStart: null,
    contentTimerInterval: null,
};

function initPipeline() {
    // Check for any currently running job on load
    checkForRunningExecution();
}

async function checkForRunningExecution() {
    try {
        const data = await apiFetch('/v1/pipeline/history');
        if (data && data.length > 0) {
            const latest = data[0];
            if (latest.status === 'processing' || latest.status === 'queued') {
                startPipelineMonitor(latest.id, new Date(latest.createdAt));
            }
        }
    } catch (e) {
        console.log('Check running:', e.message);
    }
}

function startPipelineMonitor(jobId, startTime) {
    if (pipelineState.pollInterval) clearInterval(pipelineState.pollInterval);
    if (pipelineState.timerInterval) clearInterval(pipelineState.timerInterval);

    pipelineState.active = true;
    pipelineState.jobId = jobId;
    pipelineState.startTime = startTime || new Date();

    // Reset UI
    resetContentAlert();
    const tracker = $('#pipelineTracker');
    if (tracker) tracker.classList.add('active');
    const badge = $('#pipelineStatusBadge');
    if (badge) badge.className = 'pipeline-status-badge running';
    const statusText = $('#pipelineStatusText');
    if (statusText) statusText.textContent = 'Running';
    const errorBanner = $('#pipelineErrorBanner');
    if (errorBanner) errorBanner.style.display = 'none';
    const stopBtn = $('#pipelineStopBtn');
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    const progressFill = $('#pipelineProgressFill');
    if (progressFill) progressFill.className = 'pipeline-progress-fill';
    setProgress(5);

    PIPELINE_STAGES.forEach(s => {
        const el = $(`#stage-${s.id}`);
        if (el) {
            const baseClass = el.classList.contains('cc-pipeline-dot') ? 'cc-pipeline-dot' : 'pipeline-stage';
            el.className = baseClass + ' pending';
        }
        const detail = $(`#detail-${s.id}`);
        if (detail) detail.textContent = 'Waiting...';
    });

    // Start timer
    pipelineState.timerInterval = setInterval(updatePipelineTimer, 1000);
    updatePipelineTimer();

    // Start polling
    pipelineState.pollInterval = setInterval(() => pollPipeline(), 3000);
    pollPipeline();
}

function updatePipelineTimer() {
    if (!pipelineState.startTime) return;
    const elapsed = Math.floor((Date.now() - new Date(pipelineState.startTime).getTime()) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    $('#pipelineTimer').textContent = `${mins}:${secs}`;
}

function setProgress(pct) {
    const fill = $('#pipelineProgressFill');
    const glow = $('#pipelineProgressGlow');
    const pctEl = $('#pipelineProgressPct');
    if (fill) fill.style.width = pct + '%';
    if (glow) glow.style.width = pct + '%';
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
}

async function pollPipeline() {
    if (!pipelineState.jobId) return;

    try {
        const data = await apiFetch(`/v1/pipeline/status/${pipelineState.jobId}`);
        if (!data) return;

        const status = data.status;
        const currentPhase = data.currentPhase;

        // Map phases to stage progress
        const phaseOrder = ['prompt_generation', 'image_generation', 'video_generation', 'uploading'];
        const currentPhaseIdx = phaseOrder.indexOf(currentPhase);

        PIPELINE_STAGES.forEach((stage, idx) => {
            const stageEl = $(`#stage-${stage.id}`);
            const detailEl = $(`#detail-${stage.id}`);
            if (!stageEl) return;

            // Helper: set stage class (supports both old pipeline-stage and new cc-pipeline-dot)
            const setStageClass = (state) => {
                const baseClass = stageEl.classList.contains('cc-pipeline-dot') ? 'cc-pipeline-dot' : 'pipeline-stage';
                stageEl.className = baseClass + ' ' + state;
            };

            if (status === 'completed') {
                const isUploadStage = stage.phase === 'uploading';
                const uploadsEmpty = isUploadStage && (!data.result?.uploads || Object.keys(data.result.uploads).length === 0);
                if (uploadsEmpty) {
                    setStageClass('pending');
                    if (detailEl) detailEl.textContent = 'Skipped';
                } else {
                    setStageClass('success');
                    if (detailEl) detailEl.textContent = '\u2713 Complete';
                }
            } else if (status === 'failed') {
                if (idx <= currentPhaseIdx) {
                    if (idx === currentPhaseIdx) {
                        setStageClass('error');
                        if (detailEl) detailEl.textContent = '\u2717 Failed';
                    } else {
                        setStageClass('success');
                        if (detailEl) detailEl.textContent = '\u2713 Complete';
                    }
                } else {
                    setStageClass('pending');
                    if (detailEl) detailEl.textContent = 'Waiting...';
                }
            } else if (status === 'processing') {
                if (idx < currentPhaseIdx) {
                    setStageClass('success');
                    if (detailEl) detailEl.textContent = '\u2713 Complete';
                } else if (idx === currentPhaseIdx) {
                    setStageClass('running');
                    if (detailEl) detailEl.textContent = 'Processing...';
                } else {
                    setStageClass('pending');
                    if (detailEl) detailEl.textContent = 'Waiting...';
                }
            } else {
                setStageClass('pending');
                if (detailEl) detailEl.textContent = idx === 0 ? 'Queued...' : 'Waiting...';
            }
        });

        // Progress
        if (status === 'completed') {
            setProgress(100);

            // Check for upload failures in the result
            const uploads = data.result?.uploads;
            if (uploads) {
                const failed = Object.entries(uploads)
                    .filter(([_, r]) => !r.success);
                if (failed.length > 0) {
                    failed.forEach(([platform, r]) => {
                        showToast(`${platform} upload failed: ${r.error}`, 'error');
                    });
                }
            }

            completePipeline('success');
        } else if (status === 'failed') {
            setProgress(Math.max((currentPhaseIdx / phaseOrder.length) * 100, 10));
            completePipeline('error', data.error || 'Pipeline failed');
        } else if (status === 'processing') {
            const pct = ((currentPhaseIdx + 0.5) / phaseOrder.length) * 100;
            setProgress(Math.min(pct, 95));
        } else {
            setProgress(5);
        }
    } catch (err) {
        console.error('Pipeline poll error:', err);
    }
}

// ==================== CONTENT MODERATION ALERT ====================
// Content retry detection is handled server-side; UI shows alert if pipeline reports retries

function updateContentRetryTimer() {
    if (!pipelineState.contentRetryStart) return;
    const elapsed = Math.floor((Date.now() - pipelineState.contentRetryStart) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    const timerEl = $('#contentRetryTimer');
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
}

async function stopPipeline() {
    if (!pipelineState.jobId) return;

    const btn = $('#pipelineStopBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner-sm"></div> Stopping...';
    }

    // Mark pipeline as stopped in the UI
    completePipeline('error', 'Manually stopped by user');
    showToast('Pipeline stopped', 'info');

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'Stop';
    }
}

function resetContentAlert() {
    pipelineState.contentRetries = 0;
    pipelineState.contentRetryStart = null;
    if (pipelineState.contentTimerInterval) {
        clearInterval(pipelineState.contentTimerInterval);
        pipelineState.contentTimerInterval = null;
    }
    const alertEl = $('#pipelineContentAlert');
    if (alertEl) alertEl.style.display = 'none';
}

function completePipeline(status, errorMsg) {
    pipelineState.active = false;
    if (pipelineState.pollInterval) clearInterval(pipelineState.pollInterval);
    if (pipelineState.timerInterval) clearInterval(pipelineState.timerInterval);
    if (pipelineState.contentTimerInterval) clearInterval(pipelineState.contentTimerInterval);
    pipelineState.contentTimerInterval = null;

    // Deactivate glow ring on pipeline completion
    const glowEl = document.getElementById('ccPromptGlowWrapper');
    if (glowEl) { glowEl.classList.remove('generating'); glowEl.dataset.generating = 'false'; }

    const tracker = $('#pipelineTracker');
    if (tracker) tracker.classList.remove('active');
    const stopBtn = $('#pipelineStopBtn');
    if (stopBtn) stopBtn.style.display = 'none';
    const badge = $('#pipelineStatusBadge');
    const fillEl = $('#pipelineProgressFill');
    const statusText = $('#pipelineStatusText');

    if (status === 'success') {
        if (badge) badge.className = 'pipeline-status-badge success';
        if (statusText) statusText.textContent = 'Complete';
        setProgress(100);
        if (fillEl) fillEl.classList.add('complete');
        showToast('Pipeline complete! Video generated.', 'success');
        if (typeof autoExpandAssetsOnComplete === 'function') autoExpandAssetsOnComplete();
    } else {
        if (badge) badge.className = 'pipeline-status-badge error';
        if (statusText) statusText.textContent = 'Stopped';
        if (fillEl) fillEl.classList.add('error');
        if (errorMsg) {
            const errBanner = $('#pipelineErrorBanner');
            const errText = $('#pipelineErrorText');
            if (errBanner) errBanner.style.display = 'flex';
            if (errText) errText.textContent = errorMsg.substring(0, 120);
        }
        showToast('Pipeline stopped — check error details', 'error');
    }

    // Refresh executions and assets
    setTimeout(loadExecutions, 2000);
    if (status === 'success') setTimeout(loadAssets, 2000);
}

// Override the trigger button to submit a pipeline job
function enhanceTriggerButton() {
    const btn = $('#triggerBtn');

    // Remove old event listener and add new one
    btn.replaceWith(btn.cloneNode(true));
    const newBtn = $('#triggerBtn');

    newBtn.addEventListener('click', async () => {
        if (newBtn.disabled) return;
        newBtn.disabled = true;
        const origHTML = newBtn.innerHTML;
        newBtn.innerHTML = '<div class="spinner-sm"></div> Triggering...';

        showToast('Triggering pipeline...', 'info');
        collectSettings();

        // Refresh connected status from DB before building platforms list
        // (localStorage may have stale connected: false)
        await loadSocialStatus();

        const enabledPlatforms = Object.entries(state.platforms)
            .filter(([_, v]) => v.connected && v.enabled)
            .map(([k]) => k);

        console.log('[trigger] Enabled platforms:', enabledPlatforms);

        const res = await apiFetch('/v1/pipeline/run', {
            method: 'POST',
            body: JSON.stringify({
                llmProvider: state.llmProvider,
                imageModel: state.settings.imageModel,
                videoModel: state.settings.videoModel,
                videoDuration: state.settings.videoDuration,
                useReferenceImage: state.settings.useReferenceImage !== false,
                platforms: enabledPlatforms,
                source: 'manual',
                characterCardIds: iphoneState.selectedCardIds || [],
            })
        });

        if (res && res.jobId) {
            showToast('Pipeline triggered!', 'success');
            startPipelineMonitor(res.jobId);
        } else if (res && res._error) {
            showToast('Trigger failed: ' + res.message, 'error');
        } else {
            showToast('Failed to trigger pipeline', 'error');
        }

        setTimeout(() => { newBtn.disabled = false; newBtn.innerHTML = origHTML; }, 5000);
    });
}

// ==================== MOTION LIBRARY ====================
let motionLibraryData = [];
let motionWebResults = [];
let motionFilter = 'all';
let motionSearchQuery = '';
let selectedMotionId = null;
let selectedMotionUrl = null;
let selectedMotionName = '';
let motionWebMode = false;

// ==================== ASSETS GALLERY ====================
let assetsData = [];
let assetsFilter = 'all';

let assetsCollapsed = localStorage.getItem('n8n_assets_collapsed') === 'true';

// Legacy — now handled by section-collapsible system
function toggleAssetsCollapse() {
    toggleSectionCollapse('recent-assets');
}

function initAssetsCollapse() {
    // Handled by initSectionCollapse
}

// ==================== MOTION LIBRARY FUNCTIONS ====================

async function loadMotionLibrary() {
    try {
        const params = new URLSearchParams();
        if (motionSearchQuery) params.set('search', motionSearchQuery);
        if (motionFilter && motionFilter !== 'all') params.set('category', motionFilter);
        const res = await fetch(`/api/motions?${params}`, { headers: authHeaders() });
        if (!res.ok) return;
        motionLibraryData = await res.json();
        motionWebMode = false;
        renderMotionLibrary();
    } catch (e) {
        console.log('Motion library load error:', e);
    }
}

function renderMotionLibrary() {
    const grid = document.getElementById('motionGrid');
    const empty = document.getElementById('motionEmpty');
    if (!grid) return;

    const data = motionWebMode ? motionWebResults : motionLibraryData;

    if (data.length === 0) {
        grid.innerHTML = '';
        if (empty) {
            empty.style.display = 'flex';
            grid.appendChild(empty);
        }
        return;
    }

    if (empty) empty.style.display = 'none';

    grid.innerHTML = data.map(m => {
        const isSelected = selectedMotionId === m.id;
        const isWeb = motionWebMode && m.source === 'pexels' && !m.user_id;
        const thumbSrc = m.thumbnail_url || '';
        const dur = m.duration_seconds || m.duration || 0;
        const durLabel = dur > 0 ? `${Math.round(dur)}s` : '';
        const displayName = (m.name || '').substring(0, 30);

        return `
            <div class="cc-motion-card ${isSelected ? 'selected' : ''}"
                 onclick="${isWeb ? '' : `selectMotion('${m.id}', '${(m.video_url || '').replace(/'/g, "\\'")}', '${displayName.replace(/'/g, "\\'")}')`}"
                 onmouseenter="this.querySelector('video')?.play()"
                 onmouseleave="this.querySelector('video')?.pause()">
                ${thumbSrc
                    ? `<img src="${thumbSrc}" alt="${displayName}" loading="lazy">`
                    : `<video src="${m.video_url || ''}" muted preload="metadata"></video>`
                }
                ${m.source === 'instagram' && !isWeb ? '<div class="cc-motion-badge">IG</div>' : ''}
                ${m.source === 'pexels' && !isWeb ? '<div class="cc-motion-badge">Pexels</div>' : ''}
                ${m.source === 'curated' ? '<div class="cc-motion-badge">Trending</div>' : ''}
                <div class="cc-motion-check">&#10003;</div>
                <div class="cc-motion-card-overlay">
                    <div class="cc-motion-card-name">${displayName}</div>
                    ${durLabel ? `<div class="cc-motion-card-duration">${durLabel}</div>` : ''}
                </div>
                <div class="cc-motion-card-actions">
                    ${isWeb
                        ? `<button class="cc-motion-save-btn" onclick="event.stopPropagation(); saveMotionFromWeb('${(m.video_url || '').replace(/'/g, "\\'")}', '${displayName.replace(/'/g, "\\'")}', '${(m.thumbnail_url || '').replace(/'/g, "\\'")}', ${dur}, '${m.ig_shortcode || m.pexels_video_id || ''}')">Save</button>`
                        : (m.source === 'user' ? `<button onclick="event.stopPropagation(); deleteMotionFromLibrary('${m.id}')" title="Delete">&times;</button>` : '')
                    }
                </div>
            </div>
        `;
    }).join('');
}

function selectMotion(motionId, videoUrl, name) {
    selectedMotionId = motionId;
    selectedMotionUrl = videoUrl;
    selectedMotionName = name;
    iphoneState.motionRefUrl = videoUrl;
    iphoneState.motionRefFile = null;

    // Update selected bar
    const bar = document.getElementById('motionSelectedBar');
    const preview = document.getElementById('motionSelectedPreview');
    const nameEl = document.getElementById('motionSelectedName');
    if (bar) bar.style.display = 'flex';
    if (preview) {
        preview.src = videoUrl;
        preview.play().catch(() => {});
    }
    if (nameEl) nameEl.textContent = name;

    renderMotionLibrary();
}

function clearSelectedMotion() {
    selectedMotionId = null;
    selectedMotionUrl = null;
    selectedMotionName = '';
    iphoneState.motionRefUrl = null;
    iphoneState.motionRefFile = null;

    const bar = document.getElementById('motionSelectedBar');
    const preview = document.getElementById('motionSelectedPreview');
    if (bar) bar.style.display = 'none';
    if (preview) { preview.pause(); preview.src = ''; }

    renderMotionLibrary();
}

function searchMotionsLocal(value) {
    motionSearchQuery = value;
    if (motionWebMode && !value) {
        motionWebMode = false;
        loadMotionLibrary();
        return;
    }
    // Debounce local search
    clearTimeout(searchMotionsLocal._timer);
    searchMotionsLocal._timer = setTimeout(() => loadMotionLibrary(), 300);
}

async function searchMotionWeb() {
    const input = document.getElementById('motionSearchInput');
    const query = input?.value?.trim();
    if (!query) {
        showToast('Enter a search term first', 'info');
        return;
    }

    const grid = document.getElementById('motionGrid');
    if (grid) grid.innerHTML = '<div class="cc-motion-web-loading">Searching Instagram reels...</div>';

    try {
        const res = await fetch(`/api/motions/search-web?query=${encodeURIComponent(query)}`, { headers: authHeaders() });
        if (!res.ok) {
            const err = await res.json();
            showToast(err.error || 'Search failed', 'error');
            return;
        }
        motionWebResults = await res.json();
        motionWebMode = true;
        renderMotionLibrary();
        if (motionWebResults.length === 0) {
            showToast('No videos found for that search', 'info');
        }
    } catch (e) {
        showToast('Web search failed: ' + e.message, 'error');
    }
}

function filterMotionCategory(category) {
    motionFilter = category;
    document.querySelectorAll('.cc-motion-tab').forEach(t => t.classList.remove('active'));
    const tab = document.querySelector(`.cc-motion-tab[data-cat="${category}"]`);
    if (tab) tab.classList.add('active');
    motionWebMode = false;
    loadMotionLibrary();
}

async function handleMotionLibraryUpload(file) {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
        showToast('Please select a video file', 'error');
        return;
    }
    if (file.size > 50 * 1024 * 1024) {
        showToast('File too large (max 50MB)', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('video', file);
    formData.append('name', file.name.replace(/\.[^/.]+$/, ''));
    formData.append('category', motionFilter === 'mine' || motionFilter === 'all' ? 'dance' : motionFilter);

    showToast('Uploading motion video...', 'info');
    try {
        const res = await fetch('/api/motions', {
            method: 'POST',
            headers: authHeaders(),
            body: formData,
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Upload failed');
        }
        const motion = await res.json();
        showToast('Motion uploaded!', 'success');
        motionWebMode = false;
        loadMotionLibrary();
        // Auto-select the newly uploaded motion
        selectMotion(motion.id, motion.video_url, motion.name);
    } catch (e) {
        showToast('Upload error: ' + e.message, 'error');
    }
    // Reset input
    const input = document.getElementById('motionLibraryUploadInput');
    if (input) input.value = '';
}

async function saveMotionFromWeb(videoUrl, name, thumbnailUrl, duration, sourceId) {
    showToast('Saving motion to library...', 'info');
    try {
        const res = await fetch('/api/motions/save-from-web', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                videoUrl: videoUrl,
                name: name,
                category: motionFilter === 'mine' || motionFilter === 'all' ? 'dance' : motionFilter,
                thumbnailUrl: thumbnailUrl,
                duration: duration,
                igShortcode: sourceId,
            }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Save failed');
        }
        const motion = await res.json();
        showToast('Motion saved to library!', 'success');
        motionWebMode = false;
        loadMotionLibrary();
        selectMotion(motion.id, motion.video_url, motion.name);
    } catch (e) {
        showToast('Save error: ' + e.message, 'error');
    }
}

async function deleteMotionFromLibrary(motionId) {
    if (!confirm('Delete this motion from your library?')) return;
    try {
        await fetch(`/api/motions/${motionId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        if (selectedMotionId === motionId) clearSelectedMotion();
        loadMotionLibrary();
        showToast('Motion deleted', 'success');
    } catch (e) {
        showToast('Delete failed', 'error');
    }
}

// ==================== ASSETS GALLERY (continued) ====================

// Resolve the best available URL for an asset (publicUrl > sourceUrl > local path)
function assetBestUrl(asset) {
    if (asset.publicUrl) return asset.publicUrl;
    if (asset.sourceUrl && asset.sourceUrl !== 'gemini-base64') return asset.sourceUrl;
    return asset.path;
}

async function loadAssets() {
    try {
        const res = await fetch('/assets/log');
        if (!res.ok) return;
        assetsData = await res.json();
        renderAssets();
    } catch (e) {
        console.log('Assets load error:', e);
    }
}

function filterAssets(filter) {
    assetsFilter = filter;
    // Handle both legacy .assets-tab and new .cc-asset-tab
    document.querySelectorAll('.assets-tab, .cc-asset-tab').forEach(t => t.classList.remove('active'));
    const tab = document.querySelector(`.assets-tab[data-filter="${filter}"], .cc-asset-tab[data-filter="${filter}"]`);
    if (tab) tab.classList.add('active');
    renderAssets();
}

function renderAssets() {
    const grid = document.getElementById('assetsGrid');
    const empty = document.getElementById('assetsEmpty');
    const countEl = document.getElementById('assetsCount');

    const filtered = assetsFilter === 'all'
        ? assetsData
        : assetsData.filter(a => a.type === assetsFilter);

    if (countEl) countEl.textContent = `${filtered.length} asset${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
        grid.innerHTML = '';
        grid.appendChild(empty);
        empty.style.display = 'flex';
        return;
    }

    if (empty) empty.style.display = 'none';

    // Sort newest first
    const sorted = [...filtered].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

    grid.innerHTML = sorted.map((asset, idx) => {
        const isVideo = asset.type === 'video';
        const sizeStr = asset.size > 1024 * 1024
            ? (asset.size / (1024 * 1024)).toFixed(1) + ' MB'
            : (asset.size / 1024).toFixed(0) + ' KB';
        const dateStr = new Date(asset.savedAt).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        const promptStr = asset.prompt ? asset.prompt.substring(0, 120) : '';

        return `
            <div class="asset-card" onclick="openLightbox(${idx})">
                <div class="asset-thumb">
                    ${isVideo
                        ? `<video src="${assetBestUrl(asset)}" muted preload="metadata" onerror="this.style.display='none';this.parentElement.querySelector('.asset-expired').style.display='flex'"></video>
                           <div class="asset-play-icon">
                               <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                           </div>
                           <div class="asset-expired" style="display:none;align-items:center;justify-content:center;height:100%;color:#666;font-size:11px;">Link expired</div>`
                        : `<img src="${assetBestUrl(asset)}" alt="Generated image" loading="lazy" onerror="this.style.display='none';this.parentElement.querySelector('.asset-expired').style.display='flex'">
                           <div class="asset-expired" style="display:none;align-items:center;justify-content:center;height:100%;color:#666;font-size:11px;">Link expired</div>`
                    }
                    <span class="asset-type-badge ${asset.type}">${asset.type}</span>
                    <button class="asset-save-look-btn" onclick="event.stopPropagation(); saveLookFromAsset(${idx})">Save as Look</button>
                </div>
                <div class="asset-meta">
                    <div class="asset-meta-row">
                        <span class="asset-exec-id">Exec #${asset.executionId || '?'}</span>
                        <span class="asset-size">${sizeStr}</span>
                    </div>
                    <div class="asset-date">${dateStr}</div>
                    ${promptStr ? `<div class="asset-prompt">${promptStr}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function openLightbox(idx) {
    // Get the sorted/filtered asset list matching what's rendered
    const filtered = assetsFilter === 'all'
        ? assetsData
        : assetsData.filter(a => a.type === assetsFilter);
    const sorted = [...filtered].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    const asset = sorted[idx];
    if (!asset) return;

    const lightbox = document.getElementById('assetLightbox');
    const content = document.getElementById('assetLightboxContent');
    const isVideo = asset.type === 'video';
    const meta = asset.metadata || {};

    const dateStr = new Date(asset.savedAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const sizeStr = asset.size > 1024 * 1024
        ? (asset.size / (1024 * 1024)).toFixed(1) + ' MB'
        : (asset.size / 1024).toFixed(0) + ' KB';

    // Build prompt sections
    const imagePrompt = isVideo ? (meta.image_prompt || '') : (asset.prompt || '');
    const videoPrompt = isVideo ? (asset.prompt || '') : (meta.video_prompt || '');

    content.innerHTML = `
        <div class="lightbox-layout">
            <div class="lightbox-media">
                ${isVideo
                    ? `<video src="${assetBestUrl(asset)}" controls autoplay style="max-height:75vh;border-radius:12px;"></video>`
                    : `<img src="${assetBestUrl(asset)}" style="max-height:75vh;border-radius:12px;">`
                }
            </div>
            <div class="lightbox-details">
                <div class="lightbox-detail-header">
                    <span class="asset-type-badge ${asset.type}" style="position:static;margin-right:8px;">${asset.type}</span>
                    <span style="color:var(--text-secondary);font-size:0.85rem;">Exec #${asset.executionId || '?'} &middot; ${dateStr} &middot; ${sizeStr}</span>
                </div>
                ${imagePrompt ? `
                    <div class="lightbox-prompt-section">
                        <div class="lightbox-prompt-label">Image Prompt</div>
                        <div class="lightbox-prompt-text">${escapeHtml(imagePrompt)}</div>
                    </div>
                ` : ''}
                ${videoPrompt ? `
                    <div class="lightbox-prompt-section">
                        <div class="lightbox-prompt-label">Video Prompt</div>
                        <div class="lightbox-prompt-text">${escapeHtml(videoPrompt)}</div>
                    </div>
                ` : ''}
            </div>
        </div>
    `;

    lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox(e) {
    if (e && e.target !== e.currentTarget && !e.target.classList.contains('asset-lightbox-close')) return;
    const lightbox = document.getElementById('assetLightbox');
    lightbox.classList.remove('active');
    document.body.style.overflow = '';

    // Stop any playing video
    const video = lightbox.querySelector('video');
    if (video) video.pause();
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
});

// ==================== MUSIC POOL ====================
function renderMusicPool() {
    const container = $('#cdMusicPool');
    const emptyEl = $('#musicPoolEmpty');
    if (!container) return;

    const tracks = cdConfig.music || [];
    if (tracks.length === 0) {
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.id = 'musicPoolEmpty';
        empty.style.cssText = 'padding:16px;text-align:center;color:var(--text-tertiary);font-size:0.85rem;';
        empty.textContent = 'No music tracks. Upload an MP3 to add background music to Reels.';
        container.appendChild(empty);
        return;
    }

    container.innerHTML = tracks.map(track => `
        <div class="cd-list-item" data-music-id="${track.id}" style="align-items:center;">
            <span class="cd-list-num" style="font-size:0.75rem;">${track.pinned ? '📌' : '🎵'}</span>
            <span style="flex:1;font-size:0.9rem;color:var(--text-primary);">${escapeHtml(track.name)}</span>
            <button class="btn btn-sm btn-outline" onclick="previewMusic('${escapeHtml(track.file)}')" title="Preview" style="padding:4px 8px;font-size:0.75rem;">
                ▶
            </button>
            <button class="btn btn-sm ${track.pinned ? 'btn-save' : 'btn-outline'}" onclick="pinMusic(${track.id})" title="${track.pinned ? 'Unpin' : 'Pin this track'}" style="padding:4px 8px;font-size:0.75rem;">
                📌
            </button>
            <button class="cd-delete-btn" onclick="deleteMusic(${track.id})" title="Remove">✕</button>
        </div>
    `).join('');
}

let currentAudioPreview = null;
function previewMusic(file) {
    if (currentAudioPreview) {
        currentAudioPreview.pause();
        currentAudioPreview = null;
        return;
    }
    currentAudioPreview = new Audio(`/assets/music/${file}`);
    currentAudioPreview.volume = 0.5;
    currentAudioPreview.play();
    currentAudioPreview.addEventListener('ended', () => { currentAudioPreview = null; });
}

async function uploadMusic(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = ''; // reset for re-upload

    const name = prompt('Track name:', file.name.replace(/\.[^.]+$/, ''));
    if (!name) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name);

    showToast('Uploading music...', 'info');
    try {
        const res = await fetch('/upload-music', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            cdConfig.music.push(data.track);
            renderMusicPool();
            showToast(`"${data.track.name}" added to music pool!`, 'success');
        } else {
            showToast(data.error || 'Upload failed', 'error');
        }
    } catch (e) {
        showToast('Upload error: ' + e.message, 'error');
    }
}

async function pinMusic(id) {
    const tracks = cdConfig.music || [];
    tracks.forEach(t => {
        if (t.id === id) {
            t.pinned = !t.pinned;
        } else {
            t.pinned = false; // only one pinned at a time
        }
    });
    renderMusicPool();
    // Auto-save pin state
    try {
        await fetch('/agent-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ music: cdConfig.music })
        });
    } catch (e) { console.error('Pin save error:', e); }
}

async function deleteMusic(id) {
    if (!confirm('Delete this music track?')) return;
    try {
        const res = await fetch(`/data/music/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            cdConfig.music = cdConfig.music.filter(t => t.id !== id);
            renderMusicPool();
            showToast('Track removed', 'info');
        } else {
            showToast(data.error || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Delete error: ' + e.message, 'error');
    }
}

// ==================== BILLING ====================
function initBillingUI() {
    const upgradeBtn = document.getElementById('upgradeBtn');
    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', () => showUpgradeModal());
    }
    // Close user menu on outside click
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('userMenu');
        if (menu && !menu.contains(e.target)) {
            menu.classList.remove('open');
        }
    });
}

function showUpgradeModal() {
    const overlay = document.getElementById('setupOverlay');
    const modal = document.getElementById('setupModal');
    const title = document.getElementById('setupTitle');
    const body = document.getElementById('setupBody');
    const footer = document.getElementById('setupFooter');

    title.textContent = 'Upgrade Plan';
    const user = getAuthUser();
    const currentPlan = user?.plan || 'starter';

    const plans = [
        { id: 'starter', name: 'Starter', price: 29, runs: 15 },
        { id: 'pro', name: 'Pro', price: 49, runs: 30 },
        { id: 'premium', name: 'Premium', price: 79, runs: 60 },
    ];

    body.innerHTML = `
        <div class="upgrade-plans">
            ${plans.map(p => `
                <div class="upgrade-plan-card ${p.id === currentPlan ? 'current' : ''}" data-plan="${p.id}">
                    <div class="upgrade-plan-name">${p.name}</div>
                    <div class="upgrade-plan-price">$${p.price}<span>/mo</span></div>
                    <div class="upgrade-plan-runs">${p.runs} runs/month</div>
                    ${p.id === currentPlan
                        ? '<button class="btn btn-sm" disabled>Current Plan</button>'
                        : `<button class="btn btn-sm btn-primary" onclick="handleUpgrade('${p.id}')">
                            ${plans.findIndex(x => x.id === p.id) > plans.findIndex(x => x.id === currentPlan) ? 'Upgrade' : 'Downgrade'}
                           </button>`
                    }
                </div>
            `).join('')}
        </div>
    `;
    footer.innerHTML = '<button class="btn btn-sm" onclick="closeSetupModal()">Close</button>';
    overlay.classList.add('active');
}

async function handleUpgrade(plan) {
    showToast('Redirecting to checkout...', 'info');
    try {
        const res = await fetch('/billing/create-checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ plan })
        });
        const data = await res.json();
        if (data.url) {
            window.location.href = data.url;
        } else if (data.message) {
            showToast(data.message, 'info');
            closeSetupModal();
        } else {
            showToast(data.error || 'Checkout failed', 'error');
        }
    } catch (e) {
        showToast('Billing error: ' + e.message, 'error');
    }
}

/* =====================================================
   iPHONE MODE + CHARACTER CARD SYSTEM
   ===================================================== */

// ==================== iPHONE MODE STATE ====================
let activeSocialCharacterId = null;
let savedLooks = [];
let calendarData = { slots: [], frequency: 'daily' };
let selectedLookId = null;
const CALENDAR_TIMES = ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00'];
const CALENDAR_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

let iphoneState = {
    active: false,
    currentTab: 0,
    cards: [],
    selectedCardIds: [],
    scenes: [],
    voices: [],
    currentCardId: null,
    cardFormStep: 1,
    editingCardId: null,
    scheduleCardIds: [],
    touchStartX: 0,
    touchStartY: 0,
    isDragging: false,
    cardImageFile: null,
    cardGenSessionId: null,
    cardGenImages: [],
    cardGenSelectedIndex: null,
    cardGenPollTimer: null,
    klingPreset: null,
    motionRefFile: null,
    motionRefUrl: null,
};

// ==================== iPHONE MODE TOGGLE ====================
function toggleiPhoneMode() {
    iphoneState.active = !iphoneState.active;
    const overlay = document.getElementById('iphoneOverlay');
    const toggle = document.getElementById('iphoneToggle');
    if (iphoneState.active) {
        overlay.classList.add('active');
        toggle.classList.add('active');
        updateIphoneTime();
        loadCharacterCards();
        loadIphoneSchedule();
        loadIphoneSocialStatus();
        initIphoneSwipe();
    } else {
        overlay.classList.remove('active');
        toggle.classList.remove('active');
    }
}

function updateIphoneTime() {
    const el = document.getElementById('iphoneTime');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (iphoneState.active) setTimeout(updateIphoneTime, 30000);
}

// ==================== SWIPE DETECTION ====================
function initIphoneSwipe() {
    const viewport = document.querySelector('.iphone-screens-viewport');
    if (!viewport || viewport._swipeInit) return;
    viewport._swipeInit = true;

    viewport.addEventListener('touchstart', (e) => {
        iphoneState.touchStartX = e.touches[0].clientX;
        iphoneState.touchStartY = e.touches[0].clientY;
        iphoneState.isDragging = false;
    }, { passive: true });

    viewport.addEventListener('touchmove', (e) => {
        const dx = e.touches[0].clientX - iphoneState.touchStartX;
        const dy = e.touches[0].clientY - iphoneState.touchStartY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
            iphoneState.isDragging = true;
        }
    }, { passive: true });

    viewport.addEventListener('touchend', (e) => {
        if (!iphoneState.isDragging) return;
        const dx = e.changedTouches[0].clientX - iphoneState.touchStartX;
        if (Math.abs(dx) > 50) {
            if (dx < 0 && iphoneState.currentTab < 3) {
                switchIphoneTab(iphoneState.currentTab + 1);
            } else if (dx > 0 && iphoneState.currentTab > 0) {
                switchIphoneTab(iphoneState.currentTab - 1);
            }
        }
        iphoneState.isDragging = false;
    }, { passive: true });

    // Mouse drag support
    let mouseDown = false;
    viewport.addEventListener('mousedown', (e) => {
        mouseDown = true;
        iphoneState.touchStartX = e.clientX;
    });
    viewport.addEventListener('mousemove', (e) => {
        if (!mouseDown) return;
        const dx = e.clientX - iphoneState.touchStartX;
        if (Math.abs(dx) > 10) iphoneState.isDragging = true;
    });
    viewport.addEventListener('mouseup', (e) => {
        if (!mouseDown) return;
        mouseDown = false;
        if (!iphoneState.isDragging) return;
        const dx = e.clientX - iphoneState.touchStartX;
        if (Math.abs(dx) > 50) {
            if (dx < 0 && iphoneState.currentTab < 3) {
                switchIphoneTab(iphoneState.currentTab + 1);
            } else if (dx > 0 && iphoneState.currentTab > 0) {
                switchIphoneTab(iphoneState.currentTab - 1);
            }
        }
        iphoneState.isDragging = false;
    });
}

function switchIphoneTab(index) {
    iphoneState.currentTab = index;
    const screens = document.getElementById('iphoneScreens');
    screens.style.transform = `translateX(-${index * 25}%)`;
    document.querySelectorAll('.iphone-tab').forEach((tab, i) => {
        tab.classList.toggle('active', i === index);
    });
}

// ==================== CHARACTER CARDS API ====================
async function loadCharacterCards(search, category) {
    try {
        let url = '/api/cards?';
        if (search) url += `search=${encodeURIComponent(search)}&`;
        if (category) url += `category=${encodeURIComponent(category)}&`;
        const res = await fetch(url, { headers: authHeaders() });
        if (!res.ok) throw new Error('Failed to load cards');
        iphoneState.cards = await res.json();
        renderCardGrid();
        populateCdCharacterDropdown();
    } catch (e) {
        console.error('Load cards error:', e);
    }
}

function filterCards(searchValue, ctx) {
    const prefix = ctx === 'dash' ? 'dash' : '';
    const searchId = prefix ? 'dashCardSearchInput' : 'cardSearchInput';
    const catId = prefix ? 'dashCardCategoryFilter' : 'cardCategoryFilter';
    const search = searchValue || document.getElementById(searchId)?.value || '';
    const category = document.getElementById(catId)?.value || '';
    loadCharacterCards(search, category);
}

function renderCardGrid() {
    const targets = [
        { gridId: 'characterCardGrid', emptyId: 'cardGridEmpty' },
        { gridId: 'dashCharacterCardGrid', emptyId: 'dashCardGridEmpty' },
    ];

    // Classic card HTML (for iPhone/legacy grids)
    const cardsHtml = iphoneState.cards.map(card => {
        const isSelected = iphoneState.selectedCardIds.includes(card.id);
        const thumbUrl = card.thumbnail_url || card.character_data?.referenceImageUrl;
        const thumbHtml = thumbUrl
            ? `<img src="${thumbUrl}" alt="${card.name}" loading="lazy" onerror="this.style.display='none'">`
            : `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(198,166,100,0.2)" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
        return `
        <div class="character-card ${isSelected ? 'selected' : ''}" data-card-id="${card.id}"
             onclick="handleCardClick('${card.id}')" ondblclick="openCardDetail('${card.id}')">
            <div class="character-card-check">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div class="character-card-thumb">${thumbHtml}</div>
            <div class="character-card-info">
                <p class="character-card-name">${card.name}</p>
                <div class="character-card-meta">
                    <span class="character-card-badge">${card.category || 'general'}</span>
                    <span>${card.use_count || 0} uses</span>
                </div>
            </div>
        </div>`;
    }).join('');

    targets.forEach(({ gridId, emptyId }) => {
        const grid = document.getElementById(gridId);
        const empty = document.getElementById(emptyId);
        if (!grid) return;

        // Remove skeleton loading placeholders
        grid.querySelectorAll('.cc-skeleton-char').forEach(s => s.remove());

        // Sidebar workspace grid uses compact thumbnail cards
        if (gridId === 'dashCharacterCardGrid' && grid.classList.contains('cc-char-grid')) {
            const addTile = `<div class="cc-char-add-tile" onclick="openCreateCardModal()" title="Create New Character">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span>New</span>
            </div>`;
            if (empty) empty.style.display = iphoneState.cards.length === 0 ? 'flex' : 'none';
            grid.innerHTML = addTile + iphoneState.cards.map(card => {
                const isSelected = iphoneState.selectedCardIds.includes(card.id);
                const thumbUrl = card.thumbnail_url || card.character_data?.referenceImageUrl;
                return `<div class="cc-char-thumb ${isSelected ? 'selected' : ''}"
                             data-card-id="${card.id}"
                             onclick="handleCardClick('${card.id}')"
                             ondblclick="openCardDetail('${card.id}')"
                             title="${escapeHtml(card.name)}">
                    <button class="cc-char-delete" onclick="deleteCard('${card.id}', event)" title="Delete">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                    ${thumbUrl
                        ? `<img src="${thumbUrl}" alt="${escapeHtml(card.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
                        : ''
                    }
                    <span class="cc-char-initial" ${thumbUrl ? 'style="display:none"' : ''}>${(card.name || '?')[0].toUpperCase()}</span>
                    <span class="cc-char-name-tag">${escapeHtml(card.name || '')}</span>
                </div>`;
            }).join('');
            // Also render carousel
            renderCarousel();
            return;
        }

        if (iphoneState.cards.length === 0) {
            grid.innerHTML = '';
            if (empty) { grid.appendChild(empty); empty.style.display = 'flex'; }
            return;
        }
        if (empty) empty.style.display = 'none';
        grid.innerHTML = cardsHtml;
    });

    // Always render carousel when cards change
    renderCarousel();
}

// ==================== CAROUSEL ====================
function renderCarousel() {
    const track = document.getElementById('ccCarouselTrack');
    if (!track) return;
    track.innerHTML = iphoneState.cards.map(card => {
        const isSelected = iphoneState.selectedCardIds.includes(card.id);
        const thumbUrl = card.thumbnail_url || card.character_data?.referenceImageUrl;
        return `<div class="cc-carousel-card ${isSelected ? 'selected' : ''}"
                     data-card-id="${card.id}"
                     onclick="handleCardClick('${card.id}')"
                     title="${escapeHtml(card.name)}">
            ${thumbUrl
                ? `<img src="${thumbUrl}" alt="${escapeHtml(card.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
                : ''
            }
            <span class="cc-carousel-initial" ${thumbUrl ? 'style="display:none"' : ''}>${(card.name || '?')[0].toUpperCase()}</span>
            <span class="cc-carousel-name">${escapeHtml(card.name || '')}</span>
        </div>`;
    }).join('');
}

function scrollCarousel(direction) {
    const track = document.getElementById('ccCarouselTrack');
    if (!track) return;
    const scrollAmount = 240;
    track.scrollBy({ left: direction * scrollAmount, behavior: 'smooth' });
}

function handleCardClick(cardId) {
    const idx = iphoneState.selectedCardIds.indexOf(cardId);
    if (idx > -1) {
        iphoneState.selectedCardIds.splice(idx, 1);
    } else {
        iphoneState.selectedCardIds.push(cardId);
    }
    // Track active social character (last selected card)
    const lastSelected = iphoneState.selectedCardIds[iphoneState.selectedCardIds.length - 1];
    if (lastSelected !== activeSocialCharacterId) {
        activeSocialCharacterId = lastSelected || null;
        loadSocialStatus(); // Reload social status for this character
    }
    renderCardGrid();
    updateStudioCardBar();
    updateMainPreview();
}

// ==================== MAIN PREVIEW UPDATE ====================
function updateMainPreview() {
    const previewImg = document.getElementById('ccPreviewImage');
    const placeholder = document.getElementById('ccPreviewPlaceholder');
    const nameEl = document.getElementById('ccPreviewName');
    if (!previewImg || !placeholder) return;

    // Show the last selected card in preview
    const lastId = iphoneState.selectedCardIds[iphoneState.selectedCardIds.length - 1];
    const card = lastId ? iphoneState.cards.find(c => c.id === lastId) : null;

    const bioEl = document.getElementById('ccPreviewBio');
    const bioPersonality = document.getElementById('ccBioPersonality');
    const bioLocation = document.getElementById('ccBioLocation');

    if (card) {
        const thumbUrl = card.thumbnail_url || card.character_data?.referenceImageUrl;
        if (thumbUrl) {
            previewImg.src = thumbUrl;
            previewImg.style.display = 'block';
            placeholder.style.display = 'none';
        } else {
            previewImg.style.display = 'none';
            placeholder.style.display = 'flex';
        }
        if (nameEl) nameEl.textContent = card.name || '';

        // Show bio snippet if available
        const cd = card.character_data || {};
        if (bioEl && (cd.personality || cd.location)) {
            bioEl.style.display = 'flex';
            if (bioPersonality) bioPersonality.textContent = cd.personality ? cd.personality.substring(0, 60) + (cd.personality.length > 60 ? '...' : '') : '';
            if (bioLocation) bioLocation.textContent = cd.location || '';
        } else if (bioEl) {
            bioEl.style.display = 'none';
        }

        // Show/hide agent theme row based on whether character has bio data
        const themeRow = document.getElementById('ccAgentThemeRow');
        if (themeRow) {
            themeRow.style.display = (cd.bio || cd.personality || cd.backstory) ? 'flex' : 'none';
        }
    } else {
        previewImg.style.display = 'none';
        placeholder.style.display = 'flex';
        if (nameEl) nameEl.textContent = '';
        if (bioEl) bioEl.style.display = 'none';
        const themeRow = document.getElementById('ccAgentThemeRow');
        if (themeRow) themeRow.style.display = 'none';
    }
}

// ==================== CARD DETAIL ====================
async function openCardDetail(cardId) {
    try {
        const res = await fetch(`/api/cards/${cardId}`, { headers: authHeaders() });
        if (!res.ok) throw new Error('Card not found');
        const card = await res.json();
        iphoneState.currentCardId = cardId;

        const cd = card.character_data || {};
        const body = document.getElementById('cardDetailBody');
        document.getElementById('cardDetailTitle').textContent = card.name;

        let imagesHtml = '';
        if (card.images && card.images.length) {
            imagesHtml = `<div class="card-detail-section"><h4>Images</h4><div class="card-detail-images">
                ${card.images.map(img => `<img src="${img.url}" alt="ref">`).join('')}
            </div></div>`;
        }

        // Build bio sections HTML
        let bioHtml = '';
        if (cd.bio || cd.personality || cd.backstory || cd.location || cd.interests || cd.humorStyle || cd.catchphrases || cd.contentVoice) {
            bioHtml = `
            <div class="card-detail-section card-detail-bio-header">
                <h4>Bio & Personality</h4>
            </div>
            ${cd.bio ? `<div class="card-detail-section"><h4>Bio</h4><p>${cd.bio}</p></div>` : ''}
            ${cd.personality ? `<div class="card-detail-section"><h4>Personality</h4><p>${cd.personality}</p></div>` : ''}
            ${cd.backstory ? `<div class="card-detail-section"><h4>Backstory</h4><p>${cd.backstory}</p></div>` : ''}
            ${cd.location ? `<div class="card-detail-section"><h4>Location</h4><p>${cd.location}</p></div>` : ''}
            ${cd.interests ? `<div class="card-detail-section"><h4>Interests</h4><p>${cd.interests}</p></div>` : ''}
            ${cd.humorStyle ? `<div class="card-detail-section"><h4>Humor Style</h4><p>${cd.humorStyle}</p></div>` : ''}
            ${cd.catchphrases ? `<div class="card-detail-section"><h4>Catchphrases</h4><p>${cd.catchphrases.replace(/\n/g, '<br>')}</p></div>` : ''}
            ${cd.contentVoice ? `<div class="card-detail-section"><h4>Content Voice</h4><p>${cd.contentVoice}</p></div>` : ''}`;
        }

        body.innerHTML = `
        <div class="card-detail-grid">
            <div class="card-detail-section">
                <h4>Description</h4>
                <p>${card.description || 'No description'}</p>
            </div>
            ${bioHtml}
            <div class="card-detail-section">
                <h4>Appearance</h4>
                <p>${cd.appearance || 'Not defined'}</p>
            </div>
            <div class="card-detail-section">
                <h4>Style</h4>
                <p>${cd.style || 'Not defined'}</p>
            </div>
            <div class="card-detail-section">
                <h4>Default Outfit</h4>
                <p>${cd.outfit || 'Not defined'}</p>
            </div>
            <div class="card-detail-section">
                <h4>Prompt Template</h4>
                <p>${cd.promptTemplate || 'Not defined'}</p>
            </div>
            ${card.voice ? `<div class="card-detail-section"><h4>Voice</h4><p>${card.voice.voice_name || card.voice.voice_id} (${card.voice.provider})</p></div>` : ''}
            ${imagesHtml}
            <div class="card-detail-section">
                <h4>Stats</h4>
                <p>Category: ${card.category || 'general'} | Uses: ${card.use_count || 0} | Tags: ${(card.tags || []).join(', ') || 'none'}</p>
            </div>
        </div>`;

        document.getElementById('cardDetailOverlay').style.display = 'flex';
    } catch (e) {
        showToast('Failed to load card: ' + e.message, 'error');
    }
}

function closeCardDetailModal() {
    document.getElementById('cardDetailOverlay').style.display = 'none';
}

async function editCurrentCard() {
    closeCardDetailModal();
    const card = iphoneState.cards.find(c => c.id === iphoneState.currentCardId);
    if (!card) return;
    openCreateCardModal(card);
}

async function cloneCurrentCard() {
    try {
        const res = await fetch(`/api/cards/${iphoneState.currentCardId}/clone`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({})
        });
        if (!res.ok) throw new Error('Clone failed');
        showToast('Card cloned successfully', 'success');
        closeCardDetailModal();
        loadCharacterCards();
    } catch (e) {
        showToast('Clone error: ' + e.message, 'error');
    }
}

async function generateCurrentCardThumbnail() {
    showToast('Generating thumbnail...', 'info');
    try {
        const res = await fetch(`/api/cards/${iphoneState.currentCardId}/generate-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
        });
        if (!res.ok) throw new Error('Generation failed');
        const data = await res.json();
        showToast('Thumbnail generated!', 'success');
        closeCardDetailModal();
        loadCharacterCards();
    } catch (e) {
        showToast('Thumbnail error: ' + e.message, 'error');
    }
}

async function deleteCurrentCard() {
    if (!confirm('Delete this character card? This cannot be undone.')) return;
    try {
        const res = await fetch(`/api/cards/${iphoneState.currentCardId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        if (!res.ok) throw new Error('Delete failed');
        showToast('Card deleted', 'success');
        iphoneState.selectedCardIds = iphoneState.selectedCardIds.filter(id => id !== iphoneState.currentCardId);
        closeCardDetailModal();
        loadCharacterCards();
        updateStudioCardBar();
    } catch (e) {
        showToast('Delete error: ' + e.message, 'error');
    }
}

async function deleteCard(cardId, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (!confirm('Delete this character card? This cannot be undone.')) return;
    try {
        const res = await fetch(`/api/cards/${cardId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        if (!res.ok) throw new Error('Delete failed');
        showToast('Card deleted', 'success');
        iphoneState.selectedCardIds = iphoneState.selectedCardIds.filter(id => id !== cardId);
        loadCharacterCards();
        updateStudioCardBar();
    } catch (e) {
        showToast('Delete error: ' + e.message, 'error');
    }
}

// ==================== CREATE/EDIT CARD MODAL ====================
function openCreateCardModal(existingCard) {
    iphoneState.cardFormStep = 1;
    iphoneState.editingCardId = existingCard?.id || null;

    // Reset portrait generation state
    if (iphoneState.cardGenPollTimer) clearInterval(iphoneState.cardGenPollTimer);
    iphoneState.cardGenSessionId = null;
    iphoneState.cardGenImages = [];
    iphoneState.cardGenSelectedIndex = null;
    iphoneState.cardGenPollTimer = null;

    document.getElementById('cardModalTitle').textContent = existingCard ? 'Edit Character Card' : 'Create Character Card';

    // Fill form fields
    document.getElementById('cardName').value = existingCard?.name || '';
    document.getElementById('cardDescription').value = existingCard?.description || '';
    document.getElementById('cardCategory').value = existingCard?.category || 'general';
    document.getElementById('cardTags').value = (existingCard?.tags || []).join(', ');

    const cd = existingCard?.character_data || {};
    document.getElementById('cardAppearance').value = cd.appearance || '';
    document.getElementById('cardStyle').value = cd.style || '';
    document.getElementById('cardOutfit').value = cd.outfit || '';
    document.getElementById('cardPromptTemplate').value = cd.promptTemplate || '';

    // Bio fields
    document.getElementById('cardBio').value = cd.bio || '';
    document.getElementById('cardPersonality').value = cd.personality || '';
    document.getElementById('cardBackstory').value = cd.backstory || '';
    document.getElementById('cardLocation').value = cd.location || '';
    document.getElementById('cardInterests').value = cd.interests || '';
    document.getElementById('cardHumorStyle').value = cd.humorStyle || '';
    document.getElementById('cardCatchphrases').value = cd.catchphrases || '';
    document.getElementById('cardContentVoice').value = cd.contentVoice || '';

    // Reset image grid
    const grid = document.getElementById('cardGenImageGrid');
    if (grid) grid.innerHTML = '';
    const useBtn = document.getElementById('cardGenUseSelectedBtn');
    if (useBtn) useBtn.disabled = true;

    updateCardFormStep(1);
    loadVoicesForCardForm();
    initCardImageUpload();
    document.getElementById('cardModalOverlay').style.display = 'flex';
}

function closeCardModal() {
    document.getElementById('cardModalOverlay').style.display = 'none';
    iphoneState.editingCardId = null;
    iphoneState.cardImageFile = null;
    // Clean up portrait generation polling
    if (iphoneState.cardGenPollTimer) {
        clearInterval(iphoneState.cardGenPollTimer);
        iphoneState.cardGenPollTimer = null;
    }
}

function initCardImageUpload() {
    iphoneState.cardImageFile = null;
    const zone = document.getElementById('cardImageUploadZone');
    const input = document.getElementById('cardImageFileInput');
    const preview = document.getElementById('cardImagePreview');
    if (!zone || !input) return;
    if (preview) preview.style.display = 'none';
    document.getElementById('cardImagePreviewImg').src = '';

    // Remove old listeners by cloning
    const newZone = zone.cloneNode(true);
    zone.parentNode.replaceChild(newZone, zone);
    const newInput = newZone.querySelector('#cardImageFileInput');

    newZone.addEventListener('click', () => newInput.click());
    newInput.addEventListener('change', (e) => {
        if (e.target.files[0]) handleCardImageFile(e.target.files[0]);
    });
    newZone.addEventListener('dragover', (e) => { e.preventDefault(); newZone.classList.add('drag-over'); });
    newZone.addEventListener('dragleave', () => newZone.classList.remove('drag-over'));
    newZone.addEventListener('drop', (e) => {
        e.preventDefault();
        newZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) handleCardImageFile(e.dataTransfer.files[0]);
    });
}

function handleCardImageFile(file) {
    if (!file.type.startsWith('image/')) { showToast('Please select an image file', 'error'); return; }
    iphoneState.cardImageFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById('cardImagePreview');
        const img = document.getElementById('cardImagePreviewImg');
        if (img) img.src = e.target.result;
        if (preview) preview.style.display = 'flex';
        const zone = document.getElementById('cardImageUploadZone');
        if (zone) zone.style.display = 'none';
    };
    reader.readAsDataURL(file);
}

function clearCardImageUpload() {
    iphoneState.cardImageFile = null;
    const preview = document.getElementById('cardImagePreview');
    const zone = document.getElementById('cardImageUploadZone');
    if (preview) preview.style.display = 'none';
    if (zone) zone.style.display = 'flex';
    document.getElementById('cardImagePreviewImg').src = '';
}

// ==================== CARD PORTRAIT GENERATION ====================
async function generateCardPortraits() {
    const appearance = document.getElementById('cardAppearance').value.trim();
    const style = document.getElementById('cardStyle').value.trim();
    if (!appearance) {
        showToast('Please enter an appearance description first', 'error');
        return;
    }

    const btn = document.getElementById('cardGenPortraitsBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }

    try {
        const res = await fetch('/api/cards/generate-portraits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ appearance, style }),
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Generation failed', 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4h7.6l-6 4.6 2.3 7-6.3-4.6-6.3 4.6 2.3-7-6-4.6h7.6z"/></svg> Generate Portraits (1 credit)'; }
            return;
        }

        iphoneState.cardGenSessionId = data.sessionId;
        iphoneState.cardGenImages = [];
        iphoneState.cardGenSelectedIndex = null;

        // Move to step 3 and show the image grid
        updateCardFormStep(3);
        resetCardGenImageGrid(6);
        startCardGenPolling();
        refreshUserProfile();
    } catch (err) {
        showToast('Network error: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4h7.6l-6 4.6 2.3 7-6.3-4.6-6.3 4.6 2.3-7-6-4.6h7.6z"/></svg> Generate Portraits (1 credit)'; }
    }
}

function resetCardGenImageGrid(count) {
    const grid = document.getElementById('cardGenImageGrid');
    if (!grid) return;
    grid.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const cell = document.createElement('div');
        cell.className = 'card-gen-image-cell loading';
        cell.innerHTML = '<div class="card-gen-spinner"></div>';
        grid.appendChild(cell);
    }
}

function startCardGenPolling() {
    if (iphoneState.cardGenPollTimer) clearInterval(iphoneState.cardGenPollTimer);
    iphoneState.cardGenPollTimer = setInterval(pollCardGenStatus, 3000);
    pollCardGenStatus();
}

async function pollCardGenStatus() {
    if (!iphoneState.cardGenSessionId) return;
    try {
        const res = await fetch(`/api/cards/portrait-status/${iphoneState.cardGenSessionId}`, {
            headers: authHeaders(),
        });
        if (!res.ok) return;
        const data = await res.json();

        // Update progress bar
        const fill = document.getElementById('cardGenProgressFill');
        const text = document.getElementById('cardGenProgressText');
        const pct = data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0;
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = data.status === 'complete' ? 'Complete!' : `Generating... ${data.completed}/${data.total}`;

        // Update grid progressively
        const grid = document.getElementById('cardGenImageGrid');
        if (grid && data.images) {
            const cells = grid.children;
            while (cells.length < data.total) {
                const cell = document.createElement('div');
                cell.className = 'card-gen-image-cell loading';
                cell.innerHTML = '<div class="card-gen-spinner"></div>';
                grid.appendChild(cell);
            }

            for (let i = 0; i < data.images.length; i++) {
                const img = data.images[i];
                const cell = cells[i];
                if (!cell || cell.dataset.loaded) continue;

                if (img.url) {
                    cell.classList.remove('loading');
                    cell.innerHTML = `<img src="${img.url}" alt="Portrait ${i + 1}">`;
                    cell.dataset.loaded = 'true';
                    cell.onclick = () => selectCardGenImage(i);
                } else if (img.failed) {
                    cell.classList.remove('loading');
                    cell.classList.add('failed');
                    cell.innerHTML = '<span class="card-gen-cell-failed">Failed</span>';
                    cell.dataset.loaded = 'true';
                }
            }

            iphoneState.cardGenImages = data.images;
        }

        if (data.status === 'complete' || data.status === 'error') {
            clearInterval(iphoneState.cardGenPollTimer);
            iphoneState.cardGenPollTimer = null;
            if (data.status === 'error') {
                showToast('Some images failed to generate: ' + (data.error || ''), 'error');
            }
        }
    } catch (err) {
        console.warn('[cardGen] Poll error:', err.message);
    }
}

function selectCardGenImage(index) {
    iphoneState.cardGenSelectedIndex = index;
    const grid = document.getElementById('cardGenImageGrid');
    if (!grid) return;
    Array.from(grid.children).forEach((cell, i) => {
        cell.classList.toggle('selected', i === index);
    });
    const useBtn = document.getElementById('cardGenUseSelectedBtn');
    if (useBtn) useBtn.disabled = false;
}

function useSelectedCardImage() {
    if (iphoneState.cardGenSelectedIndex === null) {
        showToast('Please select an image first', 'error');
        return;
    }
    // Advance to voice step (step 4)
    updateCardFormStep(4);
}

async function generateMoreCardPortraits() {
    const btn = document.getElementById('cardGenMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }

    try {
        const res = await fetch('/api/cards/generate-more-portraits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ sessionId: iphoneState.cardGenSessionId }),
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Generation failed', 'error');
            if (btn) { btn.disabled = false; btn.textContent = 'Generate More (1 credit)'; }
            return;
        }

        // Reset progress and restart polling
        const fill = document.getElementById('cardGenProgressFill');
        const text = document.getElementById('cardGenProgressText');
        if (fill) fill.style.width = '0%';
        if (text) text.textContent = 'Generating more...';
        startCardGenPolling();
        refreshUserProfile();
    } catch (err) {
        showToast('Network error: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Generate More (1 credit)'; }
    }
}

// ==================== KLING PRESETS + MOTION REFERENCE ====================
function selectKlingPreset(el, promptText) {
    // Toggle active state for both old .kling-preset-card and new .cc-preset-chip
    document.querySelectorAll('#klingPresetsGrid .kling-preset-card, #klingPresetsGrid .cc-preset-chip').forEach(c => c.classList.remove('active'));
    if (iphoneState.klingPreset === promptText) {
        iphoneState.klingPreset = null;
    } else {
        el.classList.add('active');
        iphoneState.klingPreset = promptText;
        // Fill the Scene Context textarea with the preset prompt
        const sceneEl = document.getElementById('dashSceneContextInput');
        if (sceneEl) sceneEl.value = promptText;
    }
}

function initMotionRefUpload() {
    iphoneState.motionRefFile = null;
    iphoneState.motionRefUrl = null;
    const zone = document.getElementById('motionRefUploadZone');
    const input = document.getElementById('motionRefFileInput');
    if (!zone || !input) return;

    const preview = document.getElementById('motionRefPreview');
    if (preview) preview.style.display = 'none';

    // Clone to remove old listeners
    const newZone = zone.cloneNode(true);
    zone.parentNode.replaceChild(newZone, zone);
    const newInput = newZone.querySelector('#motionRefFileInput');

    newZone.addEventListener('click', () => newInput.click());
    newInput.addEventListener('change', (e) => {
        if (e.target.files[0]) handleMotionRefFile(e.target.files[0]);
    });
    newZone.addEventListener('dragover', (e) => { e.preventDefault(); newZone.classList.add('drag-over'); });
    newZone.addEventListener('dragleave', () => newZone.classList.remove('drag-over'));
    newZone.addEventListener('drop', (e) => {
        e.preventDefault();
        newZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) handleMotionRefFile(e.dataTransfer.files[0]);
    });
}

function handleMotionRefFile(file) {
    if (!file.type.startsWith('video/')) { showToast('Please select a video file', 'error'); return; }
    if (file.size > 50 * 1024 * 1024) { showToast('Video too large (max 50MB)', 'error'); return; }
    iphoneState.motionRefFile = file;
    const url = URL.createObjectURL(file);
    const preview = document.getElementById('motionRefPreview');
    const video = document.getElementById('motionRefVideo');
    if (video) { video.src = url; video.play(); }
    if (preview) preview.style.display = 'flex';
    const zone = document.getElementById('motionRefUploadZone');
    if (zone) zone.style.display = 'none';
}

function clearMotionRef() {
    iphoneState.motionRefFile = null;
    iphoneState.motionRefUrl = null;
    const preview = document.getElementById('motionRefPreview');
    const zone = document.getElementById('motionRefUploadZone');
    const video = document.getElementById('motionRefVideo');
    if (video) { URL.revokeObjectURL(video.src); video.src = ''; }
    if (preview) preview.style.display = 'none';
    if (zone) zone.style.display = 'flex';
}

function cardFormNextStep() {
    const step = iphoneState.cardFormStep;

    if (step === 3) {
        // Step 3 = Appearance. If user uploaded an image, skip image selection (step 4) → go to voice (step 5)
        if (iphoneState.cardImageFile) {
            updateCardFormStep(5);
            return;
        }
        // If portraits are being generated or were already generated, go to step 4
        if (iphoneState.cardGenSessionId) {
            updateCardFormStep(4);
            return;
        }
        // No image and no generation — just advance normally
        updateCardFormStep(4);
        return;
    }

    if (step === 6) {
        saveCardFromForm();
        return;
    }

    updateCardFormStep(step + 1);
}

function cardFormPrevStep() {
    const step = iphoneState.cardFormStep;
    if (step <= 1) return;

    // If on voice (step 5) and user uploaded an image (skipped step 4), go back to step 3 (Appearance)
    if (step === 5 && iphoneState.cardImageFile && !iphoneState.cardGenSessionId) {
        updateCardFormStep(3);
        return;
    }

    updateCardFormStep(step - 1);
}

function updateCardFormStep(step) {
    iphoneState.cardFormStep = step;
    document.querySelectorAll('#cardFormSteps .form-step').forEach((el, i) => {
        el.classList.toggle('active', i === step - 1);
    });
    document.querySelectorAll('#cardFormDots .dot').forEach((el, i) => {
        el.classList.toggle('active', i === step - 1);
    });
    const prevBtn = document.getElementById('cardFormPrev');
    const nextBtn = document.getElementById('cardFormNext');
    prevBtn.style.display = step > 1 ? 'inline-flex' : 'none';

    // Step 4 (image selection) hides Next — user uses "Use Selected" instead
    if (step === 4) {
        nextBtn.style.display = 'none';
    } else {
        nextBtn.style.display = 'inline-flex';
        nextBtn.textContent = step === 6 ? 'Save' : 'Next';
    }

    // Load voices when entering step 5
    if (step === 5) loadVoicesForCardForm();
}

async function loadVoicesForCardForm() {
    try {
        const res = await fetch('/api/voices', { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        // Handle both array and { voices, error } response formats
        const voiceList = Array.isArray(data) ? data : (data.voices || []);
        iphoneState.voices = voiceList;
        const select = document.getElementById('cardVoiceSelect');
        select.innerHTML = '<option value="">No voice assigned</option>';
        if (voiceList.length === 0) {
            const errMsg = data.error || '';
            const opt = document.createElement('option');
            opt.value = '';
            opt.disabled = true;
            opt.textContent = errMsg ? `(No voices — ${errMsg})` : '(No voices available — check API key)';
            select.appendChild(opt);
            if (errMsg) console.warn('Voice loading:', errMsg);
        } else {
            voiceList.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v.voice_id;
                opt.textContent = `${v.name} (${v.category || 'premade'})`;
                select.appendChild(opt);
            });
        }
    } catch (e) {
        console.warn('Voice load failed:', e.message);
    }
}

async function previewSelectedVoice() {
    const voiceId = document.getElementById('cardVoiceSelect').value;
    if (!voiceId) { showToast('Select a voice first', 'info'); return; }
    showToast('Generating voice preview...', 'info');
    try {
        const res = await fetch('/api/voices/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ voice_id: voiceId, text: 'Hello, this is a preview of my voice.' }),
        });
        if (!res.ok) throw new Error('Preview failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.play();
    } catch (e) {
        showToast('Voice preview error: ' + e.message, 'error');
    }
}

async function saveCardFromForm() {
    const name = document.getElementById('cardName').value.trim();
    if (!name) { showToast('Name is required', 'error'); return; }

    // Determine thumbnail URL from generated portrait selection
    let generatedThumbnailUrl = null;
    if (iphoneState.cardGenSelectedIndex !== null && iphoneState.cardGenImages.length > 0) {
        const selectedImg = iphoneState.cardGenImages[iphoneState.cardGenSelectedIndex];
        if (selectedImg && selectedImg.url) {
            generatedThumbnailUrl = selectedImg.url;
        }
    }

    const tags = document.getElementById('cardTags').value.split(',').map(t => t.trim()).filter(Boolean);
    const cardData = {
        name,
        description: document.getElementById('cardDescription').value.trim(),
        category: document.getElementById('cardCategory').value,
        tags,
        character_data: {
            appearance: document.getElementById('cardAppearance').value.trim(),
            style: document.getElementById('cardStyle').value.trim(),
            outfit: document.getElementById('cardOutfit').value.trim(),
            promptTemplate: document.getElementById('cardPromptTemplate').value.trim(),
            referenceImageUrl: generatedThumbnailUrl || '',
            // Bio fields
            bio: document.getElementById('cardBio').value.trim(),
            personality: document.getElementById('cardPersonality').value.trim(),
            backstory: document.getElementById('cardBackstory').value.trim(),
            location: document.getElementById('cardLocation').value.trim(),
            interests: document.getElementById('cardInterests').value.trim(),
            humorStyle: document.getElementById('cardHumorStyle').value,
            catchphrases: document.getElementById('cardCatchphrases').value.trim(),
            contentVoice: document.getElementById('cardContentVoice').value.trim(),
        },
    };

    // Set thumbnail_url if we have a generated portrait
    if (generatedThumbnailUrl) {
        cardData.thumbnail_url = generatedThumbnailUrl;
    }

    try {
        let res;
        if (iphoneState.editingCardId) {
            res = await fetch(`/api/cards/${iphoneState.editingCardId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(cardData),
            });
        } else {
            res = await fetch('/api/cards', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(cardData),
            });
        }
        if (!res.ok) throw new Error('Save failed');
        const card = await res.json();

        // Save voice config if selected
        const voiceId = document.getElementById('cardVoiceSelect').value;
        if (voiceId) {
            const voice = iphoneState.voices.find(v => v.voice_id === voiceId);
            await fetch(`/api/cards/${card.id}/voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                    voice_id: voiceId,
                    voice_name: voice?.name || '',
                }),
            });
        }

        // Upload image if file was selected
        if (iphoneState.cardImageFile) {
            try {
                const formData = new FormData();
                formData.append('image', iphoneState.cardImageFile);
                const uploadRes = await fetch(`/api/cards/${card.id}/upload-image`, {
                    method: 'POST',
                    headers: authHeaders(),
                    body: formData,
                });
                if (!uploadRes.ok) console.warn('Image upload failed:', await uploadRes.text());
            } catch (ue) {
                console.warn('Image upload error:', ue.message);
            }
        }

        if (iphoneState.editingCardId) {
            showToast('Card updated!', 'success');
        } else {
            showToast('Card created! Scroll down to the Character Hub to select it, then use Video Studio to generate your first video.', 'success');
            setTimeout(() => {
                const hub = document.getElementById('dashCharacterHub');
                if (hub) hub.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 500);
        }
        closeCardModal();
        loadCharacterCards();
    } catch (e) {
        showToast('Save error: ' + e.message, 'error');
    }
}

// ==================== STUDIO (VIDEO GENERATION) ====================
function updateStudioCardBar() {
    const barIds = ['studioCardBar', 'dashStudioCardBar'];

    const chipsHtml = iphoneState.selectedCardIds.length === 0
        ? '<div class="studio-card-bar-empty">Select cards in Character Hub to get started</div>'
        : iphoneState.selectedCardIds.map(id => {
            const card = iphoneState.cards.find(c => c.id === id);
            if (!card) return '';
            const thumbSrc = card.thumbnail_url || card.character_data?.referenceImageUrl;
            const thumb = thumbSrc
                ? `<img src="${thumbSrc}" alt="${card.name}" onerror="this.style.display='none'">`
                : '';
            return `<div class="studio-card-chip">
                ${thumb}<span>${card.name}</span>
                <button class="remove-chip" onclick="event.stopPropagation();removeSelectedCard('${id}')">x</button>
            </div>`;
        }).join('');

    barIds.forEach(id => {
        const bar = document.getElementById(id);
        if (bar) bar.innerHTML = chipsHtml;
    });
}

function removeSelectedCard(cardId) {
    iphoneState.selectedCardIds = iphoneState.selectedCardIds.filter(id => id !== cardId);
    renderCardGrid();
    updateStudioCardBar();
}

async function previewComposedPrompt(ctx) {
    if (iphoneState.selectedCardIds.length === 0) {
        showToast('Select at least one character card', 'info');
        return;
    }
    const sceneId = ctx === 'dash' ? 'dashSceneContextInput' : 'sceneContextInput';
    const previewId = ctx === 'dash' ? 'dashStudioPromptPreview' : 'studioPromptPreview';
    const sceneContext = document.getElementById(sceneId)?.value || '';
    try {
        const res = await fetch('/api/cards/compose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                card_ids: iphoneState.selectedCardIds,
                scene_context: sceneContext,
            }),
        });
        if (!res.ok) throw new Error('Compose failed');
        const data = await res.json();
        const preview = document.getElementById(previewId);
        if (preview) {
            preview.textContent = data.composed_prompt;
            preview.style.color = 'rgba(255,255,255,0.8)';
        }
    } catch (e) {
        showToast('Compose error: ' + e.message, 'error');
    }
}

async function generateFromStudio(ctx) {
    if (iphoneState.selectedCardIds.length === 0) {
        showToast('Select at least one character card', 'info');
        return;
    }

    // Create a scene and generate
    const sceneId = ctx === 'dash' ? 'dashSceneContextInput' : 'sceneContextInput';
    const voiceId = ctx === 'dash' ? 'dashVoiceScriptInput' : 'voiceScriptInput';
    const sceneContext = document.getElementById(sceneId)?.value || '';
    const voiceScript = document.getElementById(voiceId)?.value || '';

    showToast('Submitting to pipeline...', 'info');
    // Activate Freepik-style glow ring
    const glowWrapper = document.getElementById('ccPromptGlowWrapper');
    if (glowWrapper) { glowWrapper.classList.add('generating'); glowWrapper.dataset.generating = 'true'; }
    try {
        // Upload motion reference if provided
        let motionReferenceUrl = iphoneState.motionRefUrl || null;
        if (iphoneState.motionRefFile && !motionReferenceUrl) {
            const formData = new FormData();
            formData.append('video', iphoneState.motionRefFile);
            const uploadRes = await fetch('/api/upload-motion-reference', {
                method: 'POST',
                headers: authHeaders(),
                body: formData,
            });
            if (uploadRes.ok) {
                const uploadData = await uploadRes.json();
                motionReferenceUrl = uploadData.url;
                iphoneState.motionRefUrl = motionReferenceUrl;
            } else {
                console.warn('Motion ref upload failed');
            }
        }

        // Create scene
        const sceneRes = await fetch('/api/scenes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                name: `Studio Scene ${new Date().toLocaleString()}`,
                settings: { context: sceneContext, voiceScript },
                characters: iphoneState.selectedCardIds.map((id, i) => ({
                    character_card_id: id,
                    prompt_order: i,
                })),
            }),
        });
        if (!sceneRes.ok) throw new Error('Scene creation failed');
        const scene = await sceneRes.json();

        // Use motion control model when a motion library reference is selected
        const videoModel = motionReferenceUrl && selectedMotionId
            ? 'kling-2.6/motion-control'
            : (state?.settings?.videoModel || 'kling-2.6/image-to-video');

        // Generate from scene
        const genRes = await fetch(`/api/scenes/${scene.id}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                llmProvider: state?.settings?.llmProvider || 'gemini',
                videoModel,
                videoDuration: state?.settings?.videoDuration || '5',
                platforms: [],
                voiceScript,
                motionReferenceUrl,
            }),
        });
        if (!genRes.ok) {
            const err = await genRes.json();
            throw new Error(err.error || 'Generation failed');
        }
        const result = await genRes.json();
        showToast(`Pipeline triggered!`, 'success');
        if (result.jobId) {
            startPipelineMonitor(result.jobId);
        }

        // Increment motion use count
        if (selectedMotionId) {
            fetch(`/api/motions/${selectedMotionId}/use`, { method: 'POST', headers: authHeaders() }).catch(() => {});
        }
    } catch (e) {
        showToast('Generation error: ' + e.message, 'error');
        // Deactivate glow ring on error
        const gw = document.getElementById('ccPromptGlowWrapper');
        if (gw) { gw.classList.remove('generating'); gw.dataset.generating = 'false'; }
    }
}

// ==================== SCHEDULE PLANNER ====================
async function loadIphoneSchedule() {
    try {
        const res = await fetch('/api/schedule', { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const toggle = document.getElementById('iphoneScheduleEnabled');
        if (toggle) toggle.checked = data.enabled || false;

        const pills = document.getElementById('scheduleTimePills');
        if (!pills) return;
        const times = ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '00:00'];
        const activeTimes = data.cron_times || [];
        pills.innerHTML = times.map(t => `
            <div class="schedule-time-pill ${activeTimes.includes(t) ? 'active' : ''}"
                 onclick="toggleScheduleTime(this, '${t}')">${t}</div>
        `).join('');
    } catch (e) {
        console.log('Schedule load error:', e.message);
    }
}

function toggleScheduleTime(el, time) {
    el.classList.toggle('active');
    saveIphoneSchedule();
}

async function saveIphoneSchedule() {
    const pills = document.querySelectorAll('#scheduleTimePills .schedule-time-pill.active');
    const times = Array.from(pills).map(p => p.textContent.trim());
    const enabled = document.getElementById('iphoneScheduleEnabled')?.checked || false;
    try {
        await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ cronTimes: times, enabled }),
        });
    } catch (e) {
        console.log('Schedule save error:', e.message);
    }
}

function openScheduleCardPicker() {
    showToast('Go to Character Hub and select cards first, then come back', 'info');
    switchIphoneTab(0);
}

// ==================== SETTINGS ====================
async function loadIphoneSocialStatus() {
    try {
        const res = await fetch('/social/status', { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const list = document.getElementById('iphoneSocialList');
        if (!list) return;
        const platforms = ['youtube', 'instagram', 'facebook', 'tiktok'];
        list.innerHTML = platforms.map(p => {
            const info = data[p];
            const connected = info?.connected || false;
            return `<div class="settings-social-item">
                <span>${p.charAt(0).toUpperCase() + p.slice(1)}</span>
                <span class="settings-social-badge ${connected ? 'connected' : 'disconnected'}">
                    ${connected ? 'Connected' : 'Not connected'}
                </span>
            </div>`;
        }).join('');
    } catch (e) {
        console.log('Social status load error:', e.message);
    }
}

async function testElevenLabsKey() {
    showToast('Testing ElevenLabs connection...', 'info');
    try {
        const res = await fetch('/api/voices', { headers: authHeaders() });
        if (!res.ok) throw new Error('Connection failed');
        const voices = await res.json();
        if (voices.length > 0) {
            showToast(`Connected! ${voices.length} voices available`, 'success');
        } else {
            showToast('Connected but no voices found. Check API key on server.', 'info');
        }
    } catch (e) {
        showToast('Connection failed: ' + e.message, 'error');
    }
}

// ==================== ONBOARDING ====================

const onboardingState = {
    mode: null,         // 'create' or 'clone'
    sessionId: null,
    images: [],
    selectedIndex: null,
    uploadedFiles: [],  // base64 data URLs
    pollTimer: null,
    voiceId: null,
    voiceName: null,
};

function showOnboarding() {
    const overlay = document.getElementById('onboardingOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
        showOnboardingStep(1);
    }
}

async function skipOnboarding() {
    try {
        await fetch('/api/onboarding/skip', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' } });
    } catch (e) { /* ignore */ }
    hideOnboarding();
    initFullDashboard();
}

function hideOnboarding() {
    const overlay = document.getElementById('onboardingOverlay');
    if (overlay) overlay.style.display = 'none';
    if (onboardingState.pollTimer) {
        clearInterval(onboardingState.pollTimer);
        onboardingState.pollTimer = null;
    }
}

function showOnboardingStep(step) {
    for (let i = 1; i <= 5; i++) {
        const el = document.getElementById(`onboardingStep${i}`);
        if (el) el.style.display = i === step ? 'flex' : 'none';
    }
}

function startOnboarding(mode) {
    onboardingState.mode = mode;
    onboardingState.images = [];
    onboardingState.selectedIndex = null;
    onboardingState.uploadedFiles = [];

    const titleEl = document.getElementById('onboardingStep2Title');
    const subtitleEl = document.getElementById('onboardingStep2Subtitle');
    const createInput = document.getElementById('onboardingCreateInput');
    const cloneInput = document.getElementById('onboardingCloneInput');

    if (mode === 'create') {
        if (titleEl) titleEl.textContent = 'Describe Your Character';
        if (subtitleEl) subtitleEl.textContent = 'Be detailed \u2014 include appearance, style, and aesthetic';
        if (createInput) createInput.style.display = 'block';
        if (cloneInput) cloneInput.style.display = 'none';
    } else {
        if (titleEl) titleEl.textContent = 'Upload Your Selfies';
        if (subtitleEl) subtitleEl.textContent = 'Upload 1-3 clear selfie photos for best results';
        if (createInput) createInput.style.display = 'none';
        if (cloneInput) cloneInput.style.display = 'block';
        initOnboardingUpload();
    }

    showOnboardingStep(2);
}

function initOnboardingUpload() {
    const zone = document.getElementById('onboardingUploadZone');
    const fileInput = document.getElementById('onboardingFileInput');
    if (!zone || !fileInput) return;

    zone.onclick = () => fileInput.click();

    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = () => zone.classList.remove('drag-over');
    zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        handleOnboardingFiles(e.dataTransfer.files);
    };

    fileInput.onchange = () => {
        if (fileInput.files.length > 0) handleOnboardingFiles(fileInput.files);
    };
}

function handleOnboardingFiles(fileList) {
    const files = Array.from(fileList).slice(0, 3);
    onboardingState.uploadedFiles = [];
    const previewContainer = document.getElementById('onboardingUploadPreviews');
    if (previewContainer) previewContainer.innerHTML = '';

    files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            onboardingState.uploadedFiles.push(e.target.result);
            if (previewContainer) {
                const img = document.createElement('img');
                img.src = e.target.result;
                img.className = 'onboarding-upload-preview-img';
                previewContainer.appendChild(img);
            }
        };
        reader.readAsDataURL(file);
    });
}

async function generateOnboardingImages() {
    const btn = document.getElementById('onboardingGenerateBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }

    let payload;
    if (onboardingState.mode === 'create') {
        const desc = document.getElementById('onboardingDescription')?.value?.trim();
        if (!desc) {
            showToast('Please enter a character description', 'error');
            if (btn) { btn.disabled = false; btn.textContent = 'Generate Portraits (1 credit)'; }
            return;
        }
        payload = { mode: 'create', description: desc };
    } else {
        if (onboardingState.uploadedFiles.length === 0) {
            showToast('Please upload at least one selfie photo', 'error');
            if (btn) { btn.disabled = false; btn.textContent = 'Generate Portraits (1 credit)'; }
            return;
        }
        // Upload the first selfie as a data URL reference
        payload = { mode: 'clone', referenceImageUrl: onboardingState.uploadedFiles[0], description: '' };
    }

    try {
        const res = await fetch('/api/onboarding/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Generation failed', 'error');
            if (btn) { btn.disabled = false; btn.textContent = 'Generate Portraits (1 credit)'; }
            return;
        }

        onboardingState.sessionId = data.sessionId;
        onboardingState.images = [];
        onboardingState.selectedIndex = null;

        // Show step 3 and start polling
        showOnboardingStep(3);
        resetOnboardingImageGrid(6);
        startOnboardingPolling();

        // Refresh user profile to update credits display
        refreshUserProfile();
    } catch (err) {
        showToast('Network error: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Generate Portraits (1 credit)'; }
    }
}

function resetOnboardingImageGrid(count) {
    const grid = document.getElementById('onboardingImageGrid');
    if (!grid) return;
    grid.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const cell = document.createElement('div');
        cell.className = 'onboarding-image-cell loading';
        cell.innerHTML = '<div class="onboarding-spinner"></div>';
        grid.appendChild(cell);
    }
}

function startOnboardingPolling() {
    if (onboardingState.pollTimer) clearInterval(onboardingState.pollTimer);
    onboardingState.pollTimer = setInterval(pollOnboardingStatus, 3000);
    // Also poll immediately
    pollOnboardingStatus();
}

async function pollOnboardingStatus() {
    if (!onboardingState.sessionId) return;
    try {
        const res = await fetch(`/api/onboarding/status/${onboardingState.sessionId}`, {
            headers: authHeaders(),
        });
        if (!res.ok) return;
        const data = await res.json();

        // Update progress bar
        const fill = document.getElementById('onboardingProgressFill');
        const text = document.getElementById('onboardingProgressText');
        const pct = data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0;
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = data.status === 'complete' ? 'Complete!' : `Generating... ${data.completed}/${data.total}`;

        // Update grid progressively
        const grid = document.getElementById('onboardingImageGrid');
        if (grid && data.images) {
            const cells = grid.children;
            // Ensure grid has enough cells
            while (cells.length < data.total) {
                const cell = document.createElement('div');
                cell.className = 'onboarding-image-cell loading';
                cell.innerHTML = '<div class="onboarding-spinner"></div>';
                grid.appendChild(cell);
            }

            for (let i = 0; i < data.images.length; i++) {
                const img = data.images[i];
                const cell = cells[i];
                if (!cell || cell.dataset.loaded) continue;

                if (img.url) {
                    cell.classList.remove('loading');
                    cell.innerHTML = `<img src="${img.url}" alt="Portrait ${i + 1}">`;
                    cell.dataset.loaded = 'true';
                    cell.onclick = () => selectOnboardingImage(i);
                } else if (img.failed) {
                    cell.classList.remove('loading');
                    cell.classList.add('failed');
                    cell.innerHTML = '<span class="onboarding-cell-failed">Failed</span>';
                    cell.dataset.loaded = 'true';
                }
            }

            onboardingState.images = data.images;
        }

        if (data.status === 'complete' || data.status === 'error') {
            clearInterval(onboardingState.pollTimer);
            onboardingState.pollTimer = null;
            if (data.status === 'error') {
                showToast('Some images failed to generate: ' + (data.error || ''), 'error');
            }
        }
    } catch (err) {
        console.warn('[onboarding] Poll error:', err.message);
    }
}

function selectOnboardingImage(index) {
    onboardingState.selectedIndex = index;
    const grid = document.getElementById('onboardingImageGrid');
    if (!grid) return;
    Array.from(grid.children).forEach((cell, i) => {
        cell.classList.toggle('selected', i === index);
    });
    const useBtn = document.getElementById('onboardingUseSelectedBtn');
    if (useBtn) useBtn.disabled = false;
}

async function generateMoreOnboarding() {
    const btn = document.getElementById('onboardingGenerateMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }

    try {
        const res = await fetch('/api/onboarding/generate-more', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ sessionId: onboardingState.sessionId }),
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Generation failed', 'error');
            if (btn) { btn.disabled = false; btn.textContent = 'Generate More (1 credit)'; }
            return;
        }

        // Update progress and restart polling
        const fill = document.getElementById('onboardingProgressFill');
        const text = document.getElementById('onboardingProgressText');
        if (fill) fill.style.width = '0%';
        if (text) text.textContent = 'Generating more...';
        startOnboardingPolling();
        refreshUserProfile();
    } catch (err) {
        showToast('Network error: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Generate More (1 credit)'; }
    }
}

function confirmOnboardingImage() {
    if (onboardingState.selectedIndex === null) {
        showToast('Please select an image first', 'error');
        return;
    }
    // Move to voice step
    showOnboardingStep(4);
    loadOnboardingVoices();
}

async function loadOnboardingVoices() {
    const select = document.getElementById('onboardingVoiceSelect');
    const previewBtn = document.getElementById('onboardingVoicePreviewBtn');
    const hint = document.getElementById('onboardingVoiceHint');
    try {
        const res = await fetch('/api/voices', { headers: authHeaders() });
        if (!res.ok) throw new Error('Failed to load voices');
        const data = await res.json();
        // Handle both array and { voices, error } response formats
        const voices = Array.isArray(data) ? data : (data.voices || []);
        if (select) {
            if (voices.length === 0) {
                select.innerHTML = '<option value="">No voices available</option>';
                select.disabled = true;
                if (previewBtn) previewBtn.disabled = true;
                const errMsg = data.error || '';
                if (hint) hint.textContent = errMsg ? `Voice loading: ${errMsg}` : 'Voice can be added later from the character card settings.';
            } else {
                select.innerHTML = '<option value="">-- No voice --</option>';
                voices.forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v.voice_id;
                    opt.textContent = v.name;
                    opt.dataset.previewUrl = v.preview_url || '';
                    select.appendChild(opt);
                });
                if (previewBtn) previewBtn.disabled = false;
                if (hint) hint.textContent = '';
            }
        }
    } catch (err) {
        if (select) {
            select.innerHTML = '<option value="">Voice loading failed</option>';
            select.disabled = true;
        }
        if (previewBtn) previewBtn.disabled = true;
        if (hint) hint.textContent = 'Voice can be added later from the character card settings.';
        console.warn('[onboarding] Voice load error:', err.message);
    }
}

function previewOnboardingVoice() {
    const select = document.getElementById('onboardingVoiceSelect');
    if (!select || !select.value) return;
    const option = select.options[select.selectedIndex];
    const previewUrl = option?.dataset?.previewUrl;
    if (previewUrl) {
        const audio = new Audio(previewUrl);
        audio.play().catch(() => showToast('Could not play preview', 'error'));
    }
}

function skipOnboardingVoice() {
    onboardingState.voiceId = null;
    onboardingState.voiceName = null;
    moveToOnboardingFinish();
}

function confirmOnboardingVoice() {
    const select = document.getElementById('onboardingVoiceSelect');
    if (select && select.value) {
        onboardingState.voiceId = select.value;
        onboardingState.voiceName = select.options[select.selectedIndex]?.textContent || null;
    } else {
        onboardingState.voiceId = null;
        onboardingState.voiceName = null;
    }
    moveToOnboardingFinish();
}

function moveToOnboardingFinish() {
    // Set preview image
    const selectedImg = onboardingState.images[onboardingState.selectedIndex];
    const imgEl = document.getElementById('onboardingFinishImage');
    if (imgEl && selectedImg?.url) imgEl.src = selectedImg.url;

    showOnboardingStep(5);
    // Auto-focus name input
    setTimeout(() => document.getElementById('onboardingNameInput')?.focus(), 200);
}

async function finalizeOnboarding() {
    const nameInput = document.getElementById('onboardingNameInput');
    const name = nameInput?.value?.trim();
    if (!name) {
        showToast('Please enter a character name', 'error');
        return;
    }

    const btn = document.getElementById('onboardingFinishBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating character...'; }

    try {
        const res = await fetch('/api/onboarding/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                sessionId: onboardingState.sessionId,
                selectedIndex: onboardingState.selectedIndex,
                name,
                voiceId: onboardingState.voiceId,
                voiceName: onboardingState.voiceName,
            }),
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Failed to complete onboarding', 'error');
            if (btn) { btn.disabled = false; btn.textContent = 'Finish Setup'; }
            return;
        }

        hideOnboarding();

        // Now init the full dashboard
        await refreshUserProfile();
        initFullDashboard();

        showToast('Your character is ready! Open iPhone Mode to find it in the Character Hub, or hit Execute Workflow to generate your first video.', 'success');
    } catch (err) {
        showToast('Network error: ' + err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Finish Setup'; }
    }
}

// ==================== SOCIAL STRIP (Command Center) ====================
function initSocialStrip() {
    updateSocialStrip();
    // Close popover on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.social-circle')) {
            document.querySelectorAll('.social-popover.open').forEach(p => p.classList.remove('open'));
        }
    });
}

function toggleSocialPopover(platform, event) {
    event.stopPropagation();
    const popover = document.getElementById(`popover-${platform}`);
    const wasOpen = popover.classList.contains('open');
    // Close all popovers
    document.querySelectorAll('.social-popover.open').forEach(p => p.classList.remove('open'));
    if (!wasOpen) popover.classList.add('open');
}

function updateSocialStrip() {
    for (const [platform, info] of Object.entries(state.platforms)) {
        const circle = document.querySelector(`.social-circle[data-platform="${platform}"]`);
        const popoverStatus = document.getElementById(`popover-status-${platform}`);
        const popoverToggle = document.getElementById(`popover-toggle-${platform}`);
        const popoverBtn = document.getElementById(`popover-btn-${platform}`);
        if (!circle) continue;

        if (info.connected) {
            circle.classList.add('connected');
            if (popoverStatus) {
                popoverStatus.textContent = 'Connected';
                popoverStatus.className = 'popover-status status-connected';
            }
            if (popoverToggle) {
                popoverToggle.disabled = false;
                popoverToggle.checked = info.enabled;
            }
            if (popoverBtn) {
                popoverBtn.textContent = 'Disconnect';
                popoverBtn.className = 'popover-action-btn btn-disconnect-small';
                popoverBtn.onclick = (e) => { e.stopPropagation(); disconnectPlatform(platform); };
            }
        } else {
            circle.classList.remove('connected');
            if (popoverStatus) {
                popoverStatus.textContent = 'Not Connected';
                popoverStatus.className = 'popover-status';
            }
            if (popoverToggle) {
                popoverToggle.disabled = true;
                popoverToggle.checked = false;
            }
            if (popoverBtn) {
                popoverBtn.textContent = 'Connect';
                popoverBtn.className = 'popover-action-btn';
                popoverBtn.onclick = (e) => { e.stopPropagation(); connectPlatform(platform); };
            }
        }
    }
}

function handlePopoverToggle(platform, checked) {
    state.platforms[platform].enabled = checked;
    saveState();
    showToast(`${PLATFORMS[platform].name} posting ${checked ? 'enabled' : 'disabled'}`, 'info');
    // Sync to Social tab toggle
    const mainToggle = $(`#toggle-${platform}`);
    if (mainToggle) mainToggle.checked = checked;
    // Persist
    const enabledPlatforms = Object.entries(state.platforms)
        .filter(([_, v]) => v.connected && v.enabled)
        .map(([k]) => k);
    apiFetch('/agent-config', {
        method: 'POST',
        body: JSON.stringify({ enabledPlatforms })
    });
}

// Patch existing loadSocialStatus and onPlatformConnected to also update strip
const _origLoadSocialStatus = loadSocialStatus;
loadSocialStatus = async function() {
    await _origLoadSocialStatus();
    updateSocialStrip();
};

const _origOnPlatformConnected = onPlatformConnected;
onPlatformConnected = function(platform) {
    _origOnPlatformConnected(platform);
    updateSocialStrip();
};

// ==================== SECTION COLLAPSIBLE ====================
const sectionCollapseDefaults = {
    'character-hub': false,   // expanded by default
    'recent-assets': true     // collapsed by default
};

function initSectionCollapse() {
    for (const [sectionId, defaultCollapsed] of Object.entries(sectionCollapseDefaults)) {
        const stored = localStorage.getItem(`cc_collapse_${sectionId}`);
        const isCollapsed = stored !== null ? stored === 'true' : defaultCollapsed;
        const section = document.querySelector(`.section-collapsible[data-section="${sectionId}"]`);
        if (section && isCollapsed) {
            section.classList.add('collapsed');
        }
    }
}

function toggleSectionCollapse(sectionId) {
    const section = document.querySelector(`.section-collapsible[data-section="${sectionId}"]`);
    if (!section) return;
    const isCollapsed = section.classList.toggle('collapsed');
    localStorage.setItem(`cc_collapse_${sectionId}`, isCollapsed);
}

// ==================== QUICK SETTINGS ====================
function initQuickSettings() {
    // Copy current config values to quick selects
    const settingsMap = ['videoModel', 'videoDuration', 'videoResolution', 'imageModel', 'aspectRatio', 'imageResolution'];
    settingsMap.forEach(id => {
        const configEl = document.getElementById(id);
        const quickEl = document.getElementById(`${id}-quick`);
        if (configEl && quickEl) quickEl.value = configEl.value;
    });
    // Copy schedule times
    const configTimes = document.querySelectorAll('.input-time:not(.input-time-quick)');
    const quickTimes = document.querySelectorAll('.input-time-quick');
    configTimes.forEach((el, i) => { if (quickTimes[i]) quickTimes[i].value = el.value; });
    // Copy character description
    const cdDesc = document.getElementById('cdCharacterDesc');
    const cdDescQuick = document.getElementById('cdCharacterDesc-quick');
    if (cdDesc && cdDescQuick) cdDescQuick.value = cdDesc.value;
    // Update pools summary
    updateQuickPoolsSummary();
}

function toggleQuickSection(sectionId) {
    const section = document.querySelector(`.quick-config-section[data-qs="${sectionId}"]`);
    if (section) section.classList.toggle('open');
}

function syncQuickSetting(settingId, value) {
    // Update Config tab select
    const configEl = document.getElementById(settingId);
    if (configEl) configEl.value = value;
    // Update state
    state.settings[settingId] = value;
    saveState();
}

function syncQuickSchedule(index, value) {
    state.settings.schedule[index] = value;
    saveState();
    // Update Config tab time input
    const configTimes = document.querySelectorAll('.input-time:not(.input-time-quick)');
    if (configTimes[index]) configTimes[index].value = value;
    updateNextRun();
}

function syncQuickCharDesc(value) {
    const cdDesc = document.getElementById('cdCharacterDesc');
    if (cdDesc) {
        cdDesc.value = value;
        cdConfig.character_description = value;
    }
}

function updateQuickPoolsSummary() {
    const el = document.getElementById('quickPoolsSummary');
    if (!el) return;
    const pCount = (cdConfig.prompts || []).length;
    const aCount = (cdConfig.actions || []).length;
    const sCount = (cdConfig.scenes || []).length;
    el.querySelector('span').textContent = `${pCount} prompts, ${aCount} actions, ${sCount} scenes`;
}

// Patch renderCreativeDirector to sync quick settings when config loads
const _origRenderCD = renderCreativeDirector;
renderCreativeDirector = function() {
    _origRenderCD();
    // Sync quick character description
    const cdDescQuick = document.getElementById('cdCharacterDesc-quick');
    if (cdDescQuick) cdDescQuick.value = cdConfig.character_description || '';
    updateQuickPoolsSummary();
};

// ==================== ASSETS AUTO-EXPAND ON PIPELINE COMPLETE ====================
function autoExpandAssetsOnComplete() {
    const section = document.querySelector('.section-collapsible[data-section="recent-assets"]');
    if (section && section.classList.contains('collapsed')) {
        section.classList.remove('collapsed');
        localStorage.setItem('cc_collapse_recent-assets', 'false');
        section.classList.add('pulse-gold');
        setTimeout(() => section.classList.remove('pulse-gold'), 1200);
    }
}

// ==================== CALENDAR & SAVED LOOKS ====================

async function loadSavedLooks() {
    try {
        const res = await fetch('/api/looks', { headers: authHeaders() });
        if (!res.ok) return;
        savedLooks = await res.json();
        renderSavedLooks();
    } catch (e) {
        console.log('Load saved looks error:', e.message);
    }
}

function renderSavedLooks() {
    const grid = document.getElementById('savedLooksGrid');
    const countEl = document.getElementById('savedLooksCount');
    const emptyEl = document.getElementById('savedLooksEmpty');
    if (!grid) return;

    if (countEl) countEl.textContent = `(${savedLooks.length})`;

    if (savedLooks.length === 0) {
        grid.innerHTML = '';
        if (emptyEl) { grid.appendChild(emptyEl); emptyEl.style.display = 'block'; }
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    grid.innerHTML = savedLooks.map(look => `
        <div class="saved-look-card ${selectedLookId === look.id ? 'selected' : ''}" onclick="selectLook('${look.id}')">
            <img class="saved-look-thumb" src="${look.thumbnail_url || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22><rect fill=%22%231a1a1a%22 width=%2236%22 height=%2236%22/></svg>'}" alt="">
            <div class="saved-look-info">
                <div class="saved-look-name">${look.name}</div>
                <div class="saved-look-meta">Used ${look.use_count || 0}x</div>
            </div>
            <button class="saved-look-delete" onclick="event.stopPropagation(); deleteLook('${look.id}')">×</button>
        </div>
    `).join('');
}

function selectLook(id) {
    selectedLookId = selectedLookId === id ? null : id;
    renderSavedLooks();
}

async function saveLookFromAsset(idx) {
    const filtered = assetsFilter === 'all' ? assetsData : assetsData.filter(a => a.type === assetsFilter);
    const sorted = [...filtered].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    const asset = sorted[idx];
    if (!asset) return;

    const name = prompt('Name this look:', `Look ${savedLooks.length + 1}`);
    if (!name) return;

    try {
        const res = await fetch('/api/looks', {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                thumbnail_url: asset.publicUrl || asset.sourceUrl || '',
                settings: {
                    prompt: asset.prompt || '',
                    imageModel: state.settings?.imageModel || 'nano-banana-pro',
                    videoModel: state.settings?.videoModel || 'kling-2.6/image-to-video',
                    videoDuration: state.settings?.videoDuration || '5',
                    llmProvider: state.llmProvider || 'gemini',
                    characterIds: iphoneState.selectedCardIds || [],
                    platforms: Object.keys(state.platforms || {}).filter(p => state.platforms[p]?.enabled),
                }
            })
        });
        if (!res.ok) throw new Error('Failed to save look');
        showToast(`Look "${name}" saved!`, 'success');
        loadSavedLooks();
    } catch (e) {
        showToast('Failed to save look: ' + e.message, 'error');
    }
}

async function deleteLook(id) {
    if (!confirm('Delete this saved look?')) return;
    try {
        await fetch(`/api/looks/${id}`, { method: 'DELETE', headers: authHeaders() });
        savedLooks = savedLooks.filter(l => l.id !== id);
        if (selectedLookId === id) selectedLookId = null;
        renderSavedLooks();
        renderCalendar();
        showToast('Look deleted', 'info');
    } catch (e) {
        showToast('Failed to delete look', 'error');
    }
}

async function loadCalendar() {
    try {
        const res = await fetch('/api/schedule/calendar', { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.slots) {
            calendarData = data;
        }
        const freqEl = document.getElementById('calendarFrequency');
        if (freqEl && calendarData.frequency) freqEl.value = calendarData.frequency;
        renderCalendar();
    } catch (e) {
        console.log('Load calendar error:', e.message);
    }
}

function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    if (!grid) return;

    const freq = calendarData.frequency || 'daily';
    let html = '<div class="calendar-header-cell"></div>';
    const dayLabels = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

    CALENDAR_DAYS.forEach(day => {
        const disabled = (freq === 'weekdays' && (day === 'sat' || day === 'sun')) ||
                         (freq === 'weekends' && day !== 'sat' && day !== 'sun');
        html += `<div class="calendar-header-cell ${disabled ? 'disabled' : ''}">${dayLabels[day]}</div>`;
    });

    CALENDAR_TIMES.forEach(time => {
        const h = parseInt(time.split(':')[0]);
        const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
        html += `<div class="calendar-time-label">${label}</div>`;

        CALENDAR_DAYS.forEach(day => {
            const disabled = (freq === 'weekdays' && (day === 'sat' || day === 'sun')) ||
                             (freq === 'weekends' && day !== 'sat' && day !== 'sun');
            const slot = calendarData.slots.find(s => s.day === day && s.time === time);
            const look = slot ? savedLooks.find(l => l.id === slot.lookId) : null;

            if (disabled) {
                html += `<div class="calendar-slot disabled"></div>`;
            } else if (look) {
                html += `<div class="calendar-slot filled" onclick="handleSlotClick('${day}','${time}')">
                    ${look.name}
                    <button class="calendar-slot-remove" onclick="event.stopPropagation(); removeLookFromSlot('${day}','${time}')">×</button>
                </div>`;
            } else {
                html += `<div class="calendar-slot" onclick="handleSlotClick('${day}','${time}')">+</div>`;
            }
        });
    });

    grid.innerHTML = html;
}

function handleSlotClick(day, time) {
    if (selectedLookId) {
        assignLookToSlot(day, time, selectedLookId);
    }
}

function assignLookToSlot(day, time, lookId) {
    calendarData.slots = calendarData.slots.filter(s => !(s.day === day && s.time === time));
    calendarData.slots.push({ day, time, lookId });
    renderCalendar();
}

function removeLookFromSlot(day, time) {
    calendarData.slots = calendarData.slots.filter(s => !(s.day === day && s.time === time));
    renderCalendar();
}

function updateCalendarFrequency() {
    const freqEl = document.getElementById('calendarFrequency');
    if (freqEl) calendarData.frequency = freqEl.value;
    renderCalendar();
}

async function saveCalendar() {
    try {
        const res = await fetch('/api/schedule/calendar', {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(calendarData)
        });
        if (!res.ok) throw new Error('Failed to save');
        showToast('Calendar saved!', 'success');
    } catch (e) {
        showToast('Failed to save calendar: ' + e.message, 'error');
    }
}

// ==================== WORKSPACE LAYOUT ====================
function initWorkspaceLayout() {
    // Sync LLM provider quick select with hidden main select
    const llmQuick = document.getElementById('llmProviderQuick');
    const llmMain = document.getElementById('llmProvider');
    if (llmQuick && llmMain) {
        llmQuick.value = state.llmProvider || 'gemini';
    }

    // Make preset chips toggle active state
    document.querySelectorAll('.cc-preset-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.cc-preset-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        });
    });
}

// Override pipeline stage rendering for compact footer dots
const _origUpdatePipelineStage = typeof updatePipelineStage === 'function' ? updatePipelineStage : null;

function updatePipelineStageDots(stageId, status) {
    const dot = document.querySelector(`.cc-pipeline-dot[data-stage="${stageId}"]`);
    if (!dot) return;
    dot.classList.remove('pending', 'running', 'success', 'error');
    if (status) dot.classList.add(status);
}

// ==================== CONTENT AGENT ====================

let agentContentData = null;

async function generateAgentContent() {
    if (iphoneState.selectedCardIds.length === 0) {
        showToast('Select a character card first', 'info');
        return;
    }

    const card = iphoneState.cards.find(c => c.id === iphoneState.selectedCardIds[0]);
    const cd = card?.character_data || {};
    if (!cd.bio && !cd.personality && !cd.backstory) {
        showToast('Add bio/personality data to your character first (edit card → Step 2)', 'info');
        return;
    }

    const theme = document.getElementById('agentThemeInput')?.value || '';
    const mood = document.getElementById('agentMoodSelect')?.value || '';

    const btn = document.getElementById('ccAgentBtn');
    if (btn) { btn.disabled = true; btn.classList.add('loading'); }
    // Activate glow ring for agent generation
    const agentGlow = document.getElementById('ccPromptGlowWrapper');
    if (agentGlow) { agentGlow.classList.add('generating'); agentGlow.dataset.generating = 'true'; }
    showToast('Generating in-character content idea...', 'info');

    try {
        const res = await fetch('/api/agent/generate-content', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                characterCardId: iphoneState.selectedCardIds[0],
                contentType: 'full',
                theme,
                mood,
            }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Generation failed');
        agentContentData = await res.json();

        // Populate preview card
        document.getElementById('agentImagePrompt').value = agentContentData.imagePrompt || '';
        document.getElementById('agentVideoAction').value = agentContentData.videoAction || '';
        document.getElementById('agentCaption').value = agentContentData.caption || '';
        document.getElementById('agentVoiceScript').value = agentContentData.voiceScript || '';
        document.getElementById('agentHashtags').value = (agentContentData.hashtags || []).join(' ');

        // Show preview
        document.getElementById('ccAgentPreview').style.display = 'block';
        showToast('Content idea ready! Review and edit, then click Use & Generate.', 'success');
    } catch (e) {
        showToast('Content agent error: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
        // Deactivate glow ring
        const agGlow = document.getElementById('ccPromptGlowWrapper');
        if (agGlow) { agGlow.classList.remove('generating'); agGlow.dataset.generating = 'false'; }
    }
}

function closeAgentPreview() {
    document.getElementById('ccAgentPreview').style.display = 'none';
    agentContentData = null;
}

async function regenerateAgentContent() {
    await generateAgentContent();
}

async function useAgentContent() {
    if (!agentContentData) return;

    // Read edited values from the preview fields
    const imagePrompt = document.getElementById('agentImagePrompt').value.trim();
    const videoAction = document.getElementById('agentVideoAction').value.trim();
    const caption = document.getElementById('agentCaption').value.trim();
    const voiceScript = document.getElementById('agentVoiceScript').value.trim();
    const hashtags = document.getElementById('agentHashtags').value.trim();

    // Set the scene input to the image prompt (pipeline will use composedPrompt)
    const sceneInput = document.getElementById('dashSceneContextInput');
    if (sceneInput) sceneInput.value = imagePrompt;

    // Close preview and submit to pipeline with agent content
    closeAgentPreview();
    showToast('Submitting agent content to pipeline...', 'info');

    try {
        const card = iphoneState.cards.find(c => c.id === iphoneState.selectedCardIds[0]);
        const voiceId = card?.voice?.voice_id || null;

        const jobData = {
            llmProvider: state.llmProvider || 'gemini',
            imageModel: state.imageModel || 'nano-banana-pro',
            videoModel: state.videoModel || 'kling-2.6/image-to-video',
            videoDuration: state.videoDuration || '5',
            characterCardIds: iphoneState.selectedCardIds,
            platforms: state.enabledPlatforms || [],
            source: 'content-agent',
            agentGeneratedContent: {
                imagePrompt,
                videoAction,
                caption,
                voiceScript,
                hashtags,
            },
        };

        if (iphoneState.motionRefUrl) jobData.motionReferenceUrl = iphoneState.motionRefUrl;

        const res = await fetch('/api/pipeline/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify(jobData),
        });
        if (!res.ok) throw new Error('Pipeline submission failed');
        const data = await res.json();
        showToast(`Pipeline started! Job #${data.jobId}`, 'success');
        if (data.jobId) startPipelineMonitor(data.jobId);
    } catch (e) {
        showToast('Pipeline error: ' + e.message, 'error');
    }
}

// ==================== MASTER AGENT ====================

let masterAgentHistory = [];

function toggleMasterAgent() {
    const panel = document.getElementById('masterAgentPanel');
    const fab = document.getElementById('masterAgentFab');
    if (!panel) return;

    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'flex';
    if (fab) fab.classList.toggle('active', !isVisible);

    if (!isVisible) {
        const input = document.getElementById('masterAgentInput');
        if (input) setTimeout(() => input.focus(), 100);
    }
}

function addAgentMessage(role, text) {
    const container = document.getElementById('masterAgentMessages');
    if (!container) return;

    const div = document.createElement('div');
    div.className = `agent-msg agent-msg-${role}`;
    div.innerHTML = `<div class="agent-msg-bubble">${text.replace(/\n/g, '<br>')}</div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

async function sendMasterAgentMessage() {
    const input = document.getElementById('masterAgentInput');
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    addAgentMessage('user', message);
    masterAgentHistory.push({ role: 'user', content: message });

    // Show thinking
    const thinking = document.getElementById('masterAgentThinking');
    if (thinking) thinking.style.display = 'flex';

    try {
        const res = await fetch('/api/agent/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                message,
                conversationHistory: masterAgentHistory.slice(-20),
            }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Agent error');
        const data = await res.json();

        // Hide thinking
        if (thinking) thinking.style.display = 'none';

        // Add agent reply
        const replyText = data.reply || 'Done.';
        addAgentMessage('agent', replyText);
        masterAgentHistory.push({ role: 'assistant', content: replyText });

        // Speak the reply if voice mode is on
        if (agentVoiceEnabled) speakText(replyText);

        // Execute any actions returned
        if (data.actions && data.actions.length > 0) {
            for (const action of data.actions) {
                await executeMasterAgentAction(action);
            }
        }
    } catch (e) {
        if (thinking) thinking.style.display = 'none';
        addAgentMessage('agent', 'Error: ' + e.message);
    }
}

async function executeMasterAgentAction(action) {
    try {
        switch (action.type) {
            case 'create_character': {
                const p = action.params || {};
                if (!p.name) { console.log('[master-agent] create_character: no name'); break; }
                const cardData = {
                    name: p.name,
                    character_data: {
                        appearance: p.appearance || '',
                        style: p.style || '',
                        outfit: p.outfit || '',
                        bio: p.bio || '',
                        personality: p.personality || '',
                        backstory: p.backstory || '',
                        location: p.location || '',
                        interests: p.interests || '',
                        humorStyle: p.humorStyle || '',
                        catchphrases: p.catchphrases || '',
                        contentVoice: p.contentVoice || '',
                    },
                };
                const res = await fetch('/api/cards', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify(cardData),
                });
                if (res.ok) {
                    const card = await res.json();
                    showToast(`Character "${p.name}" created!`, 'success');
                    // Reload character list
                    if (typeof loadCharacterCards === 'function') await loadCharacterCards();
                } else {
                    showToast(`Failed to create "${p.name}"`, 'error');
                }
                break;
            }
            case 'run_pipeline': {
                const params = action.params || {};
                const jobData = {
                    llmProvider: state.llmProvider || 'gemini',
                    imageModel: state.imageModel || 'nano-banana-pro',
                    videoModel: state.videoModel || 'kling-2.6/image-to-video',
                    videoDuration: state.videoDuration || '5',
                    characterCardIds: params.characterId ? [params.characterId] : iphoneState.selectedCardIds,
                    platforms: state.enabledPlatforms || [],
                    source: 'master-agent',
                };
                if (params.theme) jobData.agentTheme = params.theme;

                const res = await fetch('/api/pipeline/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify(jobData),
                });
                if (res.ok) {
                    const data = await res.json();
                    showToast(`Pipeline started! Job #${data.jobId}`, 'success');
                    if (data.jobId) startPipelineMonitor(data.jobId);
                }
                break;
            }
            case 'update_schedule': {
                const params = action.params || {};
                const res = await fetch('/api/schedule', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({
                        cronTimes: params.times || [],
                        enabled: params.enabled !== false,
                    }),
                });
                if (res.ok) {
                    showToast('Schedule updated!', 'success');
                    loadScheduleFromServer();
                }
                break;
            }
            case 'update_config': {
                const params = action.params || {};
                if (params.field && params.value !== undefined) {
                    state[params.field] = params.value;
                    saveState();
                    showToast(`Config updated: ${params.field} = ${params.value}`, 'success');
                }
                break;
            }
            case 'workflow_create_node': {
                if (typeof WorkflowEditor === 'undefined') { showToast('Workflow Editor not loaded', 'error'); break; }
                if (!WorkflowEditor.initialized) { switchTab('workflows'); await new Promise(r => setTimeout(r, 500)); }
                const p = action.params || {};
                const result = await WorkflowEditor.executeAgentTool('create_node', { type: p.type, x: p.x || 100, y: p.y || 100, config: p.config || {} });
                if (result.success) showToast(`Created ${p.type} node`, 'success');
                else showToast(result.error || 'Failed to create node', 'error');
                break;
            }
            case 'workflow_run_all': {
                if (typeof WorkflowEditor === 'undefined') { showToast('Workflow Editor not loaded', 'error'); break; }
                if (!WorkflowEditor.initialized) { switchTab('workflows'); await new Promise(r => setTimeout(r, 500)); }
                await WorkflowEditor.executeAgentTool('run_all', {});
                showToast('Workflow execution started', 'success');
                break;
            }
            case 'workflow_load': {
                if (typeof WorkflowEditor === 'undefined') { showToast('Workflow Editor not loaded', 'error'); break; }
                if (!WorkflowEditor.initialized) { switchTab('workflows'); await new Promise(r => setTimeout(r, 500)); }
                const p2 = action.params || {};
                const lr = await WorkflowEditor.executeAgentTool('load_workflow', { name: p2.name });
                if (lr.success) showToast(`Loaded workflow: ${p2.name}`, 'success');
                else showToast(lr.error || 'Failed to load workflow', 'error');
                break;
            }
            case 'workflow_save': {
                if (typeof WorkflowEditor === 'undefined') { showToast('Workflow Editor not loaded', 'error'); break; }
                if (!WorkflowEditor.initialized) { switchTab('workflows'); await new Promise(r => setTimeout(r, 500)); }
                const p3 = action.params || {};
                const sr = await WorkflowEditor.executeAgentTool('save_workflow', { name: p3.name });
                if (sr.success) showToast(`Saved workflow: ${p3.name}`, 'success');
                else showToast(sr.error || 'Failed to save workflow', 'error');
                break;
            }
            case 'switch_tab': {
                const p4 = action.params || {};
                if (p4.tab) switchTab(p4.tab);
                break;
            }
            default:
                console.log('[master-agent] Unknown action:', action.type);
        }
    } catch (e) {
        console.error('[master-agent] Action execution error:', e.message);
    }
}

// ==================== VOICE CHAT (Web Speech API) ====================

let agentVoiceEnabled = true;
let voiceRecognition = null;
let isRecording = false;

function toggleAgentVoice() {
    agentVoiceEnabled = !agentVoiceEnabled;
    const btn = document.getElementById('agentVoiceToggle');
    if (btn) btn.classList.toggle('active', agentVoiceEnabled);
    showToast(agentVoiceEnabled ? 'Voice responses ON' : 'Voice responses OFF', 'info');
    if (!agentVoiceEnabled) speechSynthesis.cancel();
}

function speakText(text) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    // Strip HTML tags and emojis for cleaner speech
    const cleanText = text.replace(/<[^>]*>/g, '').replace(/[\u{1F600}-\u{1F9FF}]/gu, '').trim();
    if (!cleanText) return;
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    // Try to pick a good voice
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Samantha') || v.name.includes('Google UK English Female') || v.name.includes('Karen'));
    if (preferred) utterance.voice = preferred;
    speechSynthesis.speak(utterance);
}

function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.log('[voice] SpeechRecognition not supported');
        return null;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        const input = document.getElementById('masterAgentInput');
        if (input) {
            input.value = finalTranscript || interimTranscript;
        }
        if (finalTranscript) {
            // Auto-send when speech is final
            stopVoiceRecording();
            setTimeout(() => sendMasterAgentMessage(), 100);
        }
    };

    recognition.onerror = (event) => {
        console.log('[voice] Recognition error:', event.error);
        if (event.error !== 'no-speech') {
            showToast('Voice recognition error: ' + event.error, 'error');
        }
        stopVoiceRecording();
    };

    recognition.onend = () => {
        if (isRecording) stopVoiceRecording();
    };

    return recognition;
}

function toggleVoiceRecording() {
    if (isRecording) {
        stopVoiceRecording();
    } else {
        startVoiceRecording();
    }
}

function startVoiceRecording() {
    if (!voiceRecognition) {
        voiceRecognition = initSpeechRecognition();
    }
    if (!voiceRecognition) {
        showToast('Voice recognition not supported in this browser. Try Chrome.', 'error');
        return;
    }

    // Stop any ongoing speech
    if ('speechSynthesis' in window) speechSynthesis.cancel();

    isRecording = true;
    const micBtn = document.getElementById('agentMicBtn');
    const recordingBar = document.getElementById('agentVoiceRecording');
    const input = document.getElementById('masterAgentInput');
    if (micBtn) micBtn.classList.add('recording');
    if (recordingBar) recordingBar.style.display = 'flex';
    if (input) input.placeholder = 'Listening...';

    try {
        voiceRecognition.start();
    } catch (e) {
        console.log('[voice] Recognition start error:', e.message);
        stopVoiceRecording();
    }
}

function stopVoiceRecording() {
    isRecording = false;
    const micBtn = document.getElementById('agentMicBtn');
    const recordingBar = document.getElementById('agentVoiceRecording');
    const input = document.getElementById('masterAgentInput');
    if (micBtn) micBtn.classList.remove('recording');
    if (recordingBar) recordingBar.style.display = 'none';
    if (input) input.placeholder = 'Ask me anything...';

    if (voiceRecognition) {
        try { voiceRecognition.stop(); } catch {}
    }
}

// Init voice toggle state on load
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('agentVoiceToggle');
    if (btn) btn.classList.toggle('active', agentVoiceEnabled);
    // Pre-load voices
    if ('speechSynthesis' in window) speechSynthesis.getVoices();

    // ==================== SCROLL-TRIGGERED REVEAL ANIMATIONS ====================
    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('revealed');
                revealObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal-up, .card, .social-card, .stat-card').forEach(el => {
        if (!el.classList.contains('revealed')) {
            revealObserver.observe(el);
        }
    });

    // ==================== BUTTON RIPPLE EFFECT ====================
    document.querySelectorAll('.btn-primary').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            const rect = btn.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width * 100).toFixed(0);
            const y = ((e.clientY - rect.top) / rect.height * 100).toFixed(0);
            btn.style.setProperty('--click-x', x + '%');
            btn.style.setProperty('--click-y', y + '%');
        });
    });
});
