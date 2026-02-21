// ============================================================
// WORKFLOW EDITOR - Node-Based Workflow Editor for Loki Dashboard
// Wrapped in IIFE, scoped under WorkflowEditor namespace
// IDs prefixed with we-, fetch URLs prefixed with /api/workflow-editor/
// ============================================================

window.WorkflowEditor = (function() {
    "use strict";

// ==================== STATE ====================
const wfState = {
    nodes: new Map(),
    connections: [],
    selectedNodes: new Set(),
    nextNodeId: 1,
    pan: { x: 0, y: 0 },
    zoom: 1,
    isDragging: false,
    isPanning: false,
    isConnecting: false,
    isSelecting: false,
    dragStart: null,
    dragNodeOffset: null,
    connectFrom: null,
    selectionStart: null,
    executionAbort: null,
};

// ==================== SVG ICON HELPER ====================
function svgIcon(id, size = 14) {
    return `<svg width="${size}" height="${size}"><use href="#we-${id}"/></svg>`;
}

// ==================== AUTH FETCH HELPER ====================
function wfFetch(url, options = {}) {
    const token = localStorage.getItem('saas_token');
    if (token) {
        options.headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    }
    return fetch(url, options);
}

// ==================== NODE TYPE REGISTRY ====================
const NODE_TYPES = {
    text: {
        label: 'Text',
        icon: 'ic-text',
        color: '#fbbf24',
        headerBg: 'linear-gradient(135deg, rgba(251,191,36,0.15), rgba(251,191,36,0.05))',
        inputs: [],
        outputs: [{ id: 'text', type: 'text', label: 'Text' }],
        defaults: { text: '' },
        desc: 'Prompt or text value',
    },
    upload: {
        label: 'Upload',
        icon: 'ic-upload',
        color: '#c084fc',
        headerBg: 'linear-gradient(135deg, rgba(192,132,252,0.15), rgba(192,132,252,0.05))',
        inputs: [],
        outputs: [
            { id: 'image', type: 'image', label: 'Image' },
            { id: 'audio', type: 'audio', label: 'Audio' },
        ],
        defaults: { url: '', filename: '', fileType: 'image' },
        desc: 'Upload image or audio',
    },
    imageGen: {
        label: 'Image Generator',
        icon: 'ic-image',
        color: '#60a5fa',
        headerBg: 'linear-gradient(135deg, rgba(96,165,250,0.15), rgba(96,165,250,0.05))',
        inputs: [
            { id: 'text', type: 'text', label: 'Prompt' },
            { id: 'style_ref', type: 'image', label: 'Style Ref' },
            { id: 'structure_ref', type: 'image', label: 'Structure Ref' },
        ],
        outputs: [{ id: 'image', type: 'image', label: 'Image' }],
        defaults: { prompt: '', model: 'realism', resolution: '2k', aspect_ratio: 'widescreen_16_9', style_strength: 90, structure_strength: 50 },
        desc: 'Mystic AI image generation',
    },
    videoGen: {
        label: 'Video Generator',
        icon: 'ic-video',
        color: '#34d399',
        headerBg: 'linear-gradient(135deg, rgba(52,211,153,0.15), rgba(52,211,153,0.05))',
        inputs: [
            { id: 'text', type: 'text', label: 'Prompt' },
            { id: 'image', type: 'image', label: 'Image' },
            { id: 'element_ref', type: 'image', label: 'Character Ref' },
            { id: 'frontal_ref', type: 'image', label: 'Frontal Ref' },
        ],
        outputs: [{ id: 'video', type: 'video', label: 'Video' }],
        defaults: { prompt: '', engine: 'kling-3-omni-pro', duration: 5 },
        desc: 'Image-to-video generation',
    },
    lipsync: {
        label: 'Lipsync',
        icon: 'ic-lipsync',
        color: '#f472b6',
        headerBg: 'linear-gradient(135deg, rgba(244,114,182,0.15), rgba(244,114,182,0.05))',
        inputs: [
            { id: 'image', type: 'image', label: 'Image' },
            { id: 'audio', type: 'audio', label: 'Audio' },
            { id: 'text', type: 'text', label: 'Prompt' },
        ],
        outputs: [{ id: 'video', type: 'video', label: 'Video' }],
        defaults: { prompt: 'person speaking' },
        desc: 'OmniHuman lip sync',
    },
    upscaler: {
        label: 'Upscaler',
        icon: 'ic-upscale',
        color: '#22d3ee',
        headerBg: 'linear-gradient(135deg, rgba(34,211,238,0.15), rgba(34,211,238,0.05))',
        inputs: [{ id: 'image', type: 'image', label: 'Image' }],
        outputs: [{ id: 'image', type: 'image', label: 'Image' }],
        defaults: { scale: 2 },
        desc: 'Magnific upscaling',
    },
    audioTrim: {
        label: 'Audio Trimmer',
        icon: 'ic-scissors',
        color: '#fb923c',
        headerBg: 'linear-gradient(135deg, rgba(251,146,60,0.15), rgba(251,146,60,0.05))',
        inputs: [{ id: 'audio', type: 'audio', label: 'Audio' }],
        outputs: [{ id: 'audio', type: 'audio', label: 'Trimmed' }],
        defaults: { start_time: 0, end_time: 30 },
        desc: 'Trim audio clip by time range',
    },
};

const OMNI_ENGINES = new Set(['kling-3-omni-pro', 'kling-3-omni-std']);
const ENGINE_ENDPOINTS = {
    'kling-3-omni-pro': '/v1/ai/video/kling-v3-omni-pro',
    'kling-3-omni-std': '/v1/ai/video/kling-v3-omni-std',
    'kling-2.6-pro': '/v1/ai/image-to-video/kling-v2-6-pro',
    'kling-2.5-pro': '/v1/ai/image-to-video/kling-v2-5-pro',
    'seedance-pro': '/v1/ai/image-to-video/seedance-pro-1080p',
};

// Poll endpoints differ from submit endpoints for some legacy engines
const ENGINE_POLL_ENDPOINTS = {
    'kling-2.6-pro': '/v1/ai/image-to-video/kling-v2-6',
};

const PORT_COLORS = { text: 'var(--port-text)', image: 'var(--port-image)', audio: 'var(--port-audio)', video: 'var(--port-video)' };

// ==================== UTILITY ====================
function uid() { return 'n' + (wfState.nextNodeId++); }

const _activeToasts = new Map();
function toast(msg, type = 'info', key = null) {
    if (key && _activeToasts.has(key)) {
        const existing = _activeToasts.get(key);
        existing.textContent = msg;
        existing.className = 'toast ' + type;
        return;
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    document.getElementById('we-toasts').appendChild(el);
    if (key) { _activeToasts.set(key, el); }
    else { setTimeout(() => el.remove(), 4000); }
}
function removeToast(key) { const el = _activeToasts.get(key); if (el) { el.remove(); _activeToasts.delete(key); } }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function escapeHtml(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ==================== DOT GRID ====================
let bgCanvas = null;
let bgCtx = null;

function drawGrid() {
    if (!bgCanvas) { bgCanvas = document.getElementById('we-canvas-bg'); bgCtx = bgCanvas?.getContext('2d'); }
    if (!bgCanvas || !bgCtx) return;
    const w = bgCanvas.width = bgCanvas.clientWidth;
    const h = bgCanvas.height = bgCanvas.clientHeight;
    bgCtx.clearRect(0, 0, w, h);

    const dotSpacing = 28 * wfState.zoom;
    if (dotSpacing < 6) return;

    const ox = (wfState.pan.x % dotSpacing + dotSpacing) % dotSpacing;
    const oy = (wfState.pan.y % dotSpacing + dotSpacing) % dotSpacing;

    bgCtx.fillStyle = 'rgba(255,255,255,0.04)';
    const r = Math.max(0.6, wfState.zoom * 0.9);

    for (let x = ox; x < w; x += dotSpacing) {
        for (let y = oy; y < h; y += dotSpacing) {
            bgCtx.beginPath();
            bgCtx.arc(x, y, r, 0, Math.PI * 2);
            bgCtx.fill();
        }
    }
}

// ==================== COORDINATE CONVERSION ====================
function screenToCanvas(sx, sy) {
    const rect = document.getElementById('we-canvas-container').getBoundingClientRect();
    return { x: (sx - rect.left - wfState.pan.x) / wfState.zoom, y: (sy - rect.top - wfState.pan.y) / wfState.zoom };
}

function updateTransform() {
    document.getElementById('we-canvas').style.transform = `translate(${wfState.pan.x}px, ${wfState.pan.y}px) scale(${wfState.zoom})`;
    document.getElementById('we-zoom-display').textContent = Math.round(wfState.zoom * 100) + '%';
    drawGrid();
    renderConnections();
}

function zoomTo(z) { wfState.zoom = clamp(z, 0.1, 3); updateTransform(); }

function fitToView() {
    if (wfState.nodes.size === 0) { zoomTo(1); return; }
    const container = document.getElementById('we-canvas-container');
    const cw = container.clientWidth, ch = container.clientHeight;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of wfState.nodes.values()) {
        const el = document.getElementById('node-' + node.id);
        const nh = el ? el.offsetHeight : 150;
        minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + 240); maxY = Math.max(maxY, node.y + nh);
    }
    const nw = maxX - minX + 100, nh = maxY - minY + 100;
    const z = clamp(Math.min(cw / nw, ch / nh), 0.2, 1.5);
    wfState.zoom = z;
    wfState.pan.x = (cw - nw * z) / 2 - minX * z + 50 * z;
    wfState.pan.y = (ch - nh * z) / 2 - minY * z + 50 * z;
    updateTransform();
}

// ==================== NODE CREATION ====================
function createNode(type, x, y, data = {}) {
    const typeDef = NODE_TYPES[type];
    if (!typeDef) return null;
    const id = data.id || uid();
    const node = { id, type, x: x || 100, y: y || 100, status: 'idle', result: data.result || null, config: { ...typeDef.defaults, ...data.config } };
    wfState.nodes.set(id, node);
    renderNode(node);
    autoSave();
    return node;
}

function deleteNode(id) {
    wfState.connections = wfState.connections.filter(c => c.from.node !== id && c.to.node !== id);
    wfState.selectedNodes.delete(id);
    const el = document.getElementById('node-' + id);
    if (el) el.remove();
    wfState.nodes.delete(id);
    renderConnections();
    updatePropsPanel();
    autoSave();
}

function duplicateNode(id) {
    const orig = wfState.nodes.get(id);
    if (!orig) return;
    const n = createNode(orig.type, orig.x + 30, orig.y + 30, { config: { ...orig.config } });
    selectNode(n.id, false);
}

// ==================== NODE RENDERING ====================
function renderNode(node) {
    const typeDef = NODE_TYPES[node.type];
    let el = document.getElementById('node-' + node.id);
    if (el) el.remove();

    el = document.createElement('div');
    el.className = 'node';
    el.id = 'node-' + node.id;
    el.dataset.nodeId = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';

    if (wfState.selectedNodes.has(node.id)) el.classList.add('selected');
    if (node.status !== 'idle') el.classList.add(node.status);

    // Header
    const header = document.createElement('div');
    header.className = 'node-header';
    header.style.background = typeDef.headerBg;
    header.innerHTML = `
        <div class="node-header-icon" style="background:rgba(255,255,255,0.06);color:${typeDef.color}">${svgIcon(typeDef.icon, 14)}</div>
        <span class="node-header-title">${typeDef.label}</span>
        <span class="node-header-status ${node.status}"></span>
    `;
    el.appendChild(header);

    // Body with ports
    const body = document.createElement('div');
    body.className = 'node-body';

    for (const inp of typeDef.inputs) {
        const row = document.createElement('div');
        row.className = 'node-port-row input';
        const isConn = wfState.connections.some(c => c.to.node === node.id && c.to.port === inp.id);
        row.innerHTML = `<div class="port-dot input ${isConn ? 'connected' : ''}" data-type="${inp.type}" data-node="${node.id}" data-port="${inp.id}" data-dir="input"></div><span class="port-label">${inp.label}</span>`;
        body.appendChild(row);
    }

    for (const out of typeDef.outputs) {
        const row = document.createElement('div');
        row.className = 'node-port-row output';
        const isConn = wfState.connections.some(c => c.from.node === node.id && c.from.port === out.id);
        row.innerHTML = `<span class="port-label">${out.label}</span><div class="port-dot output ${isConn ? 'connected' : ''}" data-type="${out.type}" data-node="${node.id}" data-port="${out.id}" data-dir="output"></div>`;
        body.appendChild(row);
    }

    el.appendChild(body);

    // Preview
    if (node.result) {
        const preview = document.createElement('div');
        preview.className = 'node-preview';
        if (node.result.imageUrl) {
            preview.innerHTML = `<img src="${node.result.imageUrl}" alt="result" loading="lazy">`;
        } else if (node.result.videoUrl) {
            preview.innerHTML = `<video src="${node.result.videoUrl}" controls muted loop playsinline preload="metadata"></video>`;
        } else if (node.result.text) {
            preview.innerHTML = `<div class="preview-text">${escapeHtml(node.result.text.substring(0, 120))}</div>`;
        }
        el.appendChild(preview);
    } else if (node.type === 'text' && node.config.text) {
        const preview = document.createElement('div');
        preview.className = 'node-preview';
        preview.innerHTML = `<div class="preview-text">${escapeHtml(node.config.text.substring(0, 120))}</div>`;
        el.appendChild(preview);
    } else if (node.type === 'upload' && node.config.url) {
        const preview = document.createElement('div');
        preview.className = 'node-preview';
        if (node.config.fileType === 'audio') {
            preview.innerHTML = `<div class="preview-text" style="text-align:center">&#127925; ${escapeHtml(node.config.filename || 'audio')}</div>`;
        } else {
            preview.innerHTML = `<img src="${node.config.url}" alt="upload" loading="lazy">`;
        }
        el.appendChild(preview);
    }

    // Run button
    if (['imageGen', 'videoGen', 'lipsync', 'upscaler', 'audioTrim'].includes(node.type)) {
        const runBtn = document.createElement('button');
        runBtn.className = 'node-run-btn';
        runBtn.innerHTML = `${svgIcon('ic-play', 11)} Run`;
        runBtn.addEventListener('click', (e) => { e.stopPropagation(); executeNode(node.id); });
        el.appendChild(runBtn);
    }

    document.getElementById('we-canvas').appendChild(el);
    attachNodeEvents(el, node);
}

function rerenderNode(id) { const n = wfState.nodes.get(id); if (n) renderNode(n); }
function rerenderAll() { for (const n of wfState.nodes.values()) renderNode(n); renderConnections(); }

// ==================== NODE EVENTS ====================
function attachNodeEvents(el, node) {
    el.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('port-dot')) return;
        if (e.button === 2) return;
        e.stopPropagation();
        if (!wfState.selectedNodes.has(node.id)) selectNode(node.id, e.shiftKey);
        wfState.isDragging = true;
        wfState.dragStart = { x: e.clientX, y: e.clientY };
        wfState.dragNodeOffset = {};
        for (const id of wfState.selectedNodes) { const n = wfState.nodes.get(id); wfState.dragNodeOffset[id] = { x: n.x, y: n.y }; }
    });

    el.addEventListener('click', (e) => { if (e.target.classList.contains('port-dot')) return; e.stopPropagation(); });
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); selectNode(node.id, false); });

    el.querySelectorAll('.port-dot').forEach(dot => {
        dot.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            wfState.isConnecting = true;
            wfState.connectFrom = { node: dot.dataset.node, port: dot.dataset.port, type: dot.dataset.type, dir: dot.dataset.dir };
        });
    });

    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); selectNode(node.id, false); showNodeContextMenu(e.clientX, e.clientY, node.id); });
}

// ==================== CONNECTIONS ====================
function addConnection(from, to) {
    if (from.node === to.node) return false;
    if (from.dir === 'input' && to.dir === 'output') [from, to] = [to, from];
    if (from.dir !== 'output' || to.dir !== 'input') return false;
    if (from.type !== to.type) { toast(`Cannot connect ${from.type} to ${to.type}`, 'error'); return false; }
    wfState.connections = wfState.connections.filter(c => !(c.to.node === to.node && c.to.port === to.port));
    wfState.connections.push({ from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port }, type: from.type });
    rerenderNode(from.node); rerenderNode(to.node); renderConnections(); autoSave();
    return true;
}

function removeConnection(idx) {
    const conn = wfState.connections[idx];
    wfState.connections.splice(idx, 1);
    if (conn) { rerenderNode(conn.from.node); rerenderNode(conn.to.node); }
    renderConnections(); autoSave();
}

function getPortPosition(nodeId, portId, dir) {
    const nodeEl = document.getElementById('node-' + nodeId);
    if (!nodeEl) return { x: 0, y: 0 };
    const dot = nodeEl.querySelector(`.port-dot[data-port="${portId}"][data-dir="${dir}"]`);
    if (!dot) return { x: 0, y: 0 };
    const dotRect = dot.getBoundingClientRect();
    const containerRect = document.getElementById('we-canvas-container').getBoundingClientRect();
    return { x: dotRect.left + dotRect.width / 2 - containerRect.left, y: dotRect.top + dotRect.height / 2 - containerRect.top };
}

function bezierPath(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1);
    const cp = Math.max(60, dx * 0.45);
    return `M${x1},${y1} C${x1 + cp},${y1} ${x2 - cp},${y2} ${x2},${y2}`;
}

function renderConnections() {
    const svg = document.getElementById('we-connections-svg');
    svg.querySelectorAll('path.conn').forEach(p => p.remove());

    for (let i = 0; i < wfState.connections.length; i++) {
        const conn = wfState.connections[i];
        const fromPos = getPortPosition(conn.from.node, conn.from.port, 'output');
        const toPos = getPortPosition(conn.to.node, conn.to.port, 'input');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.classList.add('conn');
        path.setAttribute('d', bezierPath(fromPos.x, fromPos.y, toPos.x, toPos.y));
        path.setAttribute('stroke', PORT_COLORS[conn.type] || 'var(--accent)');
        path.style.pointerEvents = 'stroke';
        path.dataset.connIdx = i;
        path.addEventListener('contextmenu', (e) => { e.preventDefault(); showConnectionContextMenu(e.clientX, e.clientY, i); });
        svg.insertBefore(path, document.getElementById('we-drag-connection'));
    }
}

// ==================== SELECTION ====================
function selectNode(id, additive) {
    if (!additive) { wfState.selectedNodes.forEach(sid => { const el = document.getElementById('node-' + sid); if (el) el.classList.remove('selected'); }); wfState.selectedNodes.clear(); }
    if (id) { wfState.selectedNodes.add(id); const el = document.getElementById('node-' + id); if (el) el.classList.add('selected'); }
    updatePropsPanel();
}

function deselectAll() { wfState.selectedNodes.forEach(sid => { const el = document.getElementById('node-' + sid); if (el) el.classList.remove('selected'); }); wfState.selectedNodes.clear(); updatePropsPanel(); }

// ==================== PROPERTIES PANEL ====================
function updatePropsPanel() {
    const body = document.getElementById('we-props-body');
    const title = document.getElementById('we-props-title');
    const runBtn = document.getElementById('we-props-run-btn');

    if (wfState.selectedNodes.size !== 1) {
        title.textContent = 'Properties';
        runBtn.style.display = 'none';
        body.innerHTML = `<div class="prop-empty">${wfState.selectedNodes.size === 0 ? 'Select a node to view its properties' : `${wfState.selectedNodes.size} nodes selected`}</div>`;
        return;
    }

    const nodeId = [...wfState.selectedNodes][0];
    const node = wfState.nodes.get(nodeId);
    if (!node) return;

    const typeDef = NODE_TYPES[node.type];
    title.textContent = typeDef.label;
    runBtn.style.display = ['imageGen', 'videoGen', 'lipsync', 'upscaler', 'audioTrim'].includes(node.type) ? '' : 'none';

    let html = '';
    html += `<div class="prop-group"><label class="prop-label">Node ID</label><input class="prop-input" value="${node.id}" readonly style="opacity:0.4"></div>`;

    switch (node.type) {
        case 'text':
            html += `<div class="prop-group"><label class="prop-label">Text Content</label><textarea class="prop-textarea" data-field="text" placeholder="Enter text or prompt...">${escapeHtml(node.config.text || '')}</textarea></div>`;
            break;
        case 'upload':
            html += `<div class="prop-group"><label class="prop-label">File Type</label><select class="prop-select" data-field="fileType"><option value="image" ${node.config.fileType === 'image' ? 'selected' : ''}>Image</option><option value="audio" ${node.config.fileType === 'audio' ? 'selected' : ''}>Audio</option></select></div>`;
            html += `<div class="prop-group"><label class="prop-label">Upload File</label><div class="prop-file-btn" id="we-upload-btn">${svgIcon('ic-clip', 16)} Click or drop file</div><input type="file" id="we-upload-input" style="display:none" accept="image/*,audio/*"></div>`;
            if (node.config.url) html += `<div class="prop-group"><label class="prop-label">URL</label><input class="prop-input" value="${escapeHtml(node.config.url)}" readonly style="font-size:10px;opacity:0.6"></div>`;
            break;
        case 'imageGen':
            html += `<div class="prop-group"><label class="prop-label">Prompt</label><textarea class="prop-textarea" data-field="prompt" placeholder="Describe the image...">${escapeHtml(node.config.prompt || '')}</textarea></div>`;
            html += `<div class="prop-group"><label class="prop-label">Model</label><select class="prop-select" data-field="model"><option value="realism" ${node.config.model === 'realism' ? 'selected' : ''}>Realism</option><option value="anime" ${node.config.model === 'anime' ? 'selected' : ''}>Anime</option><option value="illustration" ${node.config.model === 'illustration' ? 'selected' : ''}>Illustration</option><option value="digital_art" ${node.config.model === 'digital_art' ? 'selected' : ''}>Digital Art</option><option value="photography" ${node.config.model === 'photography' ? 'selected' : ''}>Photography</option></select></div>`;
            html += `<div class="prop-group"><label class="prop-label">Resolution</label><select class="prop-select" data-field="resolution"><option value="2k" ${node.config.resolution === '2k' ? 'selected' : ''}>2K</option><option value="4k" ${node.config.resolution === '4k' ? 'selected' : ''}>4K</option></select></div>`;
            html += `<div class="prop-group"><label class="prop-label">Aspect Ratio</label><select class="prop-select" data-field="aspect_ratio"><option value="widescreen_16_9" ${node.config.aspect_ratio === 'widescreen_16_9' ? 'selected' : ''}>16:9 Widescreen</option><option value="square_1_1" ${node.config.aspect_ratio === 'square_1_1' ? 'selected' : ''}>1:1 Square</option><option value="portrait_4_5" ${node.config.aspect_ratio === 'portrait_4_5' ? 'selected' : ''}>4:5 Portrait</option><option value="classic_4_3" ${node.config.aspect_ratio === 'classic_4_3' ? 'selected' : ''}>4:3 Classic</option><option value="portrait_3_4" ${node.config.aspect_ratio === 'portrait_3_4' ? 'selected' : ''}>3:4 Portrait</option><option value="traditional_3_2" ${node.config.aspect_ratio === 'traditional_3_2' ? 'selected' : ''}>3:2 Traditional</option></select></div>`;
            html += `<div class="prop-group"><label class="prop-label">Style Strength</label><div class="prop-range-row"><input type="range" min="0" max="100" value="${node.config.style_strength}" data-field="style_strength"><span class="range-val">${node.config.style_strength}</span></div></div>`;
            html += `<div class="prop-group"><label class="prop-label">Structure Strength</label><div class="prop-range-row"><input type="range" min="0" max="100" value="${node.config.structure_strength}" data-field="structure_strength"><span class="range-val">${node.config.structure_strength}</span></div></div>`;
            break;
        case 'videoGen': {
            html += `<div class="prop-group"><label class="prop-label">Prompt</label><textarea class="prop-textarea" data-field="prompt" placeholder="Describe the motion... Use @Element1 to reference character">${escapeHtml(node.config.prompt || '')}</textarea></div>`;
            html += `<div class="prop-group"><label class="prop-label">Engine</label><select class="prop-select" data-field="engine"><option value="kling-3-omni-pro" ${node.config.engine === 'kling-3-omni-pro' ? 'selected' : ''}>Kling 3 Omni Pro</option><option value="kling-3-omni-std" ${node.config.engine === 'kling-3-omni-std' ? 'selected' : ''}>Kling 3 Omni Std</option><option value="kling-2.6-pro" ${node.config.engine === 'kling-2.6-pro' ? 'selected' : ''}>Kling 2.6 Pro</option><option value="kling-2.5-pro" ${node.config.engine === 'kling-2.5-pro' ? 'selected' : ''}>Kling 2.5 Pro</option><option value="seedance-pro" ${node.config.engine === 'seedance-pro' ? 'selected' : ''}>Seedance Pro</option></select></div>`;
            const isOmni = OMNI_ENGINES.has(node.config.engine);
            const minDur = isOmni ? 3 : 5, maxDur = isOmni ? 15 : 10;
            const dur = Math.max(minDur, Math.min(maxDur, node.config.duration || (isOmni ? 5 : 10)));
            html += `<div class="prop-group"><label class="prop-label">Duration</label><div class="prop-range-row"><input type="range" min="${minDur}" max="${maxDur}" value="${dur}" data-field="duration"><span class="range-val">${dur}s</span></div></div>`;
            if (isOmni) {
                html += `<div class="prop-group" style="padding:8px 10px;background:rgba(52,211,153,0.08);border-radius:6px;border:1px solid rgba(52,211,153,0.15);margin-top:4px"><span style="font-size:11px;color:#34d399;line-height:1.4">Connect <b>Character Ref</b> and <b>Frontal Ref</b> ports for character consistency. Use <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px">@Element1</code> in your prompt to reference the character.</span></div>`;
            }
            break;
        }
        case 'lipsync':
            html += `<div class="prop-group"><label class="prop-label">Prompt</label><textarea class="prop-textarea" data-field="prompt" placeholder="Describe the person...">${escapeHtml(node.config.prompt || '')}</textarea></div>`;
            break;
        case 'upscaler':
            html += `<div class="prop-group"><label class="prop-label">Scale</label><select class="prop-select" data-field="scale"><option value="2" ${node.config.scale == 2 ? 'selected' : ''}>2x</option><option value="4" ${node.config.scale == 4 ? 'selected' : ''}>4x</option></select></div>`;
            break;
        case 'audioTrim':
            html += `<div class="prop-group"><label class="prop-label">Start Time (seconds)</label><div class="prop-range-row"><input type="range" min="0" max="300" step="0.5" value="${node.config.start_time || 0}" data-field="start_time"><span class="range-val">${node.config.start_time || 0}s</span></div></div>`;
            html += `<div class="prop-group"><label class="prop-label">End Time (seconds)</label><div class="prop-range-row"><input type="range" min="0.5" max="300" step="0.5" value="${node.config.end_time || 30}" data-field="end_time"><span class="range-val">${node.config.end_time || 30}s</span></div></div>`;
            html += `<div class="prop-group" style="padding:8px 10px;background:rgba(251,146,60,0.08);border-radius:6px;border:1px solid rgba(251,146,60,0.15);margin-top:4px"><span style="font-size:11px;color:#fb923c;line-height:1.4">Connect an <b>Upload</b> node with audio. Set start/end times then click <b>Run</b> to trim the clip.</span></div>`;
            break;
    }

    if (node.result) {
        html += `<div class="prop-group"><label class="prop-label">Result</label>`;
        if (node.result.imageUrl) html += `<img src="${node.result.imageUrl}" style="max-width:100%;border-radius:var(--radius-sm);margin-top:4px;border:1px solid var(--border-light)">`;
        if (node.result.videoUrl) html += `<video src="${node.result.videoUrl}" controls muted loop playsinline style="max-width:100%;border-radius:var(--radius-sm);margin-top:4px;background:#000"></video>`;
        if (node.result.publicUrl) html += `<input class="prop-input" value="${escapeHtml(node.result.publicUrl)}" readonly style="font-size:10px;margin-top:6px;opacity:0.6">`;
        html += `</div>`;
    }

    body.innerHTML = html;

    // Bind change events
    body.querySelectorAll('[data-field]').forEach(el => {
        const field = el.dataset.field;
        const eventType = el.tagName === 'SELECT' ? 'change' : el.type === 'range' ? 'input' : 'input';
        el.addEventListener(eventType, () => {
            let val = el.value;
            if (el.type === 'range' || field === 'scale' || field === 'duration') val = Number(val);
            node.config[field] = val;
            const rangeVal = el.closest('.prop-range-row')?.querySelector('.range-val');
            if (rangeVal) rangeVal.textContent = field === 'duration' ? val + 's' : val;
            if (node.type === 'text' && field === 'text') { node.result = val ? { text: val } : null; rerenderNode(node.id); }
            autoSave();
        });
    });

    // Upload handler
    const uploadBtn = document.getElementById("we-upload-btn");
    const uploadInput = document.getElementById("we-upload-input");
    if (uploadBtn && uploadInput) {
        uploadBtn.addEventListener('click', () => uploadInput.click());
        uploadInput.addEventListener('change', () => { if (uploadInput.files.length > 0) uploadFile(node, uploadInput.files[0]); });
        uploadBtn.addEventListener('dragover', (e) => { e.preventDefault(); uploadBtn.style.borderColor = 'var(--accent)'; });
        uploadBtn.addEventListener('dragleave', () => { uploadBtn.style.borderColor = ''; });
        uploadBtn.addEventListener('drop', (e) => { e.preventDefault(); uploadBtn.style.borderColor = ''; if (e.dataTransfer.files.length > 0) uploadFile(node, e.dataTransfer.files[0]); });
    }
}

async function uploadFile(node, file) {
    toast('Uploading ' + file.name + '...');
    try {
        const formData = new FormData();
        formData.append('file', file);
        const resp = await wfFetch('/api/workflow-editor/upload', { method: 'POST', body: formData });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        node.config.url = data.url;
        node.config.filename = data.filename || file.name;
        node.config.fileType = file.type.startsWith('audio') ? 'audio' : 'image';
        node.result = node.config.fileType === 'image' ? { imageUrl: data.url, publicUrl: data.url } : { publicUrl: data.url };
        rerenderNode(node.id); updatePropsPanel(); toast('Uploaded: ' + file.name, 'success'); autoSave();
        // Auto-run downstream nodes (e.g. AudioTrim) after upload
        autoRunDownstream(node.id);
    } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
}

function runSelectedNode() { if (wfState.selectedNodes.size === 1) executeNode([...wfState.selectedNodes][0]); }

// Auto-run downstream executable nodes when an upstream node produces a result
async function autoRunDownstream(sourceNodeId) {
    const executableTypes = new Set(['imageGen', 'videoGen', 'lipsync', 'upscaler', 'audioTrim']);
    const downstream = [];
    for (const conn of wfState.connections) {
        if (conn.from.node === sourceNodeId) {
            const target = wfState.nodes.get(conn.to.node);
            if (target && executableTypes.has(target.type)) downstream.push(conn.to.node);
        }
    }
    if (downstream.length === 0) return;
    const unique = [...new Set(downstream)];
    toast(`Auto-running ${unique.length} downstream node${unique.length > 1 ? 's' : ''}...`);
    for (const nodeId of unique) {
        try { await executeNode(nodeId); } catch (err) { /* executeNode already toasts errors */ }
        await new Promise(r => setTimeout(r, 500));
    }
}

// ==================== EXECUTION ENGINE ====================
async function apiRequest(endpoint, options = {}) {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const resp = await wfFetch('/api/workflow-editor/freepik' + endpoint, options);
        const text = await resp.text();
        if ((resp.status >= 500 || resp.status === 403) && attempt < maxRetries) {
            const delay = (attempt + 1) * 3000;
            console.warn(`API ${resp.status} on ${endpoint}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }
        if (resp.status === 429 && attempt < maxRetries) {
            const delay = (attempt + 1) * 5000;
            console.warn(`Rate limited on ${endpoint}, retry in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }
        try { return JSON.parse(text); }
        catch { throw new Error(`API returned non-JSON (HTTP ${resp.status}): ${text.substring(0, 150)}`); }
    }
}

async function apiPost(endpoint, body) {
    return apiRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function apiGet(endpoint) {
    return apiRequest(endpoint);
}

async function pollTask(pollUrl, label, abortSignal) {
    const start = Date.now(), timeout = 30 * 60 * 1000, interval = 5000;
    const toastKey = 'poll-' + label;
    try {
        while (Date.now() - start < timeout) {
            if (abortSignal?.aborted) throw new Error('Execution stopped');
            await new Promise(r => setTimeout(r, interval));
            const elapsed = Math.round((Date.now() - start) / 1000);
            toast(`${label}: polling... (${elapsed}s)`, 'info', toastKey);
            const resp = await apiGet(pollUrl);
            // Detect 404/not-found responses (e.g. wrong poll endpoint) — fail fast instead of polling forever
            if (resp?.code === 'not_found' || resp?.error === 'not_found' || resp?.status === 404 || resp?.code === 404) {
                throw new Error(`${label}: poll endpoint returned 404 (${pollUrl})`);
            }
            const status = resp?.data?.status || resp?.status || resp?.data?.wfState;
            if (['COMPLETED', 'completed', 'SUCCESS', 'success'].includes(status)) { removeToast(toastKey); return resp; }
            if (['FAILED', 'failed', 'ERROR', 'error'].includes(status)) { throw new Error(`${label}: ${resp?.data?.error || resp?.data?.message || 'Task failed'}`); }
            // If status is undefined after several polls, the endpoint is likely wrong
            if (!status && elapsed > 30) { throw new Error(`${label}: poll returned no status after ${elapsed}s — possible wrong endpoint (${pollUrl})`); }
            toast(`${label}: ${status || 'processing'}... (${elapsed}s)`, 'info', toastKey);
        }
        throw new Error(`${label}: timed out after 30 minutes`);
    } finally { removeToast(toastKey); }
}

function resolveInputs(nodeId) {
    const inputs = {};
    for (const conn of wfState.connections) {
        if (conn.to.node === nodeId) {
            const fromNode = wfState.nodes.get(conn.from.node);
            if (!fromNode) continue;
            let value = null;
            if (fromNode.type === 'text') { value = fromNode.config.text || ''; }
            else if (fromNode.type === 'upload') {
                const isAudio = fromNode.config.fileType === 'audio';
                if ((conn.type === 'audio' && isAudio) || (conn.type === 'image' && !isAudio)) value = fromNode.config.url || '';
            } else if (fromNode.result) {
                if (conn.type === 'image') value = fromNode.result.publicUrl || fromNode.result.imageUrl || '';
                else if (conn.type === 'video') value = fromNode.result.videoUrl || fromNode.result.publicUrl || '';
                else if (conn.type === 'audio') value = fromNode.result.publicUrl || '';
                else if (conn.type === 'text') value = fromNode.result.text || fromNode.config?.text || '';
            }
            inputs[conn.to.port] = value;
        }
    }
    return inputs;
}

function setNodeStatus(id, status) {
    const node = wfState.nodes.get(id);
    if (!node) return;
    node.status = status;
    if (status === 'running') node._runStart = Date.now();
    const el = document.getElementById('node-' + id);
    if (el) {
        el.classList.remove('running', 'completed', 'error');
        if (status !== 'idle') el.classList.add(status);
        const dot = el.querySelector('.node-header-status');
        if (dot) dot.className = 'node-header-status ' + status;
        // Running overlay with timer
        let overlay = el.querySelector('.node-running-overlay');
        if (status === 'running') {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'node-running-overlay';
                el.appendChild(overlay);
            }
            overlay.textContent = 'Processing...';
            clearInterval(node._timerInterval);
            node._timerInterval = setInterval(() => {
                const elapsed = Math.round((Date.now() - node._runStart) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                overlay.textContent = mins > 0 ? `Processing... ${mins}m ${secs}s` : `Processing... ${secs}s`;
            }, 1000);
        } else {
            if (overlay) overlay.remove();
            clearInterval(node._timerInterval);
        }
    }
}

async function executeNode(nodeId, abortSignal) {
    const node = wfState.nodes.get(nodeId);
    if (!node) return;
    const typeDef = NODE_TYPES[node.type];
    if (!['imageGen', 'videoGen', 'lipsync', 'upscaler', 'audioTrim'].includes(node.type)) { toast(`${typeDef.label} nodes don't need execution`, 'info'); return; }

    setNodeStatus(nodeId, 'running');
    toast(`Running ${typeDef.label}...`);

    try {
        const inputs = resolveInputs(nodeId);
        let result;
        switch (node.type) {
            case 'imageGen': result = await executeImageGen(node, inputs, abortSignal); break;
            case 'videoGen': result = await executeVideoGen(node, inputs, abortSignal); break;
            case 'lipsync': result = await executeLipsync(node, inputs, abortSignal); break;
            case 'upscaler': result = await executeUpscaler(node, inputs, abortSignal); break;
            case 'audioTrim': result = await executeAudioTrim(node, inputs, abortSignal); break;
        }
        node.result = result;
        setNodeStatus(nodeId, 'completed');
        rerenderNode(nodeId); updatePropsPanel();
        toast(`${typeDef.label} completed!`, 'success');
        autoSave();
        // Cascade: auto-run downstream nodes if not part of a pipeline run
        if (!abortSignal) autoRunDownstream(nodeId);
    } catch (err) {
        setNodeStatus(nodeId, 'error');
        toast(`${typeDef.label} failed: ${err.message}`, 'error');
        throw err;
    }
}

async function executeImageGen(node, inputs, abortSignal) {
    const prompt = inputs.text || node.config.prompt;
    if (!prompt) throw new Error('No prompt provided');
    const body = { prompt, resolution: node.config.resolution || '2k', aspect_ratio: node.config.aspect_ratio || 'widescreen_16_9', model: node.config.model || 'realism' };
    const styling = {};
    if (inputs.style_ref) styling.style = { url: inputs.style_ref, strength: node.config.style_strength || 90 };
    if (inputs.structure_ref) styling.structure = { url: inputs.structure_ref, strength: node.config.structure_strength || 50 };
    if (Object.keys(styling).length > 0) body.styling = styling;

    const submitResp = await apiPost('/v1/ai/mystic', body);
    const taskId = submitResp?.data?.task_id || submitResp?.task_id || submitResp?.data?.id;
    if (!taskId) throw new Error('No task_id returned: ' + JSON.stringify(submitResp).substring(0, 200));
    const result = await pollTask(`/v1/ai/mystic/${taskId}`, 'Image', abortSignal);
    const imageUrl = result?.data?.generated?.[0] || result?.data?.image?.url || result?.data?.images?.[0]?.url || result?.data?.result?.url || result?.data?.url;
    if (!imageUrl) throw new Error('No image URL in result: ' + JSON.stringify(result?.data || result).substring(0, 300));

    let publicUrl = imageUrl;
    try {
        const reupResp = await wfFetch('/api/workflow-editor/reupload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: imageUrl, filename: 'generated.png' }) });
        const reupData = await reupResp.json();
        if (reupData.url) publicUrl = reupData.url;
    } catch (e) { console.warn('Re-upload failed, using original URL'); }
    return { imageUrl, publicUrl };
}

async function executeVideoGen(node, inputs, abortSignal) {
    const prompt = inputs.text || node.config.prompt || 'cinematic movement';
    const engine = node.config.engine || 'kling-3-omni-pro';
    const endpoint = ENGINE_ENDPOINTS[engine];
    if (!endpoint) throw new Error('Unknown engine: ' + engine);

    let body, pollBase;
    if (OMNI_ENGINES.has(engine)) {
        // Kling 3 Omni — supports elements for character consistency
        body = { prompt, duration: String(node.config.duration || 5) };
        if (inputs.image) body.start_image_url = inputs.image;
        const elements = {};
        if (inputs.element_ref) {
            elements.reference_image_urls = [inputs.element_ref];
        }
        if (inputs.frontal_ref) {
            elements.frontal_image_url = inputs.frontal_ref;
        }
        if (Object.keys(elements).length > 0) {
            body.elements = [elements];
        }
        pollBase = '/v1/ai/video/kling-v3-omni';
    } else {
        // Legacy engines (Kling 2.x, Seedance) — image-to-video
        if (!inputs.image) throw new Error('No image connected');
        body = { image: inputs.image, prompt, duration: String(node.config.duration || 10) };
        pollBase = ENGINE_POLL_ENDPOINTS[engine] || endpoint;
    }

    const submitResp = await apiPost(endpoint, body);
    const taskId = submitResp?.data?.task_id || submitResp?.task_id || submitResp?.data?.id;
    if (!taskId) throw new Error('No task_id returned: ' + JSON.stringify(submitResp).substring(0, 300));
    const result = await pollTask(`${pollBase}/${taskId}`, 'Video', abortSignal);
    const videoUrl = result?.data?.generated?.[0] || result?.data?.video?.url || result?.data?.videos?.[0]?.url || result?.data?.result?.url || result?.data?.url;
    if (!videoUrl) throw new Error('No video URL in result: ' + JSON.stringify(result?.data || result).substring(0, 300));
    return { videoUrl, publicUrl: videoUrl };
}

async function executeLipsync(node, inputs, abortSignal) {
    if (!inputs.image) throw new Error('No image connected');
    if (!inputs.audio) throw new Error('No audio connected');
    const prompt = inputs.text || node.config.prompt || 'person speaking';
    const submitResp = await apiPost('/v1/ai/video/omni-human-1-5', { image: inputs.image, audio: inputs.audio, prompt });
    const taskId = submitResp?.data?.task_id || submitResp?.task_id || submitResp?.data?.id;
    if (!taskId) throw new Error('No task_id returned: ' + JSON.stringify(submitResp).substring(0, 300));
    const result = await pollTask(`/v1/ai/video/omni-human-1-5/${taskId}`, 'Lipsync', abortSignal);
    const videoUrl = result?.data?.generated?.[0] || result?.data?.video?.url || result?.data?.videos?.[0]?.url || result?.data?.result?.url || result?.data?.url;
    if (!videoUrl) throw new Error('No video URL in result: ' + JSON.stringify(result?.data || result).substring(0, 300));
    return { videoUrl, publicUrl: videoUrl };
}

async function executeUpscaler(node, inputs, abortSignal) {
    if (!inputs.image) throw new Error('No image connected');
    const submitResp = await apiPost('/v1/ai/magnific', { image: inputs.image, scale: String(node.config.scale || 2) });
    const taskId = submitResp?.data?.task_id || submitResp?.task_id || submitResp?.data?.id;
    if (!taskId) throw new Error('No task_id returned: ' + JSON.stringify(submitResp).substring(0, 300));
    const result = await pollTask(`/v1/ai/magnific/${taskId}`, 'Upscale', abortSignal);
    const imageResultUrl = result?.data?.generated?.[0] || result?.data?.image?.url || result?.data?.images?.[0]?.url || result?.data?.result?.url || result?.data?.url;
    if (!imageResultUrl) throw new Error('No image URL in result: ' + JSON.stringify(result?.data || result).substring(0, 300));

    let publicUrl = imageResultUrl;
    try {
        const reupResp = await wfFetch('/api/workflow-editor/reupload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: imageResultUrl, filename: 'upscaled.png' }) });
        const reupData = await reupResp.json();
        if (reupData.url) publicUrl = reupData.url;
    } catch (e) { console.warn('Re-upload failed'); }
    return { imageUrl: imageResultUrl, publicUrl };
}

async function executeAudioTrim(node, inputs, abortSignal) {
    if (!inputs.audio) throw new Error('No audio connected');
    const startTime = Number(node.config.start_time) || 0;
    const endTime = Number(node.config.end_time) || 30;
    if (endTime <= startTime) throw new Error('End time must be greater than start time');

    toast('Downloading audio for trimming...', 'info', 'audio-trim');
    const audioResp = await fetch(inputs.audio);
    if (!audioResp.ok) throw new Error('Failed to fetch audio: HTTP ' + audioResp.status);
    const arrayBuffer = await audioResp.arrayBuffer();

    toast('Decoding audio...', 'info', 'audio-trim');
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);

    const sampleRate = decoded.sampleRate;
    const channels = decoded.numberOfChannels;
    const startSample = Math.floor(startTime * sampleRate);
    const endSample = Math.min(Math.floor(endTime * sampleRate), decoded.length);
    const trimLength = endSample - startSample;
    if (trimLength <= 0) throw new Error('Trim range is empty');

    toast('Trimming audio...', 'info', 'audio-trim');
    const trimmed = audioCtx.createBuffer(channels, trimLength, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
        const src = decoded.getChannelData(ch);
        const dst = trimmed.getChannelData(ch);
        for (let i = 0; i < trimLength; i++) dst[i] = src[startSample + i];
    }
    audioCtx.close();

    // Encode to WAV
    const wavBuffer = encodeWAV(trimmed);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const formData = new FormData();
    formData.append('file', blob, `trimmed_${startTime}s-${endTime}s.wav`);

    toast('Uploading trimmed audio...', 'info', 'audio-trim');
    const uploadResp = await wfFetch('/api/workflow-editor/upload', { method: 'POST', body: formData });
    const uploadData = await uploadResp.json();
    if (uploadData.error) throw new Error(uploadData.error);
    removeToast('audio-trim');
    return { publicUrl: uploadData.url };
}

function encodeWAV(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitsPerSample = 16;
    const blockAlign = numChannels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const dataLength = audioBuffer.length * blockAlign;
    const headerLength = 44;
    const buffer = new ArrayBuffer(headerLength + dataLength);
    const view = new DataView(buffer);

    function writeString(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));
    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, channels[ch][i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
    }
    return buffer;
}

// ==================== RUN ALL ====================
function getExecutionOrder() {
    const order = [], visited = new Set(), visiting = new Set();
    const executableTypes = new Set(['imageGen', 'videoGen', 'lipsync', 'upscaler', 'audioTrim']);
    function visit(nodeId) {
        if (visited.has(nodeId)) return;
        if (visiting.has(nodeId)) throw new Error('Cycle detected');
        visiting.add(nodeId);
        for (const conn of wfState.connections) { if (conn.to.node === nodeId) visit(conn.from.node); }
        visiting.delete(nodeId); visited.add(nodeId);
        const node = wfState.nodes.get(nodeId);
        if (node && executableTypes.has(node.type)) order.push(nodeId);
    }
    for (const [id, node] of wfState.nodes) { if (executableTypes.has(node.type)) visit(id); }
    return order;
}

async function runAll() {
    let order;
    try { order = getExecutionOrder(); } catch (err) { toast(err.message, 'error'); return; }
    if (order.length === 0) { toast('No executable nodes found', 'info'); return; }
    const abortController = new AbortController();
    wfState.executionAbort = abortController;
    toast(`Running ${order.length} nodes...`);
    for (const nodeId of order) {
        if (abortController.signal.aborted) break;
        const node = wfState.nodes.get(nodeId);
        if (node.status === 'completed' && node.result) continue;
        try { await executeNode(nodeId, abortController.signal); }
        catch (err) { toast(`Pipeline stopped at ${NODE_TYPES[node.type].label}: ${err.message}`, 'error'); break; }
        await new Promise(r => setTimeout(r, 1500));
    }
    wfState.executionAbort = null;
    toast('Pipeline finished', 'success');
}

function stopExecution() { if (wfState.executionAbort) { wfState.executionAbort.abort(); wfState.executionAbort = null; toast('Execution stopped'); } }

// ==================== CONTEXT MENUS ====================
function showNodeContextMenu(x, y, nodeId) {
    const menu = document.getElementById('we-context-menu');
    menu.innerHTML = '';
    menu.style.display = 'block';
    menu.style.left = x + 'px'; menu.style.top = y + 'px';

    const items = [
        { icon: 'ic-play', label: 'Run Node', action: () => executeNode(nodeId) },
        { icon: 'ic-play', label: 'Run From Here', action: () => runFromNode(nodeId) },
        { separator: true },
        { icon: 'ic-copy', label: 'Duplicate', key: '⌘D', action: () => duplicateNode(nodeId) },
        { icon: 'ic-reset', label: 'Reset Status', action: () => { setNodeStatus(nodeId, 'idle'); wfState.nodes.get(nodeId).result = null; rerenderNode(nodeId); updatePropsPanel(); } },
        { separator: true },
        { icon: 'ic-trash', label: 'Delete', key: 'Del', cls: 'danger', action: () => deleteNode(nodeId) },
    ];

    for (const item of items) {
        if (item.separator) { menu.innerHTML += '<div class="ctx-separator"></div>'; continue; }
        const div = document.createElement('div');
        div.className = 'ctx-item' + (item.cls ? ' ' + item.cls : '');
        div.innerHTML = `${svgIcon(item.icon)} ${item.label}${item.key ? `<span class="ctx-key">${item.key}</span>` : ''}`;
        div.addEventListener('click', () => { hideContextMenu(); item.action(); });
        menu.appendChild(div);
    }
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
    });
}

function showConnectionContextMenu(x, y, connIdx) {
    const menu = document.getElementById('we-context-menu');
    menu.innerHTML = '';
    menu.style.display = 'block';
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    const div = document.createElement('div');
    div.className = 'ctx-item danger';
    div.innerHTML = `${svgIcon('ic-trash')} Delete Connection`;
    div.addEventListener('click', () => { hideContextMenu(); removeConnection(connIdx); });
    menu.appendChild(div);
}

function showCanvasContextMenu(x, y) {
    const pos = screenToCanvas(x, y);
    const menu = document.getElementById('we-context-menu');
    menu.innerHTML = '';
    menu.style.display = 'block';
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    for (const [type, def] of Object.entries(NODE_TYPES)) {
        const div = document.createElement('div');
        div.className = 'ctx-item';
        div.innerHTML = `<svg width="14" height="14" style="color:${def.color}"><use href="#${def.icon}"/></svg> Add ${def.label}`;
        div.addEventListener('click', () => { hideContextMenu(); const n = createNode(type, pos.x, pos.y); selectNode(n.id, false); });
        menu.appendChild(div);
    }
}

function hideContextMenu() { document.getElementById('we-context-menu').style.display = 'none'; }

async function runFromNode(startNodeId) {
    let order;
    try { order = getExecutionOrder(); } catch (err) { toast(err.message, 'error'); return; }
    const startIdx = order.indexOf(startNodeId);
    if (startIdx === -1) { toast('Node not in execution order', 'error'); return; }
    const subset = order.slice(startIdx);
    const abortController = new AbortController();
    wfState.executionAbort = abortController;
    toast(`Running ${subset.length} nodes...`);
    for (const nodeId of subset) {
        if (abortController.signal.aborted) break;
        try { await executeNode(nodeId, abortController.signal); } catch (err) { break; }
        await new Promise(r => setTimeout(r, 1500));
    }
    wfState.executionAbort = null;
}

// ==================== PALETTE ====================
function initPalette() {
    const palette = document.getElementById('we-node-palette');
    palette.innerHTML = '';
    for (const [type, def] of Object.entries(NODE_TYPES)) {
        const item = document.createElement('div');
        item.className = 'palette-item';
        item.dataset.nodeType = type;
        item.draggable = true;
        item.innerHTML = `
            <div class="palette-icon" style="background:rgba(255,255,255,0.03);color:${def.color}">${svgIcon(def.icon, 18)}</div>
            <div>
                <div class="palette-label">${def.label}</div>
                <div class="palette-desc">${def.desc}</div>
            </div>
        `;
        item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('nodeType', type); e.dataTransfer.effectAllowed = 'copy'; });
        palette.appendChild(item);
    }
}

// ==================== WORKFLOW SAVE/LOAD ====================
function serializeWorkflow() {
    return {
        nodes: [...wfState.nodes.values()].map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, config: n.config, result: n.result, status: n.status })),
        connections: wfState.connections.map(c => ({ from: c.from, to: c.to, type: c.type })),
        pan: wfState.pan, zoom: wfState.zoom, nextNodeId: wfState.nextNodeId,
    };
}

function loadWorkflow(data) {
    document.getElementById('we-canvas').innerHTML = '';
    wfState.nodes.clear(); wfState.connections = []; wfState.selectedNodes.clear();
    wfState.pan = data.pan || { x: 0, y: 0 }; wfState.zoom = data.zoom || 1; wfState.nextNodeId = data.nextNodeId || 1;
    for (const nd of data.nodes || []) {
        const node = { id: nd.id, type: nd.type, x: nd.x, y: nd.y, status: nd.status || 'idle', result: nd.result || null, config: nd.config || {} };
        wfState.nodes.set(node.id, node);
        const numMatch = node.id.match(/\d+/);
        if (numMatch) wfState.nextNodeId = Math.max(wfState.nextNodeId, parseInt(numMatch[0]) + 1);
    }
    wfState.connections = (data.connections || []).map(c => ({ from: c.from, to: c.to, type: c.type }));
    rerenderAll(); updateTransform();
}

function autoSave() { try { localStorage.setItem('freepik-nodes-autosave', JSON.stringify(serializeWorkflow())); } catch (e) {} }

function autoLoad() {
    try {
        const data = localStorage.getItem('freepik-nodes-autosave');
        if (data) { const parsed = JSON.parse(data); if (parsed.nodes && parsed.nodes.length > 0) { loadWorkflow(parsed); return true; } }
    } catch (e) {}
    return false;
}

function showSaveDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal"><h3>Save Workflow</h3><div class="prop-group"><label class="prop-label">Name</label><input class="prop-input" id="we-save-name" placeholder="my-workflow" autofocus></div><div class="modal-btns"><button class="tb-btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button><button class="tb-btn primary" id="we-save-confirm">Save</button></div></div>`;
    document.body.appendChild(overlay);
    const nameInput = document.getElementById("we-save-name");
    nameInput.focus();
    const doSave = async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Enter a name', 'error'); return; }
        try {
            const resp = await wfFetch('/api/workflow-editor/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, workflow: serializeWorkflow() }) });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);
            toast('Saved: ' + name, 'success'); overlay.remove(); refreshWorkflowList();
        } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    };
    document.getElementById("we-save-confirm").addEventListener('click', doSave);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function refreshWorkflowList() {
    const list = document.getElementById('we-workflow-list');
    try {
        const resp = await wfFetch('/api/workflow-editor/workflows');
        const workflows = await resp.json();
        list.innerHTML = '';
        for (const wf of workflows) {
            const item = document.createElement('div');
            item.className = 'wf-item';
            item.innerHTML = `<span class="wf-name">${escapeHtml(wf.name)}</span><span class="wf-del" title="Delete">&times;</span>`;
            item.querySelector('.wf-name').addEventListener('click', async () => {
                try {
                    const resp = await wfFetch('/api/workflow-editor/workflows/' + encodeURIComponent(wf.name));
                    const data = await resp.json();
                    if (data.error) throw new Error(data.error);
                    loadWorkflow(data); toast('Loaded: ' + wf.name, 'success');
                } catch (err) { toast('Load failed: ' + err.message, 'error'); }
            });
            item.querySelector('.wf-del').addEventListener('click', async (e) => {
                e.stopPropagation();
                try { await wfFetch('/api/workflow-editor/workflows/' + encodeURIComponent(wf.name), { method: 'DELETE' }); refreshWorkflowList(); toast('Deleted: ' + wf.name, 'success'); }
                catch (err) { toast('Delete failed: ' + err.message, 'error'); }
            });
            list.appendChild(item);
        }
    } catch (err) { list.innerHTML = '<div class="prop-empty" style="padding:8px">Server not reachable</div>'; }
}

function clearCanvas() {
    if (wfState.nodes.size === 0) return;
    if (!confirm(`Clear all ${wfState.nodes.size} nodes and ${wfState.connections.length} connections?`)) return;
    document.getElementById('we-canvas').innerHTML = '';
    wfState.nodes.clear(); wfState.connections = []; wfState.selectedNodes.clear();
    renderConnections(); updatePropsPanel(); autoSave(); toast('Canvas cleared');
}

// ==================== EVENT HANDLERS ====================
function initCanvasEvents() {
    const container = document.getElementById('we-canvas-container');

    container.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('port-dot')) return;
        if (e.button === 2) return;
        if (e.target === container || e.target === document.getElementById('we-canvas-bg') || e.target === document.getElementById('we-canvas')) {
            if (e.button === 0) {
                if (e.shiftKey) {
                    wfState.isSelecting = true;
                    wfState.selectionStart = { x: e.clientX, y: e.clientY };
                    const box = document.getElementById('we-selection-box');
                    box.style.display = 'block'; box.style.left = e.clientX + 'px'; box.style.top = e.clientY + 'px'; box.style.width = '0px'; box.style.height = '0px';
                } else {
                    wfState.isPanning = true;
                    wfState.dragStart = { x: e.clientX - wfState.pan.x, y: e.clientY - wfState.pan.y };
                    container.classList.add('panning');
                    deselectAll();
                }
            }
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (wfState.isPanning) { wfState.pan.x = e.clientX - wfState.dragStart.x; wfState.pan.y = e.clientY - wfState.dragStart.y; updateTransform(); }

        if (wfState.isDragging && wfState.dragStart) {
            const dx = (e.clientX - wfState.dragStart.x) / wfState.zoom, dy = (e.clientY - wfState.dragStart.y) / wfState.zoom;
            for (const id of wfState.selectedNodes) {
                const node = wfState.nodes.get(id), off = wfState.dragNodeOffset[id];
                if (node && off) { node.x = off.x + dx; node.y = off.y + dy; const el = document.getElementById('node-' + id); if (el) { el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; } }
            }
            renderConnections();
        }

        if (wfState.isConnecting && wfState.connectFrom) {
            const fromPos = getPortPosition(wfState.connectFrom.node, wfState.connectFrom.port, wfState.connectFrom.dir);
            const containerRect = document.getElementById('we-canvas-container').getBoundingClientRect();
            const mousePos = { x: e.clientX - containerRect.left, y: e.clientY - containerRect.top };
            const dragPath = document.getElementById('we-drag-connection');
            if (wfState.connectFrom.dir === 'output') dragPath.setAttribute('d', bezierPath(fromPos.x, fromPos.y, mousePos.x, mousePos.y));
            else dragPath.setAttribute('d', bezierPath(mousePos.x, mousePos.y, fromPos.x, fromPos.y));
        }

        if (wfState.isSelecting && wfState.selectionStart) {
            const box = document.getElementById('we-selection-box');
            box.style.left = Math.min(e.clientX, wfState.selectionStart.x) + 'px'; box.style.top = Math.min(e.clientY, wfState.selectionStart.y) + 'px';
            box.style.width = Math.abs(e.clientX - wfState.selectionStart.x) + 'px'; box.style.height = Math.abs(e.clientY - wfState.selectionStart.y) + 'px';
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (wfState.isPanning) { wfState.isPanning = false; container.classList.remove('panning'); }
        if (wfState.isDragging) { wfState.isDragging = false; wfState.dragStart = null; wfState.dragNodeOffset = null; autoSave(); }
        if (wfState.isConnecting && wfState.connectFrom) {
            const target = document.elementFromPoint(e.clientX, e.clientY);
            if (target && target.classList.contains('port-dot')) {
                addConnection(wfState.connectFrom, { node: target.dataset.node, port: target.dataset.port, type: target.dataset.type, dir: target.dataset.dir });
            }
            wfState.isConnecting = false; wfState.connectFrom = null;
            document.getElementById('we-drag-connection').setAttribute('d', '');
        }
        if (wfState.isSelecting) {
            const box = document.getElementById('we-selection-box');
            const boxRect = box.getBoundingClientRect();
            box.style.display = 'none'; wfState.isSelecting = false; wfState.selectionStart = null;
            deselectAll();
            for (const [id] of wfState.nodes) {
                const nodeEl = document.getElementById('node-' + id);
                if (nodeEl) {
                    const r = nodeEl.getBoundingClientRect();
                    if (r.left < boxRect.right && r.right > boxRect.left && r.top < boxRect.bottom && r.bottom > boxRect.top) {
                        wfState.selectedNodes.add(id); nodeEl.classList.add('selected');
                    }
                }
            }
            updatePropsPanel();
        }
    });

    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const oldZoom = wfState.zoom;
        wfState.zoom = clamp(wfState.zoom * (e.deltaY > 0 ? 0.92 : 1.08), 0.1, 3);
        wfState.pan.x = mx - (mx - wfState.pan.x) * (wfState.zoom / oldZoom);
        wfState.pan.y = my - (my - wfState.pan.y) * (wfState.zoom / oldZoom);
        updateTransform();
    }, { passive: false });

    container.addEventListener('dragover', (e) => e.preventDefault());
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData('nodeType');
        if (!type || !NODE_TYPES[type]) return;
        const pos = screenToCanvas(e.clientX, e.clientY);
        const n = createNode(type, pos.x - 120, pos.y - 20);
        selectNode(n.id, false);
    });

    container.addEventListener('contextmenu', (e) => {
        if (e.target === container || e.target === document.getElementById('we-canvas-bg') || e.target === document.getElementById('we-canvas')) {
            e.preventDefault(); showCanvasContextMenu(e.clientX, e.clientY);
        }
    });

    document.addEventListener('click', (e) => { if (!e.target.closest('.context-menu')) hideContextMenu(); });

    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (e.key === 'Delete' || e.key === 'Backspace') { [...wfState.selectedNodes].forEach(id => deleteNode(id)); }
        if (e.key === 'a' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); for (const id of wfState.nodes.keys()) { wfState.selectedNodes.add(id); const el = document.getElementById('node-' + id); if (el) el.classList.add('selected'); } updatePropsPanel(); }
        if (e.key === 'd' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const toDup = [...wfState.selectedNodes]; deselectAll(); toDup.forEach(id => duplicateNode(id)); }
        if (e.key === 'Escape') { deselectAll(); hideContextMenu(); }
        if (e.key === 'f' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fitToView(); }
    });

    window.addEventListener('resize', () => { drawGrid(); renderConnections(); });
}

// ==================== AI AGENT ====================

const agent = {
    messages: [],
    isProcessing: false,
    abortController: null,
    memory: { skills: {}, patterns: {}, history: [] },
    chatOpen: false,
};

// -- Chat Panel Toggle --
function toggleChatPanel() {
    agent.chatOpen = !agent.chatOpen;
    const chatPanel = document.getElementById('we-chat-panel');
    const propsPanel = document.getElementById('we-props-panel');
    const toggleBtn = document.getElementById('we-chat-toggle-btn');
    if (agent.chatOpen) {
        chatPanel.classList.add('active');
        propsPanel.style.display = 'none';
        toggleBtn.classList.add('chat-active');
        document.getElementById('we-chat-input').focus();
        if (agent.messages.length === 0) {
            appendChatMessage('assistant', 'Hello! I can help you build and manage workflows. Try:\n\n- "Create a 3-scene music video pipeline"\n- "Add an image generator node"\n- "Connect node n1 to node n2"\n- "Run everything"\n- "Save this as my-workflow"');
        }
    } else {
        chatPanel.classList.remove('active');
        propsPanel.style.display = '';
        toggleBtn.classList.remove('chat-active');
    }
}

// -- Chat UI Rendering --
function appendChatMessage(role, text) {
    const container = document.getElementById('we-chat-messages');
    const el = document.createElement('div');
    el.className = 'chat-msg ' + role;
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

function appendActionCard(toolName, input, result) {
    const container = document.getElementById('we-chat-messages');
    const el = document.createElement('div');
    el.className = 'chat-action';
    const summary = describeAction(toolName, input);
    const detail = JSON.stringify(result, null, 2).substring(0, 500);
    el.innerHTML = `<div class="chat-action-header">${svgIcon('ic-play', 12)} ${escapeHtml(summary)}</div><div class="chat-action-detail"><pre>${escapeHtml(detail)}</pre></div>`;
    el.addEventListener('click', () => el.classList.toggle('expanded'));
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

function describeAction(toolName, input) {
    switch (toolName) {
        case 'create_node': return `Created ${input.type} node at (${input.x}, ${input.y})`;
        case 'delete_node': return `Deleted node ${input.node_id}`;
        case 'configure_node': return `Configured node ${input.node_id}`;
        case 'connect_nodes': return `Connected ${input.from_node}:${input.from_port} → ${input.to_node}:${input.to_port}`;
        case 'disconnect_nodes': return `Disconnected ${input.from_node}:${input.from_port} → ${input.to_node}:${input.to_port}`;
        case 'run_node': return `Running node ${input.node_id}`;
        case 'run_all': return 'Running all nodes';
        case 'clear_canvas': return 'Cleared canvas';
        case 'load_workflow': return `Loading workflow: ${input.name}`;
        case 'save_workflow': return `Saving workflow: ${input.name}`;
        case 'get_canvas_state': return 'Reading canvas state';
        case 'save_memory': return `Saving memory: ${input.key}`;
        case 'recall_memory': return `Recalling memory${input.key ? ': ' + input.key : ''}`;
        case 'inspect_node': return `Inspecting node ${input.node_id}`;
        case 'reset_node': return `Resetting node ${input.node_id}`;
        case 'list_workflows': return 'Listing saved workflows';
        case 'new_conversation': return 'Clearing conversation';
        default: return toolName;
    }
}

function showThinking() {
    const container = document.getElementById('we-chat-messages');
    let el = document.getElementById("we-chat-thinking");
    if (el) return;
    el = document.createElement('div');
    el.className = 'chat-thinking';
    el.id = 'we-chat-thinking';
    el.innerHTML = '<div class="chat-thinking-dots"><span></span><span></span><span></span></div><span>Thinking...</span>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

function hideThinking() {
    const el = document.getElementById("we-chat-thinking");
    if (el) el.remove();
}

// -- Tool Definitions for Claude API --
const AGENT_TOOLS = [
    {
        name: 'create_node',
        description: 'Create a new node on the canvas. Returns the created node ID and details.',
        input_schema: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['text', 'upload', 'imageGen', 'videoGen', 'lipsync', 'upscaler', 'audioTrim'], description: 'The node type to create' },
                x: { type: 'number', description: 'X position on canvas (use multiples of ~320 for horizontal spacing)' },
                y: { type: 'number', description: 'Y position on canvas (use multiples of ~220 for vertical spacing)' },
                config: { type: 'object', description: 'Optional initial configuration (e.g. {text: "a cat"} for text nodes, {prompt: "...", engine: "kling-3-omni-pro"} for videoGen)' }
            },
            required: ['type', 'x', 'y']
        }
    },
    {
        name: 'delete_node',
        description: 'Delete a node from the canvas by its ID.',
        input_schema: {
            type: 'object',
            properties: { node_id: { type: 'string', description: 'The node ID (e.g. "n1")' } },
            required: ['node_id']
        }
    },
    {
        name: 'configure_node',
        description: 'Update the configuration of an existing node. Merges the config object with existing config.',
        input_schema: {
            type: 'object',
            properties: {
                node_id: { type: 'string', description: 'The node ID' },
                config: { type: 'object', description: 'Config fields to update (e.g. {prompt: "new prompt", engine: "kling-2.6-pro"})' }
            },
            required: ['node_id', 'config']
        }
    },
    {
        name: 'connect_nodes',
        description: 'Connect an output port of one node to an input port of another. Port types must match (text→text, image→image, etc.).',
        input_schema: {
            type: 'object',
            properties: {
                from_node: { type: 'string', description: 'Source node ID' },
                from_port: { type: 'string', description: 'Source output port ID (e.g. "text", "image", "video", "audio")' },
                to_node: { type: 'string', description: 'Target node ID' },
                to_port: { type: 'string', description: 'Target input port ID' }
            },
            required: ['from_node', 'from_port', 'to_node', 'to_port']
        }
    },
    {
        name: 'disconnect_nodes',
        description: 'Remove a connection between two nodes.',
        input_schema: {
            type: 'object',
            properties: {
                from_node: { type: 'string', description: 'Source node ID' },
                from_port: { type: 'string', description: 'Source output port ID' },
                to_node: { type: 'string', description: 'Target node ID' },
                to_port: { type: 'string', description: 'Target input port ID' }
            },
            required: ['from_node', 'from_port', 'to_node', 'to_port']
        }
    },
    {
        name: 'run_node',
        description: 'Execute a single node (imageGen, videoGen, lipsync, upscaler, or audioTrim). This triggers the API call/processing and waits for the result.',
        input_schema: {
            type: 'object',
            properties: { node_id: { type: 'string', description: 'The node ID to execute' } },
            required: ['node_id']
        }
    },
    {
        name: 'run_all',
        description: 'Execute all executable nodes in dependency order. Skips already-completed nodes.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'clear_canvas',
        description: 'Remove all nodes and connections from the canvas.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'load_workflow',
        description: 'Load a saved workflow by name onto the canvas, replacing current wfState.',
        input_schema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Workflow name to load' } },
            required: ['name']
        }
    },
    {
        name: 'save_workflow',
        description: 'Save the current canvas wfState as a named workflow.',
        input_schema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Name to save the workflow as' } },
            required: ['name']
        }
    },
    {
        name: 'get_canvas_state',
        description: 'Get a summary of the current canvas wfState including all nodes, their configurations, connections, and statuses.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'save_memory',
        description: 'Save a key-value pair to long-term agent memory. Use this to remember workflow patterns, user preferences, things that worked or failed.',
        input_schema: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Memory key (e.g. "music-video-template", "user-preference-engine")' },
                value: { type: 'string', description: 'Value to remember (JSON string for complex data)' }
            },
            required: ['key', 'value']
        }
    },
    {
        name: 'recall_memory',
        description: 'Recall stored information from long-term memory. Omit key to get all memories.',
        input_schema: {
            type: 'object',
            properties: { key: { type: 'string', description: 'Optional specific key to recall' } }
        }
    },
    {
        name: 'inspect_node',
        description: 'Get detailed information about a specific node including its full config, result data, connection status, and resolved inputs.',
        input_schema: {
            type: 'object',
            properties: { node_id: { type: 'string', description: 'The node ID to inspect' } },
            required: ['node_id']
        }
    },
    {
        name: 'reset_node',
        description: 'Reset a node to idle status, clearing its result. Use this to fix stuck or errored nodes so they can be re-run.',
        input_schema: {
            type: 'object',
            properties: { node_id: { type: 'string', description: 'The node ID to reset' } },
            required: ['node_id']
        }
    },
    {
        name: 'list_workflows',
        description: 'List all saved workflows available to load.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'new_conversation',
        description: 'Clear the conversation history to start fresh. Use when context gets too long or confused.',
        input_schema: { type: 'object', properties: {} }
    }
];

// Convert AGENT_TOOLS (Anthropic format) → Gemini functionDeclarations format
function getGeminiTools() {
    return [{
        functionDeclarations: AGENT_TOOLS.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
        }))
    }];
}

// -- System Prompt Builder --
function buildSystemPrompt() {
    const nodeTypeInfo = Object.entries(NODE_TYPES).map(([type, def]) => {
        return `- **${type}** ("${def.label}"): ${def.desc}\n  Inputs: ${def.inputs.map(i => `${i.id}(${i.type})`).join(', ') || 'none'}\n  Outputs: ${def.outputs.map(o => `${o.id}(${o.type})`).join(', ')}\n  Defaults: ${JSON.stringify(def.defaults)}`;
    }).join('\n');

    const engineInfo = Object.entries(ENGINE_ENDPOINTS).map(([name, endpoint]) => {
        const isOmni = OMNI_ENGINES.has(name);
        return `- ${name}: ${endpoint}${isOmni ? ' (supports elements/character consistency, 3-15s duration)' : ' (image-to-video, 5-10s duration)'}`;
    }).join('\n');

    const canvasState = serializeWorkflow();
    const nodesSummary = canvasState.nodes.map(n => {
        return `  ${n.id} (${n.type}): pos=(${Math.round(n.x)},${Math.round(n.y)}) status=${n.status} config=${JSON.stringify(n.config)}${n.result ? ' HAS_RESULT' : ''}`;
    }).join('\n') || '  (empty canvas)';
    const connSummary = canvasState.connections.map(c => `  ${c.from.node}:${c.from.port} → ${c.to.node}:${c.to.port} (${c.type})`).join('\n') || '  (no connections)';

    const memorySection = Object.keys(agent.memory.skills).length > 0 || Object.keys(agent.memory.patterns).length > 0
        ? `\n## Working Memory\nSkills: ${JSON.stringify(agent.memory.skills)}\nPatterns: ${JSON.stringify(agent.memory.patterns)}`
        : '';

    return `You are an AI assistant embedded in the Freepik Node Editor — a visual node-based workflow builder for AI image and video generation using the Freepik API.

## Your Capabilities
You can create, configure, connect, and execute nodes on the canvas. You help users build image/video generation pipelines conversationally.

## Node Types
${nodeTypeInfo}

## Connection Rules
- Ports connect by type: text→text, image→image, audio→audio, video→video
- Each input port accepts only one connection (latest replaces previous)
- Output ports can connect to multiple inputs

## Available Video Engines
${engineInfo}

## Layout Conventions
- Horizontal spacing: ~320px between columns of nodes
- Vertical spacing: ~220px between rows
- Start at approximately x=100, y=100
- Flow goes left-to-right: text/upload nodes → generators → post-processing

## Current Canvas State
Nodes:
${nodesSummary}
Connections:
${connSummary}
${memorySection}

## Auto-Execution
- The system supports AUTO-EXECUTION: when an Upload node receives a file, all directly connected downstream nodes run automatically.
- When any node completes (and wasn't part of a pipeline run), its downstream nodes also auto-execute.
- This means you CAN build reactive workflows: wire Upload → AudioTrim → Lipsync and it cascades automatically when the user uploads a file.
- You CAN combine functionality by wiring nodes together. For example, "a node that trims audio on upload" = Upload node connected to AudioTrim node. The auto-execution handles the rest.

## Instructions
- Use tools to manipulate the canvas. Always use get_canvas_state first if unsure about current wfState.
- When creating workflows, lay out nodes neatly with proper spacing.
- Connect nodes after creating them.
- When users ask to "combine" nodes or create custom behavior, build it by connecting existing nodes together — auto-execution makes them work as a single unit.
- For a "music video" pipeline: create text prompts for each scene, image generators, then video generators.
- After building something that works well, offer to save it to memory for future reuse.
- When the user asks to "remember" or "save as template", use save_memory.
- Be concise in responses. Show what you did, not lengthy explanations.
- If an operation fails, USE YOUR TOOLS to diagnose and fix the issue. Use inspect_node to check state, reset_node to clear errors, and retry. NEVER give the user troubleshooting tips or tell them to check settings. Instead: reset the failed node, inspect it, check connections, and run it again. If it fails again, try a different approach (different engine, different config). Be hands-on — you are the operator, not a help desk.
- NEVER say "I can't" or "you'll need to". You have full control of the canvas. If something fails, retry it, reconfigure it, or work around it.
- API errors (403, 429, 500) are usually transient. Reset the node and retry before assuming anything is permanently broken.
- You can use list_workflows to find saved workflows before loading them.`;
}

// -- Tool Executor --
async function executeAgentTool(toolName, input) {
    switch (toolName) {
        case 'create_node': {
            const node = createNode(input.type, input.x, input.y, { config: input.config || {} });
            if (!node) return { error: `Unknown node type: ${input.type}` };
            return { success: true, node_id: node.id, type: node.type, position: { x: node.x, y: node.y } };
        }
        case 'delete_node': {
            if (!wfState.nodes.has(input.node_id)) return { error: `Node ${input.node_id} not found` };
            deleteNode(input.node_id);
            return { success: true, deleted: input.node_id };
        }
        case 'configure_node': {
            const node = wfState.nodes.get(input.node_id);
            if (!node) return { error: `Node ${input.node_id} not found` };
            Object.assign(node.config, input.config);
            if (node.type === 'text' && input.config.text !== undefined) {
                node.result = input.config.text ? { text: input.config.text } : null;
            }
            rerenderNode(node.id);
            updatePropsPanel();
            autoSave();
            return { success: true, node_id: node.id, config: node.config };
        }
        case 'connect_nodes': {
            const fromNode = wfState.nodes.get(input.from_node);
            const toNode = wfState.nodes.get(input.to_node);
            if (!fromNode) return { error: `Source node ${input.from_node} not found` };
            if (!toNode) return { error: `Target node ${input.to_node} not found` };
            const fromTypeDef = NODE_TYPES[fromNode.type];
            const toTypeDef = NODE_TYPES[toNode.type];
            const fromPort = fromTypeDef.outputs.find(o => o.id === input.from_port);
            const toPort = toTypeDef.inputs.find(i => i.id === input.to_port);
            if (!fromPort) return { error: `Output port "${input.from_port}" not found on ${input.from_node} (${fromNode.type}). Available: ${fromTypeDef.outputs.map(o=>o.id).join(', ')}` };
            if (!toPort) return { error: `Input port "${input.to_port}" not found on ${input.to_node} (${toNode.type}). Available: ${toTypeDef.inputs.map(i=>i.id).join(', ')}` };
            if (fromPort.type !== toPort.type) return { error: `Type mismatch: ${fromPort.type} → ${toPort.type}` };
            const ok = addConnection(
                { node: input.from_node, port: input.from_port, type: fromPort.type, dir: 'output' },
                { node: input.to_node, port: input.to_port, type: toPort.type, dir: 'input' }
            );
            return ok ? { success: true } : { error: 'Connection failed' };
        }
        case 'disconnect_nodes': {
            const idx = wfState.connections.findIndex(c =>
                c.from.node === input.from_node && c.from.port === input.from_port &&
                c.to.node === input.to_node && c.to.port === input.to_port
            );
            if (idx === -1) return { error: 'Connection not found' };
            removeConnection(idx);
            return { success: true };
        }
        case 'run_node': {
            if (!wfState.nodes.has(input.node_id)) return { error: `Node ${input.node_id} not found` };
            try {
                await executeNode(input.node_id);
                const node = wfState.nodes.get(input.node_id);
                return { success: true, status: node.status, hasResult: !!node.result };
            } catch (err) {
                return { error: err.message };
            }
        }
        case 'run_all': {
            try {
                await runAll();
                return { success: true, message: 'Pipeline execution completed' };
            } catch (err) {
                return { error: err.message };
            }
        }
        case 'clear_canvas': {
            document.getElementById('we-canvas').innerHTML = '';
            wfState.nodes.clear();
            wfState.connections = [];
            wfState.selectedNodes.clear();
            renderConnections();
            updatePropsPanel();
            autoSave();
            return { success: true, message: 'Canvas cleared' };
        }
        case 'load_workflow': {
            try {
                const resp = await wfFetch('/api/workflow-editor/workflows/' + encodeURIComponent(input.name));
                const data = await resp.json();
                if (data.error) return { error: data.error };
                loadWorkflow(data);
                return { success: true, nodes: data.nodes?.length || 0, connections: data.connections?.length || 0 };
            } catch (err) {
                return { error: err.message };
            }
        }
        case 'save_workflow': {
            try {
                const workflow = serializeWorkflow();
                const resp = await wfFetch('/api/workflow-editor/workflows', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: input.name, workflow })
                });
                const data = await resp.json();
                if (data.error) return { error: data.error };
                refreshWorkflowList();
                return { success: true, saved: data.saved };
            } catch (err) {
                return { error: err.message };
            }
        }
        case 'get_canvas_state': {
            const ws = serializeWorkflow();
            return {
                nodes: ws.nodes.map(n => ({
                    id: n.id, type: n.type,
                    position: { x: Math.round(n.x), y: Math.round(n.y) },
                    status: n.status, config: n.config,
                    hasResult: !!n.result
                })),
                connections: ws.connections.map(c => ({
                    from: `${c.from.node}:${c.from.port}`,
                    to: `${c.to.node}:${c.to.port}`,
                    type: c.type
                })),
                totalNodes: ws.nodes.length,
                totalConnections: ws.connections.length
            };
        }
        case 'save_memory': {
            agent.memory.patterns[input.key] = input.value;
            await saveAgentMemory();
            return { success: true, key: input.key };
        }
        case 'recall_memory': {
            if (input.key) {
                const val = agent.memory.patterns[input.key] || agent.memory.skills[input.key];
                return val ? { key: input.key, value: val } : { error: `Key "${input.key}" not found in memory` };
            }
            return { patterns: agent.memory.patterns, skills: agent.memory.skills };
        }
        case 'inspect_node': {
            const node = wfState.nodes.get(input.node_id);
            if (!node) return { error: `Node ${input.node_id} not found` };
            const typeDef = NODE_TYPES[node.type];
            const inputs = resolveInputs(node.id);
            const incomingConns = wfState.connections.filter(c => c.to.node === node.id).map(c => ({
                from: `${c.from.node}:${c.from.port}`, to_port: c.to.port, type: c.type
            }));
            const outgoingConns = wfState.connections.filter(c => c.from.node === node.id).map(c => ({
                to: `${c.to.node}:${c.to.port}`, from_port: c.from.port, type: c.type
            }));
            return {
                id: node.id, type: node.type, label: typeDef.label,
                position: { x: Math.round(node.x), y: Math.round(node.y) },
                status: node.status,
                config: node.config,
                result: node.result ? { hasResult: true, imageUrl: !!node.result.imageUrl, videoUrl: !!node.result.videoUrl, publicUrl: node.result.publicUrl || null, text: node.result.text || null } : null,
                resolvedInputs: inputs,
                incomingConnections: incomingConns,
                outgoingConnections: outgoingConns,
                availableInputPorts: typeDef.inputs.map(p => ({ id: p.id, type: p.type })),
                availableOutputPorts: typeDef.outputs.map(p => ({ id: p.id, type: p.type })),
            };
        }
        case 'reset_node': {
            const node = wfState.nodes.get(input.node_id);
            if (!node) return { error: `Node ${input.node_id} not found` };
            node.status = 'idle';
            node.result = null;
            setNodeStatus(node.id, 'idle');
            rerenderNode(node.id);
            updatePropsPanel();
            autoSave();
            return { success: true, node_id: node.id, status: 'idle' };
        }
        case 'list_workflows': {
            try {
                const resp = await wfFetch('/api/workflow-editor/workflows');
                const workflows = await resp.json();
                return { workflows: workflows.map(w => ({ name: w.name, modified: w.modified })) };
            } catch (err) {
                return { error: err.message };
            }
        }
        case 'new_conversation': {
            agent.messages = [];
            return { success: true, message: 'Conversation cleared' };
        }
        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

// -- Working Memory --
async function loadAgentMemory() {
    try {
        const resp = await wfFetch('/api/workflow-editor/agent-memory');
        if (resp.ok) {
            const data = await resp.json();
            agent.memory = { skills: data.skills || {}, patterns: data.patterns || {}, history: data.history || [] };
        }
    } catch (e) {}
    // Don't restore old conversation — start fresh each session to avoid orphaned tool_result errors
    agent.messages = [];
}

async function saveAgentMemory() {
    try {
        await wfFetch('/api/workflow-editor/agent-memory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(agent.memory)
        });
    } catch (e) {}
}

function sanitizeMessages(messages) {
    // Ensure no orphaned functionResponse parts exist without a preceding functionCall
    const clean = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'user' && Array.isArray(msg.parts) && msg.parts.some(p => p.functionResponse)) {
            // This is a function result message — check the previous model message has matching functionCall
            const prevModel = clean.length > 0 ? clean[clean.length - 1] : null;
            if (!prevModel || prevModel.role !== 'model' || !Array.isArray(prevModel.parts)) {
                continue; // Orphaned functionResponse — skip
            }
            const calledNames = new Set(prevModel.parts.filter(p => p.functionCall).map(p => p.functionCall.name));
            const validParts = msg.parts.filter(p => p.functionResponse && calledNames.has(p.functionResponse.name));
            if (validParts.length > 0) {
                clean.push({ role: 'user', parts: validParts });
            }
        } else {
            clean.push(msg);
        }
    }
    return clean;
}

function trimConversation(messages, maxMessages = 30) {
    if (messages.length <= maxMessages) return messages;
    // Find a safe trim point — don't break in the middle of a functionCall/functionResponse pair
    let trimStart = messages.length - maxMessages;
    while (trimStart < messages.length) {
        const msg = messages[trimStart];
        // Don't start on a functionResponse message or a model message with functionCall
        if (msg.role === 'user' && Array.isArray(msg.parts) && msg.parts.some(p => p.functionResponse)) { trimStart++; continue; }
        if (msg.role === 'model' && Array.isArray(msg.parts) && msg.parts.some(p => p.functionCall)) { trimStart++; continue; }
        break;
    }
    return messages.slice(trimStart);
}

function saveConversationToLocal() {
    // Intentionally not saving to avoid stale functionCall/functionResponse corruption across sessions
}

// -- Conversation Loop --
function stopChatAgent() {
    if (agent.abortController) {
        agent.abortController.abort();
        agent.abortController = null;
    }
}

async function sendChatMessage() {
    const input = document.getElementById('we-chat-input');
    const text = input.value.trim();
    if (!text || agent.isProcessing) return;

    input.value = '';
    input.style.height = 'auto';
    agent.isProcessing = true;
    agent.abortController = new AbortController();

    // Swap send button to stop button
    let sendBtn = document.getElementById('we-chat-send-btn');
    sendBtn.innerHTML = `${svgIcon('ic-stop', 14)}`;
    sendBtn.onclick = stopChatAgent;
    sendBtn.classList.add('stop-mode');

    appendChatMessage('user', text);
    agent.messages.push({ role: 'user', parts: [{ text }] });

    showThinking();

    try {
        let consecutiveErrors = 0;
        const abortSignal = agent.abortController?.signal;

        while (true) {
            if (abortSignal?.aborted) {
                hideThinking();
                appendChatMessage('assistant', '(Stopped by user.)');
                break;
            }
            const cleanMessages = sanitizeMessages(trimConversation(agent.messages));
            const systemPrompt = buildSystemPrompt();
            const models = ['gemini-2.5-pro', 'gemini-2.0-flash'];

            // Retry loop with model fallback for overloaded API
            let resp, data;
            for (let attempt = 0; attempt < 5; attempt++) {
                const model = attempt < 3 ? models[0] : models[1];
                const reqBody = JSON.stringify({
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: cleanMessages,
                    tools: getGeminiTools(),
                    generationConfig: { maxOutputTokens: 8192 },
                });
                resp = await wfFetch(`/api/workflow-editor/chat?model=${model}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: reqBody,
                });
                if (resp.status === 503 || resp.status === 429) {
                    const wait = (attempt + 1) * 3;
                    const fallbackNote = attempt === 2 ? ' (switching to faster model)' : '';
                    hideThinking();
                    appendChatMessage('assistant', `API busy, retrying in ${wait}s...${fallbackNote}`);
                    showThinking();
                    await new Promise(r => setTimeout(r, wait * 1000));
                    continue;
                }
                break;
            }

            if (!resp.ok) {
                consecutiveErrors++;
                const errData = await resp.json().catch(() => ({}));
                if (consecutiveErrors >= 3) {
                    throw new Error(errData.error?.message || errData.error || `API error: ${resp.status}`);
                }
                hideThinking();
                appendChatMessage('assistant', `API error (attempt ${consecutiveErrors}/3), retrying...`);
                showThinking();
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            consecutiveErrors = 0;

            data = await resp.json();
            hideThinking();

            const candidate = data.candidates?.[0];
            if (!candidate) {
                throw new Error('No response from Gemini API');
            }

            // Handle safety filter blocks
            if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
                appendChatMessage('assistant', `Response blocked by safety filter (${candidate.finishReason}). Try rephrasing your request.`);
                break;
            }

            const parts = candidate.content?.parts || [];

            // Collect text and functionCall parts
            const textParts = [];
            const functionCalls = [];

            for (const part of parts) {
                if (part.text) textParts.push(part.text);
                if (part.functionCall) functionCalls.push(part.functionCall);
            }

            // Show text response
            if (textParts.length > 0) {
                const fullText = textParts.join('\n');
                appendChatMessage('assistant', fullText);
            }

            // Append model message to conversation
            agent.messages.push({ role: 'model', parts });

            if (candidate.finishReason === 'STOP' || functionCalls.length === 0) {
                break;
            }

            // Process tool calls
            showThinking();
            const toolResultParts = [];
            for (const fc of functionCalls) {
                const result = await executeAgentTool(fc.name, fc.args);
                appendActionCard(fc.name, fc.args, result);
                toolResultParts.push({
                    functionResponse: {
                        name: fc.name,
                        response: result
                    }
                });
            }

            agent.messages.push({ role: 'user', parts: toolResultParts });
        }

    } catch (err) {
        hideThinking();
        appendChatMessage('assistant', `Error: ${err.message}`);
    }

    agent.isProcessing = false;
    agent.abortController = null;

    // Restore send button
    sendBtn = document.getElementById('we-chat-send-btn');
    sendBtn.innerHTML = `${svgIcon('ic-send', 14)}`;
    sendBtn.onclick = sendChatMessage;
    sendBtn.classList.remove('stop-mode');

    saveConversationToLocal();
}

// -- Chat Input Handling --
function initChatInput() {
    const input = document.getElementById('we-chat-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
}

// ==================== INIT ====================
async function init() {
    initPalette();
    initCanvasEvents();
    initChatInput();
    await loadAgentMemory();
    if (!autoLoad()) {
        try {
            const resp = await wfFetch('/api/workflow-editor/workflows/music-video-pipeline');
            if (resp.ok) { const data = await resp.json(); if (data && !data.error) { loadWorkflow(data); toast('Loaded: music-video-pipeline', 'success'); } }
        } catch (e) { wfState.pan = { x: 100, y: 50 }; }
    }
    updateTransform();
    refreshWorkflowList();
}

    // ==================== PUBLIC API ====================
    return {
        initialized: false,
        init: async function() {
            if (this.initialized) return;
            this.initialized = true;
            await init();
        },
        createNode: createNode,
        runAll: runAll,
        stopExecution: stopExecution,
        executeAgentTool: executeAgentTool,
        serializeWorkflow: serializeWorkflow,
        loadWorkflow: loadWorkflow,
        drawGrid: drawGrid,
        renderConnections: renderConnections,
        fitToView: fitToView,
        zoomTo: zoomTo,
        showSaveDialog: showSaveDialog,
        clearCanvas: clearCanvas,
        toggleChatPanel: toggleChatPanel,
        refreshWorkflowList: refreshWorkflowList,
        sendChatMessage: sendChatMessage,
        runSelectedNode: runSelectedNode,
        getState: function() { return wfState; }
    };
})();
