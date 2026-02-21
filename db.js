const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway.app') ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
    console.error('Unexpected DB pool error:', err.message);
});

// ==================== PLANS ====================

const PLANS = {
    starter: { name: 'Starter', runs_limit: 5, price: 0 },
    pro: { name: 'Pro', runs_limit: 100, price: 29 },
    premium: { name: 'Premium', runs_limit: 500, price: 99 },
};

// ==================== QUERY HELPERS ====================

async function query(text, params) {
    const result = await pool.query(text, params);
    return result;
}

// ==================== INIT DB (schema migration) ====================

async function initDB() {
    const SCHEMA = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) UNIQUE,
            password_hash TEXT,
            google_id VARCHAR(255),
            name VARCHAR(255),
            plan VARCHAR(50) DEFAULT 'starter',
            runs_used INTEGER DEFAULT 0,
            runs_limit INTEGER DEFAULT 5,
            stripe_customer_id VARCHAR(255),
            stripe_subscription_id VARCHAR(255),
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS user_configs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            slot INTEGER DEFAULT 0,
            name VARCHAR(255) DEFAULT 'Config 1',
            is_active BOOLEAN DEFAULT false,
            config_json JSONB DEFAULT '{}',
            UNIQUE(user_id, slot)
        );

        CREATE TABLE IF NOT EXISTS social_connections (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            platform VARCHAR(50) NOT NULL,
            connected BOOLEAN DEFAULT false,
            connected_at TIMESTAMPTZ,
            tokens_json JSONB DEFAULT '{}',
            app_credentials JSONB DEFAULT '{}',
            n8n_credential_id VARCHAR(255),
            UNIQUE(user_id, platform)
        );

        CREATE TABLE IF NOT EXISTS assets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            type VARCHAR(50),
            filename VARCHAR(255),
            path TEXT,
            source_url TEXT,
            public_url TEXT,
            execution_id VARCHAR(255),
            prompt TEXT,
            metadata JSONB DEFAULT '{}',
            size INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS executions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            config_id INTEGER,
            n8n_execution_id VARCHAR(255),
            mode VARCHAR(50),
            status VARCHAR(50) DEFAULT 'running',
            duration_ms INTEGER,
            error_message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            status VARCHAR(20) DEFAULT 'queued',
            current_phase VARCHAR(50),
            input JSONB NOT NULL,
            result JSONB,
            error TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS platform_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            platform VARCHAR(50) NOT NULL,
            access_token TEXT,
            refresh_token TEXT,
            expires_at TIMESTAMPTZ,
            metadata JSONB DEFAULT '{}',
            UNIQUE(user_id, platform)
        );

        CREATE TABLE IF NOT EXISTS schedules (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            cron_times JSONB DEFAULT '["06:00","09:00","12:00","18:00","21:00","00:00"]',
            enabled BOOLEAN DEFAULT false,
            UNIQUE(user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

        -- Character Cards (asset library)
        CREATE TABLE IF NOT EXISTS character_cards (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            thumbnail_url TEXT,
            category TEXT DEFAULT 'general',
            tags TEXT[] DEFAULT '{}',
            character_data JSONB NOT NULL DEFAULT '{}',
            use_count INTEGER DEFAULT 0,
            last_used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- Scenes (multi-character compositions)
        CREATE TABLE IF NOT EXISTS scenes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            composed_prompt TEXT,
            settings JSONB DEFAULT '{}',
            status TEXT DEFAULT 'draft',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- Scene Characters (cards in a scene)
        CREATE TABLE IF NOT EXISTS scene_characters (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
            character_card_id UUID REFERENCES character_cards(id) ON DELETE CASCADE,
            role TEXT DEFAULT 'main',
            action TEXT,
            outfit_override TEXT,
            prompt_order INTEGER DEFAULT 0,
            UNIQUE(scene_id, character_card_id)
        );

        -- Character images (reference + generated)
        CREATE TABLE IF NOT EXISTS character_images (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            character_card_id UUID REFERENCES character_cards(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            thumbnail_url TEXT,
            type TEXT DEFAULT 'reference',
            is_primary BOOLEAN DEFAULT false,
            sort_order INTEGER DEFAULT 0,
            generation_prompt TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- Voice configurations
        CREATE TABLE IF NOT EXISTS voice_configs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            character_card_id UUID REFERENCES character_cards(id) ON DELETE CASCADE,
            provider TEXT DEFAULT 'elevenlabs',
            voice_id TEXT NOT NULL,
            voice_name TEXT,
            settings JSONB DEFAULT '{}',
            preview_url TEXT,
            is_cloned BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- Saved Looks (for calendar scheduling)
        CREATE TABLE IF NOT EXISTS saved_looks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            thumbnail_url TEXT,
            settings JSONB DEFAULT '{}',
            use_count INTEGER DEFAULT 0,
            last_used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_character_cards_user ON character_cards(user_id);
        CREATE INDEX IF NOT EXISTS idx_character_cards_category ON character_cards(user_id, category);
        CREATE INDEX IF NOT EXISTS idx_scenes_user ON scenes(user_id);
        CREATE INDEX IF NOT EXISTS idx_scene_characters_scene ON scene_characters(scene_id);
        CREATE INDEX IF NOT EXISTS idx_character_images_card ON character_images(character_card_id);
        CREATE INDEX IF NOT EXISTS idx_voice_configs_card ON voice_configs(character_card_id);
        CREATE INDEX IF NOT EXISTS idx_saved_looks_user ON saved_looks(user_id);

        -- Motion Library
        CREATE TABLE IF NOT EXISTS motion_library (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            thumbnail_url TEXT,
            video_url TEXT NOT NULL,
            duration_seconds REAL,
            source TEXT DEFAULT 'user',
            tags TEXT[] DEFAULT '{}',
            category TEXT DEFAULT 'dance',
            is_public BOOLEAN DEFAULT false,
            use_count INTEGER DEFAULT 0,
            file_size INTEGER DEFAULT 0,
            pexels_video_id TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_motion_library_user ON motion_library(user_id);
        CREATE INDEX IF NOT EXISTS idx_motion_library_public ON motion_library(is_public) WHERE is_public = true;

        -- Node Workflows (workflow editor)
        CREATE TABLE IF NOT EXISTS node_workflows (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            workflow_json JSONB NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_node_workflows_user ON node_workflows(user_id);

        -- Workflow Agent Memory
        CREATE TABLE IF NOT EXISTS workflow_agent_memory (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            memory_json JSONB DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id)
        );
    `;
    await pool.query(SCHEMA);

    // Add columns that may not exist on older schemas (safe ALTER IF NOT EXISTS)
    const alterStatements = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'starter'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS runs_used INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS runs_limit INTEGER DEFAULT 5",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false",
    ];
    for (const stmt of alterStatements) {
        try { await pool.query(stmt); } catch (e) { /* column already exists */ }
    }

    // Migrate existing users who already have character cards — mark onboarding complete
    try {
        await pool.query(`UPDATE users SET onboarding_completed = true WHERE onboarding_completed = false AND id IN (SELECT DISTINCT user_id FROM character_cards)`);
    } catch (e) { /* table may not exist yet on first run */ }

    // Migrate user_configs from old schema (config_index/data) to new (slot/config_json/is_active)
    try {
        const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_configs'`);
        const colNames = cols.rows.map(r => r.column_name);
        if (colNames.includes('config_index') && !colNames.includes('slot')) {
            console.log('Migrating user_configs: config_index -> slot, data -> config_json...');
            await pool.query('ALTER TABLE user_configs RENAME COLUMN config_index TO slot');
            await pool.query('ALTER TABLE user_configs RENAME COLUMN data TO config_json');
            await pool.query('ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT false');
            // Set slot 0 as active for all users
            await pool.query('UPDATE user_configs SET is_active = true WHERE slot = 0');
            // Recreate unique constraint
            try { await pool.query('ALTER TABLE user_configs DROP CONSTRAINT IF EXISTS user_configs_user_id_config_index_key'); } catch (e) {}
            try { await pool.query('ALTER TABLE user_configs ADD CONSTRAINT user_configs_user_id_slot_key UNIQUE (user_id, slot)'); } catch (e) {}
            console.log('user_configs migration complete');
        } else if (!colNames.includes('is_active')) {
            await pool.query('ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT false');
            await pool.query('UPDATE user_configs SET is_active = true WHERE slot = 0 AND is_active = false');
        }
    } catch (e) {
        console.log('user_configs migration note:', e.message);
    }

    // Remove NOT NULL on google_id if it exists (old schema had it)
    try {
        await pool.query('ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL');
    } catch (e) { /* already nullable */ }

    // Add character_card_id to social_connections and platform_tokens for per-character social media
    try {
        await pool.query('ALTER TABLE social_connections ADD COLUMN IF NOT EXISTS character_card_id UUID');
        await pool.query('ALTER TABLE platform_tokens ADD COLUMN IF NOT EXISTS character_card_id UUID');
    } catch (e) { /* columns may already exist */ }

    // Drop old UNIQUE constraints that block per-character connections
    try {
        await pool.query('ALTER TABLE social_connections DROP CONSTRAINT IF EXISTS social_connections_user_id_platform_key');
    } catch (e) { /* constraint may not exist */ }
    try {
        await pool.query('ALTER TABLE platform_tokens DROP CONSTRAINT IF EXISTS platform_tokens_user_id_platform_key');
    } catch (e) { /* constraint may not exist */ }

    // Add calendar column to schedules for calendar-based scheduling
    try {
        await pool.query('ALTER TABLE schedules ADD COLUMN IF NOT EXISTS calendar JSONB DEFAULT \'{}\'');
    } catch (e) { /* column may already exist */ }

    // Create partial unique indexes for per-character social connections
    try {
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_social_conn_global ON social_connections(user_id, platform) WHERE character_card_id IS NULL`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_social_conn_character ON social_connections(user_id, platform, character_card_id) WHERE character_card_id IS NOT NULL`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_token_global ON platform_tokens(user_id, platform) WHERE character_card_id IS NULL`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_token_character ON platform_tokens(user_id, platform, character_card_id) WHERE character_card_id IS NOT NULL`);
    } catch (e) { /* indexes may already exist */ }

    // Drop old UNIQUE on google_id if it prevents null duplicates
    // (we need google_id to be nullable for email/password users)

    console.log('Database schema initialized');
}

// ==================== USER AUTH OPERATIONS ====================

async function getUserByEmail(email) {
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    return result.rows[0] || null;
}

async function createUser(email, passwordHash, name) {
    const plan = 'starter';
    const limit = PLANS[plan].runs_limit;
    const result = await query(
        `INSERT INTO users (email, password_hash, name, plan, runs_used, runs_limit)
         VALUES ($1, $2, $3, $4, 0, $5) RETURNING *`,
        [email, passwordHash, name, plan, limit]
    );
    const user = result.rows[0];
    // Create default config slots for the new user
    await ensureUserConfigs(user.id);
    return user;
}

async function getUserByGoogleId(googleId) {
    const result = await query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    return result.rows[0] || null;
}

async function createGoogleUser(email, googleId, name) {
    const plan = 'starter';
    const limit = PLANS[plan].runs_limit;
    const result = await query(
        `INSERT INTO users (email, google_id, name, plan, runs_used, runs_limit)
         VALUES ($1, $2, $3, $4, 0, $5) RETURNING *`,
        [email, googleId, name, plan, limit]
    );
    const user = result.rows[0];
    await ensureUserConfigs(user.id);
    return user;
}

async function linkGoogleId(userId, googleId) {
    await query('UPDATE users SET google_id = $2 WHERE id = $1', [userId, googleId]);
}

async function getUserById(id) {
    const result = await query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] || null;
}

async function getUserByStripeCustomer(customerId) {
    const result = await query('SELECT * FROM users WHERE stripe_customer_id = $1', [customerId]);
    return result.rows[0] || null;
}

// ==================== BILLING / PLANS ====================

async function updateUserPlan(userId, plan) {
    const limit = PLANS[plan]?.runs_limit || 5;
    await query(
        'UPDATE users SET plan = $2, runs_limit = $3, runs_used = 0 WHERE id = $1',
        [userId, plan, limit]
    );
}

async function updateStripeCustomer(userId, customerId, subscriptionId) {
    await query(
        'UPDATE users SET stripe_customer_id = $2, stripe_subscription_id = $3 WHERE id = $1',
        [userId, customerId, subscriptionId]
    );
}

async function checkRunLimit(userId) {
    const user = await getUserById(userId);
    if (!user) return { allowed: false, reason: 'User not found' };
    if (user.runs_used >= user.runs_limit) {
        return {
            allowed: false,
            reason: `Monthly run limit reached (${user.runs_used}/${user.runs_limit}). Upgrade your plan for more runs.`,
            runs_used: user.runs_used,
            runs_limit: user.runs_limit,
        };
    }
    return { allowed: true, runs_used: user.runs_used, runs_limit: user.runs_limit };
}

async function incrementRunsUsed(userId) {
    const result = await query(
        'UPDATE users SET runs_used = runs_used + 1 WHERE id = $1 RETURNING runs_used, runs_limit',
        [userId]
    );
    return result.rows[0] || { runs_used: 0, runs_limit: 5 };
}

async function resetMonthlyRuns() {
    await query('UPDATE users SET runs_used = 0');
    console.log('Monthly runs reset for all users');
}

// ==================== USER CONFIGS (per-user, 3 slots) ====================

async function ensureUserConfigs(userId) {
    for (let slot = 0; slot < 3; slot++) {
        await query(
            `INSERT INTO user_configs (user_id, slot, name, is_active, config_json)
             VALUES ($1, $2, $3, $4, '{}')
             ON CONFLICT (user_id, slot) DO NOTHING`,
            [userId, slot, `Config ${slot + 1}`, slot === 0]
        );
    }
}

async function getActiveConfig(userId) {
    await ensureUserConfigs(userId);
    const result = await query(
        'SELECT * FROM user_configs WHERE user_id = $1 AND is_active = true LIMIT 1',
        [userId]
    );
    if (!result.rows[0]) {
        // Fallback to slot 0
        const fallback = await query(
            'SELECT * FROM user_configs WHERE user_id = $1 AND slot = 0',
            [userId]
        );
        const row = fallback.rows[0];
        if (row) {
            await query('UPDATE user_configs SET is_active = true WHERE id = $1', [row.id]);
            return { ...row, config: row.config_json || {} };
        }
        return null;
    }
    const row = result.rows[0];
    return { ...row, config: row.config_json || {} };
}

async function saveActiveConfig(userId, config) {
    await query(
        `UPDATE user_configs SET config_json = $2
         WHERE user_id = $1 AND is_active = true`,
        [userId, JSON.stringify(config)]
    );
}

async function listConfigs(userId) {
    await ensureUserConfigs(userId);
    const result = await query(
        'SELECT slot, name, is_active FROM user_configs WHERE user_id = $1 ORDER BY slot',
        [userId]
    );
    return result.rows;
}

async function switchConfig(userId, index) {
    // Deactivate all, then activate the target
    await query('UPDATE user_configs SET is_active = false WHERE user_id = $1', [userId]);
    const result = await query(
        'UPDATE user_configs SET is_active = true WHERE user_id = $1 AND slot = $2 RETURNING *',
        [userId, index]
    );
    const row = result.rows[0];
    if (row) return { ...row, config_json: row.config_json || {} };
    return null;
}

async function renameConfig(userId, index, name) {
    await query(
        'UPDATE user_configs SET name = $3 WHERE user_id = $1 AND slot = $2',
        [userId, index, name]
    );
}

// ==================== SOCIAL CONNECTIONS ====================

async function saveSocialConnection(userId, platform, data, characterCardId = null) {
    const whereClause = characterCardId
        ? 'user_id = $1 AND platform = $2 AND character_card_id = $3'
        : 'user_id = $1 AND platform = $2 AND character_card_id IS NULL';
    const whereParams = characterCardId ? [userId, platform, characterCardId] : [userId, platform];

    const existing = await query(
        `SELECT * FROM social_connections WHERE ${whereClause}`,
        whereParams
    );

    if (existing.rows.length > 0) {
        const updates = [];
        const params = [...whereParams];
        let paramIdx = params.length + 1;

        if (data.tokens !== undefined) {
            updates.push(`tokens_json = $${paramIdx++}`);
            params.push(JSON.stringify(data.tokens));
        }
        if (data.connected !== undefined) {
            updates.push(`connected = $${paramIdx++}`);
            params.push(data.connected);
        }
        if (data.connectedAt !== undefined) {
            updates.push(`connected_at = $${paramIdx++}`);
            params.push(data.connectedAt);
        }
        if (data.appCredentials !== undefined) {
            updates.push(`app_credentials = $${paramIdx++}`);
            params.push(JSON.stringify(data.appCredentials));
        }
        if (data.n8nCredentialId !== undefined) {
            updates.push(`n8n_credential_id = $${paramIdx++}`);
            params.push(data.n8nCredentialId);
        }

        if (updates.length > 0) {
            await query(
                `UPDATE social_connections SET ${updates.join(', ')}
                 WHERE ${whereClause}`,
                params
            );
        }
    } else {
        await query(
            `INSERT INTO social_connections (user_id, platform, connected, connected_at, tokens_json, app_credentials, n8n_credential_id, character_card_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                userId, platform,
                data.connected || false,
                data.connectedAt || null,
                JSON.stringify(data.tokens || {}),
                JSON.stringify(data.appCredentials || {}),
                data.n8nCredentialId || null,
                characterCardId || null,
            ]
        );
    }
}

async function getSocialConnection(userId, platform, characterCardId = null) {
    const whereClause = characterCardId
        ? 'user_id = $1 AND platform = $2 AND character_card_id = $3'
        : 'user_id = $1 AND platform = $2 AND character_card_id IS NULL';
    const params = characterCardId ? [userId, platform, characterCardId] : [userId, platform];
    const result = await query(
        `SELECT * FROM social_connections WHERE ${whereClause}`,
        params
    );
    return result.rows[0] || null;
}

async function getSocialStatus(userId, characterCardId = null) {
    const whereClause = characterCardId
        ? 'user_id = $1 AND character_card_id = $2'
        : 'user_id = $1 AND character_card_id IS NULL';
    const params = characterCardId ? [userId, characterCardId] : [userId];
    const result = await query(
        `SELECT platform, connected, connected_at FROM social_connections WHERE ${whereClause}`,
        params
    );
    const status = {};
    for (const row of result.rows) {
        status[row.platform] = { connected: row.connected, connected_at: row.connected_at };
    }
    return status;
}

// ==================== ASSETS ====================

async function logAsset(userId, data) {
    const result = await query(
        `INSERT INTO assets (user_id, type, filename, path, source_url, public_url, execution_id, prompt, metadata, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
            userId, data.type, data.filename, data.path,
            data.sourceUrl, data.publicUrl, data.executionId,
            data.prompt, JSON.stringify(data.metadata || {}), data.size || 0,
        ]
    );
    return result.rows[0];
}

async function getAssets(userId) {
    const result = await query(
        'SELECT * FROM assets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
        [userId]
    );
    return result.rows;
}

// ==================== EXECUTIONS ====================

async function createExecution(userId, configId, n8nExecutionId, mode) {
    const result = await query(
        `INSERT INTO executions (user_id, config_id, n8n_execution_id, mode)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, configId, n8nExecutionId, mode]
    );
    return result.rows[0];
}

async function updateExecution(executionId, status, durationMs, errorMessage) {
    await query(
        `UPDATE executions SET status = $2, duration_ms = $3, error_message = $4
         WHERE id = $1`,
        [executionId, status, durationMs, errorMessage]
    );
}

async function getExecutions(userId) {
    const result = await query(
        'SELECT * FROM executions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
        [userId]
    );
    return result.rows;
}

async function updateConfigField(userId, field, value) {
    await query(
        `UPDATE user_configs SET config_json = jsonb_set(config_json::jsonb, $1, $2::jsonb)
         WHERE user_id = $3 AND is_active = true`,
        [`{${field}}`, JSON.stringify(value), userId]
    );
}

// ==================== PLATFORM TOKENS ====================

async function savePlatformToken(userId, platform, accessToken, refreshToken, expiresAt, metadata = {}, characterCardId = null) {
    // Delete existing then insert (handles both global and per-character uniqueness)
    const delWhere = characterCardId
        ? 'user_id = $1 AND platform = $2 AND character_card_id = $3'
        : 'user_id = $1 AND platform = $2 AND character_card_id IS NULL';
    const delParams = characterCardId ? [userId, platform, characterCardId] : [userId, platform];
    await query(`DELETE FROM platform_tokens WHERE ${delWhere}`, delParams);

    await query(
        `INSERT INTO platform_tokens (user_id, platform, access_token, refresh_token, expires_at, metadata, character_card_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, platform, accessToken, refreshToken, expiresAt, JSON.stringify(metadata), characterCardId || null]
    );
}

async function getPlatformToken(userId, platform, characterCardId = null) {
    const whereClause = characterCardId
        ? 'user_id = $1 AND platform = $2 AND character_card_id = $3'
        : 'user_id = $1 AND platform = $2 AND character_card_id IS NULL';
    const params = characterCardId ? [userId, platform, characterCardId] : [userId, platform];
    const result = await query(
        `SELECT * FROM platform_tokens WHERE ${whereClause}`,
        params
    );
    return result.rows[0] || null;
}

async function getAllPlatformTokens(userId, characterCardId = null) {
    const whereClause = characterCardId
        ? 'user_id = $1 AND character_card_id = $2'
        : 'user_id = $1 AND character_card_id IS NULL';
    const params = characterCardId ? [userId, characterCardId] : [userId];
    const result = await query(
        `SELECT * FROM platform_tokens WHERE ${whereClause}`,
        params
    );
    const tokens = {};
    for (const row of result.rows) {
        tokens[row.platform] = row;
    }
    return tokens;
}

async function deletePlatformToken(userId, platform, characterCardId = null) {
    const whereClause = characterCardId
        ? 'user_id = $1 AND platform = $2 AND character_card_id = $3'
        : 'user_id = $1 AND platform = $2 AND character_card_id IS NULL';
    const params = characterCardId ? [userId, platform, characterCardId] : [userId, platform];
    await query(`DELETE FROM platform_tokens WHERE ${whereClause}`, params);
}

// ==================== JOBS ====================

async function createJob(userId, input) {
    const result = await query(
        'INSERT INTO jobs (user_id, status, current_phase, input) VALUES ($1, $2, $3, $4) RETURNING *',
        [userId, 'queued', null, JSON.stringify(input)]
    );
    return result.rows[0];
}

async function updateJobStatus(jobId, status, currentPhase, result = null, error = null) {
    const completedAt = (status === 'completed' || status === 'failed') ? new Date() : null;
    try {
        await query(
            `UPDATE jobs SET status = $2, current_phase = $3, result = $4, error = $5, completed_at = $6
             WHERE id = $1`,
            [jobId, status, currentPhase, result || null, error, completedAt]
        );
    } catch (err) {
        console.error(`[db] Failed to update job ${jobId} to ${status}:`, err.message);
    }
}

async function getJob(jobId) {
    const result = await query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    return result.rows[0] || null;
}

async function getUserJobs(userId, limit = 20) {
    const result = await query(
        'SELECT * FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit]
    );
    return result.rows;
}

// ==================== SCHEDULES ====================

async function getSchedule(userId) {
    const result = await query('SELECT * FROM schedules WHERE user_id = $1', [userId]);
    return result.rows[0] || null;
}

async function saveSchedule(userId, cronTimes, enabled) {
    await query(
        `INSERT INTO schedules (user_id, cron_times, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET cron_times = $2, enabled = $3`,
        [userId, JSON.stringify(cronTimes), enabled]
    );
}

async function getAllEnabledSchedules() {
    const result = await query(
        'SELECT s.*, u.id as uid FROM schedules s JOIN users u ON s.user_id = u.id WHERE s.enabled = true'
    );
    return result.rows;
}

// ==================== USER CONFIGS (legacy compat) ====================

async function getUserConfig(userId, configIndex = 0) {
    const result = await query(
        'SELECT * FROM user_configs WHERE user_id = $1 AND slot = $2',
        [userId, configIndex]
    );
    return result.rows[0] || null;
}

async function saveUserConfig(userId, configIndex, name, data) {
    await query(
        `INSERT INTO user_configs (user_id, slot, name, config_json)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, slot)
         DO UPDATE SET name = $3, config_json = $4`,
        [userId, configIndex, name, JSON.stringify(data)]
    );
}

async function getAllUserConfigs(userId) {
    const result = await query(
        'SELECT * FROM user_configs WHERE user_id = $1 ORDER BY slot',
        [userId]
    );
    return result.rows;
}

// ==================== CHARACTER CARDS ====================

async function getCharacterCards(userId, { category, search, sortBy } = {}) {
    let sql = 'SELECT * FROM character_cards WHERE user_id = $1';
    const params = [userId];
    let idx = 2;
    if (category) {
        sql += ` AND category = $${idx++}`;
        params.push(category);
    }
    if (search) {
        sql += ` AND (name ILIKE $${idx} OR description ILIKE $${idx})`;
        params.push(`%${search}%`);
        idx++;
    }
    if (sortBy === 'most_used') {
        sql += ' ORDER BY use_count DESC, updated_at DESC';
    } else if (sortBy === 'name') {
        sql += ' ORDER BY name ASC';
    } else {
        sql += ' ORDER BY updated_at DESC';
    }
    const result = await query(sql, params);
    return result.rows;
}

async function getCharacterCard(cardId) {
    const result = await query('SELECT * FROM character_cards WHERE id = $1', [cardId]);
    return result.rows[0] || null;
}

async function createCharacterCard(userId, data) {
    const result = await query(
        `INSERT INTO character_cards (user_id, name, description, thumbnail_url, category, tags, character_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [userId, data.name, data.description || null, data.thumbnail_url || null,
         data.category || 'general', data.tags || [], JSON.stringify(data.character_data || {})]
    );
    return result.rows[0];
}

async function updateCharacterCard(cardId, data) {
    const fields = [];
    const params = [cardId];
    let idx = 2;
    for (const key of ['name', 'description', 'thumbnail_url', 'category']) {
        if (data[key] !== undefined) {
            fields.push(`${key} = $${idx++}`);
            params.push(data[key]);
        }
    }
    if (data.tags !== undefined) {
        fields.push(`tags = $${idx++}`);
        params.push(data.tags);
    }
    if (data.character_data !== undefined) {
        fields.push(`character_data = $${idx++}`);
        params.push(JSON.stringify(data.character_data));
    }
    fields.push('updated_at = NOW()');
    if (fields.length === 1) return await getCharacterCard(cardId); // only updated_at
    const result = await query(
        `UPDATE character_cards SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
        params
    );
    return result.rows[0];
}

async function deleteCharacterCard(cardId) {
    await query('DELETE FROM character_cards WHERE id = $1', [cardId]);
}

async function incrementCardUseCount(cardId) {
    await query(
        'UPDATE character_cards SET use_count = use_count + 1, last_used_at = NOW() WHERE id = $1',
        [cardId]
    );
}

async function cloneCharacterCard(cardId, userId, overrides = {}) {
    const original = await getCharacterCard(cardId);
    if (!original) return null;
    const data = {
        name: overrides.name || `${original.name} (Copy)`,
        description: overrides.description || original.description,
        thumbnail_url: original.thumbnail_url,
        category: overrides.category || original.category,
        tags: overrides.tags || original.tags,
        character_data: { ...original.character_data, ...(overrides.character_data || {}) },
    };
    return await createCharacterCard(userId, data);
}

// ==================== CHARACTER IMAGES ====================

async function getCharacterImages(cardId) {
    const result = await query(
        'SELECT * FROM character_images WHERE character_card_id = $1 ORDER BY sort_order, created_at',
        [cardId]
    );
    return result.rows;
}

async function addCharacterImage(cardId, data) {
    if (data.is_primary) {
        await query('UPDATE character_images SET is_primary = false WHERE character_card_id = $1', [cardId]);
    }
    const result = await query(
        `INSERT INTO character_images (character_card_id, url, thumbnail_url, type, is_primary, sort_order, generation_prompt)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [cardId, data.url, data.thumbnail_url || null, data.type || 'reference',
         data.is_primary || false, data.sort_order || 0, data.generation_prompt || null]
    );
    return result.rows[0];
}

async function deleteCharacterImage(imageId) {
    await query('DELETE FROM character_images WHERE id = $1', [imageId]);
}

// ==================== SCENES ====================

async function getScenes(userId) {
    const result = await query(
        'SELECT * FROM scenes WHERE user_id = $1 ORDER BY updated_at DESC',
        [userId]
    );
    return result.rows;
}

async function getScene(sceneId) {
    const result = await query('SELECT * FROM scenes WHERE id = $1', [sceneId]);
    return result.rows[0] || null;
}

async function createScene(userId, data) {
    const result = await query(
        `INSERT INTO scenes (user_id, name, description, composed_prompt, settings, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [userId, data.name, data.description || null, data.composed_prompt || null,
         JSON.stringify(data.settings || {}), data.status || 'draft']
    );
    return result.rows[0];
}

async function updateScene(sceneId, data) {
    const fields = [];
    const params = [sceneId];
    let idx = 2;
    for (const key of ['name', 'description', 'composed_prompt', 'status']) {
        if (data[key] !== undefined) {
            fields.push(`${key} = $${idx++}`);
            params.push(data[key]);
        }
    }
    if (data.settings !== undefined) {
        fields.push(`settings = $${idx++}`);
        params.push(JSON.stringify(data.settings));
    }
    fields.push('updated_at = NOW()');
    const result = await query(
        `UPDATE scenes SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
        params
    );
    return result.rows[0];
}

async function deleteScene(sceneId) {
    await query('DELETE FROM scenes WHERE id = $1', [sceneId]);
}

// ==================== SCENE CHARACTERS ====================

async function getSceneCharacters(sceneId) {
    const result = await query(
        `SELECT sc.*, cc.name as character_name, cc.thumbnail_url, cc.character_data
         FROM scene_characters sc
         JOIN character_cards cc ON sc.character_card_id = cc.id
         WHERE sc.scene_id = $1 ORDER BY sc.prompt_order`,
        [sceneId]
    );
    return result.rows;
}

async function addSceneCharacter(sceneId, data) {
    const result = await query(
        `INSERT INTO scene_characters (scene_id, character_card_id, role, action, outfit_override, prompt_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (scene_id, character_card_id) DO UPDATE SET
           role = EXCLUDED.role, action = EXCLUDED.action,
           outfit_override = EXCLUDED.outfit_override, prompt_order = EXCLUDED.prompt_order
         RETURNING *`,
        [sceneId, data.character_card_id, data.role || 'main',
         data.action || null, data.outfit_override || null, data.prompt_order || 0]
    );
    return result.rows[0];
}

async function removeSceneCharacter(sceneId, cardId) {
    await query('DELETE FROM scene_characters WHERE scene_id = $1 AND character_card_id = $2', [sceneId, cardId]);
}

// ==================== VOICE CONFIGS ====================

async function getVoiceConfig(cardId) {
    const result = await query(
        'SELECT * FROM voice_configs WHERE character_card_id = $1',
        [cardId]
    );
    return result.rows[0] || null;
}

async function saveVoiceConfig(userId, cardId, data) {
    // Check if voice config already exists for this card
    const existing = await query(
        'SELECT * FROM voice_configs WHERE character_card_id = $1',
        [cardId]
    );
    if (existing.rows.length > 0) {
        const updated = await query(
            `UPDATE voice_configs SET voice_id = $2, voice_name = $3, settings = $4, preview_url = $5, is_cloned = $6
             WHERE character_card_id = $1 RETURNING *`,
            [cardId, data.voice_id, data.voice_name || null,
             JSON.stringify(data.settings || {}), data.preview_url || null, data.is_cloned || false]
        );
        return updated.rows[0];
    }
    const result = await query(
        `INSERT INTO voice_configs (user_id, character_card_id, provider, voice_id, voice_name, settings, preview_url, is_cloned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [userId, cardId, data.provider || 'elevenlabs', data.voice_id,
         data.voice_name || null, JSON.stringify(data.settings || {}),
         data.preview_url || null, data.is_cloned || false]
    );
    return result.rows[0];
}

async function deleteVoiceConfig(cardId) {
    await query('DELETE FROM voice_configs WHERE character_card_id = $1', [cardId]);
}

// ==================== ONBOARDING ====================

async function markOnboardingComplete(userId) {
    await query('UPDATE users SET onboarding_completed = true WHERE id = $1', [userId]);
}

async function isOnboardingComplete(userId) {
    const result = await query('SELECT onboarding_completed FROM users WHERE id = $1', [userId]);
    return result.rows[0]?.onboarding_completed || false;
}

// ==================== SAVED LOOKS ====================

async function getSavedLooks(userId) {
    const result = await query(
        'SELECT * FROM saved_looks WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
    );
    return result.rows;
}

async function getSavedLook(lookId) {
    const result = await query('SELECT * FROM saved_looks WHERE id = $1', [lookId]);
    return result.rows[0] || null;
}

async function createSavedLook(userId, data) {
    const result = await query(
        `INSERT INTO saved_looks (user_id, name, thumbnail_url, settings)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, data.name, data.thumbnail_url || null, JSON.stringify(data.settings || {})]
    );
    return result.rows[0];
}

async function deleteSavedLook(lookId) {
    await query('DELETE FROM saved_looks WHERE id = $1', [lookId]);
}

async function incrementLookUseCount(lookId) {
    await query(
        'UPDATE saved_looks SET use_count = use_count + 1, last_used_at = NOW() WHERE id = $1',
        [lookId]
    );
}

// ==================== MOTION LIBRARY ====================

async function getMotionLibrary(userId, { search, category } = {}) {
    let sql = `SELECT * FROM motion_library WHERE (user_id = $1 OR is_public = true)`;
    const params = [userId];
    let idx = 2;

    if (category && category !== 'all') {
        if (category === 'mine') {
            sql = `SELECT * FROM motion_library WHERE user_id = $1`;
        } else {
            sql += ` AND category = $${idx}`;
            params.push(category);
            idx++;
        }
    }

    if (search && search.trim()) {
        sql += ` AND (name ILIKE $${idx} OR description ILIKE $${idx} OR $${idx + 1} = ANY(tags))`;
        params.push(`%${search.trim()}%`, search.trim().toLowerCase());
        idx += 2;
    }

    sql += ` ORDER BY use_count DESC, created_at DESC`;
    const result = await query(sql, params);
    return result.rows;
}

async function getMotion(motionId) {
    const result = await query('SELECT * FROM motion_library WHERE id = $1', [motionId]);
    return result.rows[0] || null;
}

async function createMotion(userId, data) {
    const result = await query(
        `INSERT INTO motion_library (user_id, name, description, thumbnail_url, video_url, duration_seconds, source, tags, category, is_public, file_size, pexels_video_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
            userId,
            data.name,
            data.description || null,
            data.thumbnail_url || null,
            data.video_url,
            data.duration_seconds || null,
            data.source || 'user',
            data.tags || [],
            data.category || 'dance',
            data.is_public || false,
            data.file_size || 0,
            data.pexels_video_id || null,
        ]
    );
    return result.rows[0];
}

async function deleteMotion(motionId) {
    await query('DELETE FROM motion_library WHERE id = $1', [motionId]);
}

async function incrementMotionUseCount(motionId) {
    await query(
        'UPDATE motion_library SET use_count = use_count + 1 WHERE id = $1',
        [motionId]
    );
}

// ==================== CALENDAR SCHEDULE ====================

async function getCalendarSchedule(userId) {
    const result = await query('SELECT calendar FROM schedules WHERE user_id = $1', [userId]);
    return result.rows[0]?.calendar || null;
}

async function saveCalendarSchedule(userId, calendarData) {
    await query(
        `INSERT INTO schedules (user_id, calendar)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET calendar = $2`,
        [userId, JSON.stringify(calendarData)]
    );
}

// ==================== FIND OR CREATE (legacy compat) ====================

async function findOrCreateUser(googleId, email, name) {
    const existing = await query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    if (existing.rows.length > 0) return existing.rows[0];

    const result = await query(
        `INSERT INTO users (google_id, email, name, plan, runs_used, runs_limit)
         VALUES ($1, $2, $3, 'starter', 0, 5) RETURNING *`,
        [googleId, email, name]
    );
    const user = result.rows[0];
    await ensureUserConfigs(user.id);
    return user;
}

// ==================== NODE WORKFLOWS ====================

async function getNodeWorkflows(userId) {
    const result = await query(
        'SELECT name, updated_at FROM node_workflows WHERE user_id = $1 ORDER BY updated_at DESC',
        [userId]
    );
    return result.rows.map(r => ({ name: r.name, modified: r.updated_at }));
}

async function getNodeWorkflow(userId, name) {
    const result = await query(
        'SELECT workflow_json FROM node_workflows WHERE user_id = $1 AND name = $2',
        [userId, name]
    );
    return result.rows[0]?.workflow_json || null;
}

async function saveNodeWorkflow(userId, name, workflowJson) {
    const result = await query(
        `INSERT INTO node_workflows (user_id, name, workflow_json)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, name) DO UPDATE SET workflow_json = $3, updated_at = NOW()
         RETURNING name`,
        [userId, name, JSON.stringify(workflowJson)]
    );
    return result.rows[0];
}

async function deleteNodeWorkflow(userId, name) {
    await query('DELETE FROM node_workflows WHERE user_id = $1 AND name = $2', [userId, name]);
}

async function getWorkflowAgentMemory(userId) {
    const result = await query(
        'SELECT memory_json FROM workflow_agent_memory WHERE user_id = $1',
        [userId]
    );
    return result.rows[0]?.memory_json || { skills: {}, patterns: {}, history: [] };
}

async function saveWorkflowAgentMemory(userId, memoryJson) {
    await query(
        `INSERT INTO workflow_agent_memory (user_id, memory_json)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET memory_json = $2, updated_at = NOW()`,
        [userId, JSON.stringify(memoryJson)]
    );
}

module.exports = {
    pool,
    query,
    initDB,
    PLANS,
    // Auth
    getUserByEmail,
    createUser,
    getUserByGoogleId,
    createGoogleUser,
    linkGoogleId,
    getUserById,
    getUserByStripeCustomer,
    // Billing
    updateUserPlan,
    updateStripeCustomer,
    checkRunLimit,
    incrementRunsUsed,
    resetMonthlyRuns,
    // User configs
    getActiveConfig,
    saveActiveConfig,
    listConfigs,
    switchConfig,
    renameConfig,
    ensureUserConfigs,
    getUserConfig,
    saveUserConfig,
    getAllUserConfigs,
    updateConfigField,
    // Social connections
    saveSocialConnection,
    getSocialConnection,
    getSocialStatus,
    // Assets
    logAsset,
    getAssets,
    // Executions
    createExecution,
    updateExecution,
    getExecutions,
    // Platform tokens
    savePlatformToken,
    getPlatformToken,
    getAllPlatformTokens,
    deletePlatformToken,
    // Jobs
    createJob,
    updateJobStatus,
    getJob,
    getUserJobs,
    // Schedules
    getSchedule,
    saveSchedule,
    getAllEnabledSchedules,
    // Saved Looks
    getSavedLooks,
    getSavedLook,
    createSavedLook,
    deleteSavedLook,
    incrementLookUseCount,
    // Motion Library
    getMotionLibrary,
    getMotion,
    createMotion,
    deleteMotion,
    incrementMotionUseCount,
    // Calendar
    getCalendarSchedule,
    saveCalendarSchedule,
    // Legacy compat
    findOrCreateUser,
    // Character cards
    getCharacterCards,
    getCharacterCard,
    createCharacterCard,
    updateCharacterCard,
    deleteCharacterCard,
    incrementCardUseCount,
    cloneCharacterCard,
    // Character images
    getCharacterImages,
    addCharacterImage,
    deleteCharacterImage,
    // Scenes
    getScenes,
    getScene,
    createScene,
    updateScene,
    deleteScene,
    // Scene characters
    getSceneCharacters,
    addSceneCharacter,
    removeSceneCharacter,
    // Voice configs
    getVoiceConfig,
    saveVoiceConfig,
    deleteVoiceConfig,
    // Onboarding
    markOnboardingComplete,
    isOnboardingComplete,
    // Node Workflows
    getNodeWorkflows,
    getNodeWorkflow,
    saveNodeWorkflow,
    deleteNodeWorkflow,
    getWorkflowAgentMemory,
    saveWorkflowAgentMemory,
};
