#!/usr/bin/env node
/**
 * One-time migration script: patches the n8n workflow to
 *  1. Remove character_description fallback from "Select Random Elements" node
 *  2. Remove video_suffix from "Prepare Image Request" node
 *
 * Usage: node migrate-workflow.js
 */

const http = require('http');

const N8N_HOST = 'http://localhost:5678';
const WORKFLOW_ID = '72EXSrxJ5IckthuP';

let cookie = '';

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, N8N_HOST);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
        };
        const req = http.request(options, (res) => {
            const cookies = res.headers['set-cookie'];
            if (cookies) cookie = cookies.map(c => c.split(';')[0]).join('; ');
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function login() {
    const res = await request('POST', '/rest/login', {
        emailOrLdapLoginId: 'loki@local.dev',
        password: 'n8nAdmin2026!',
    });
    if (res.status !== 200) throw new Error('Login failed: ' + res.status);
    console.log('Logged in to n8n');
}

async function main() {
    await login();

    // Fetch workflow
    const wfRes = await request('GET', `/rest/workflows/${WORKFLOW_ID}`);
    if (wfRes.status !== 200) throw new Error('Could not fetch workflow: ' + wfRes.status);
    const wf = wfRes.data.data;
    let changed = false;

    // 1. Patch "Select Random Elements" — remove character_description fallback
    const selectNode = wf.nodes.find(n => n.name === 'Select Random Elements');
    if (selectNode && selectNode.parameters && selectNode.parameters.jsCode) {
        const oldCode = selectNode.parameters.jsCode;
        // Replace: prompts.length > 0 ? randFrom(prompts) : { text: config.character_description || '' }
        // With:    randFrom(prompts)
        const fallbackPattern = /prompts\.length\s*>\s*0\s*\?\s*randFrom\(prompts\)\s*:\s*\{[^}]*character_description[^}]*\}/;
        if (fallbackPattern.test(oldCode)) {
            selectNode.parameters.jsCode = oldCode.replace(fallbackPattern, 'randFrom(prompts)');
            console.log('Patched "Select Random Elements": removed character_description fallback');
            changed = true;
        } else {
            console.log('"Select Random Elements": fallback pattern not found (may already be patched)');
        }
    } else {
        console.log('"Select Random Elements" node not found or has no jsCode');
    }

    // 2. Patch "Prepare Image Request" — remove video_suffix from return object
    const prepNode = wf.nodes.find(n => n.name === 'Prepare Image Request');
    if (prepNode && prepNode.parameters && prepNode.parameters.jsCode) {
        const oldCode = prepNode.parameters.jsCode;
        // Remove video_suffix line from return object (various possible formats)
        const suffixPattern = /,?\s*video_suffix:\s*config\.video_suffix[^,\n}]*/g;
        const newCode = oldCode.replace(suffixPattern, '');
        if (newCode !== oldCode) {
            prepNode.parameters.jsCode = newCode;
            console.log('Patched "Prepare Image Request": removed video_suffix');
            changed = true;
        } else {
            console.log('"Prepare Image Request": video_suffix not found (may already be patched)');
        }
    } else {
        console.log('"Prepare Image Request" node not found or has no jsCode');
    }

    if (changed) {
        const saveRes = await request('PATCH', `/rest/workflows/${WORKFLOW_ID}`, {
            nodes: wf.nodes,
            connections: wf.connections,
        });
        if (saveRes.status === 200) {
            console.log('Workflow saved successfully!');
        } else {
            console.error('Failed to save workflow:', saveRes.status, saveRes.data);
        }
    } else {
        console.log('No changes needed — workflow already up to date.');
    }
}

main().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
