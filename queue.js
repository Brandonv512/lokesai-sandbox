const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const db = require('./db');
const { runPipeline } = require('./pipeline');

let connection = null;
let pipelineQueue = null;
let pipelineWorker = null;

// ==================== INIT ====================

function getRedisConnection() {
    if (!connection) {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
            console.log('REDIS_URL not set — queue will operate in memory-only mode');
            return null;
        }
        connection = new IORedis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });
        connection.on('error', (err) => {
            console.error('Redis connection error:', err.message);
        });
    }
    return connection;
}

function initQueue() {
    const conn = getRedisConnection();
    if (!conn) {
        console.log('Queue: Running without Redis (in-memory fallback)');
        return initInMemoryQueue();
    }

    pipelineQueue = new Queue('pipeline', { connection: conn });

    pipelineWorker = new Worker('pipeline', async (job) => {
        const { userId, jobId, jobData } = job.data;
        console.log(`[queue] Processing job #${jobId} for user ${userId}...`);

        try {
            // Update job status to processing
            await db.updateJobStatus(jobId, 'processing', 'prompt_generation');

            // Load user's active config from DB (per-user)
            const configRow = await db.getActiveConfig(userId);
            const userConfig = configRow?.config || {};
            console.log(`[queue] Active config: slot=${configRow?.slot}, skip_llm_merge=${userConfig.skip_llm_merge}, prompts=${userConfig.prompts?.length}, first_prompt_start="${(userConfig.prompts?.[0]?.text || '').substring(0, 40)}..."`);

            // Load user tokens from social_connections or platform_tokens
            const userTokens = await db.getAllPlatformTokens(userId);
            const tokenMap = {};
            for (const [platform, row] of Object.entries(userTokens)) {
                tokenMap[platform] = {
                    access_token: row.access_token,
                    refresh_token: row.refresh_token,
                    metadata: row.metadata || {},
                    user_id: row.metadata?.user_id,
                };
            }

            // Run pipeline with phase updates (pass lastPromptId to avoid repeats)
            const lastPromptId = userConfig.last_prompt_id || null;
            const result = await runPipeline(
                { ...jobData, jobId, lastPromptId },
                userConfig,
                tokenMap,
                async (phase, detail) => {
                    await db.updateJobStatus(jobId, 'processing', phase);
                    // Update BullMQ job progress
                    const phaseMap = { prompt_generation: 25, image_generation: 50, video_generation: 75, uploading: 90 };
                    await job.updateProgress(phaseMap[phase] || 0);
                }
            );

            // Save selected prompt ID to avoid repeats on next run
            if (result.prompt?.selectedPromptId != null) {
                await db.updateConfigField(userId, 'last_prompt_id', result.prompt.selectedPromptId);
            }

            // Save assets to DB so frontend can display them
            try {
                if (result.image?.url) {
                    await db.logAsset(userId, {
                        type: 'image', filename: `job${jobId}_image.png`,
                        path: result.image.url,
                        sourceUrl: result.image.url, publicUrl: result.image.url,
                        executionId: String(jobId), prompt: result.prompt?.imagePrompt || '',
                        metadata: {}, size: 0
                    });
                }
                if (result.video?.url) {
                    await db.logAsset(userId, {
                        type: 'video', filename: `job${jobId}_video.mp4`,
                        path: result.video.url,
                        sourceUrl: result.video.url, publicUrl: result.video.url,
                        executionId: String(jobId), prompt: result.prompt?.action || '',
                        metadata: { image_prompt: result.prompt?.imagePrompt }, size: 0
                    });
                }
            } catch (assetErr) { console.error('[queue] Asset DB save error:', assetErr.message); }

            await db.updateJobStatus(jobId, 'completed', null, result);
            console.log(`[queue] Job #${jobId} completed successfully`);
            return result;

        } catch (err) {
            console.error(`[queue] Job #${jobId} failed:`, err.message);
            await db.updateJobStatus(jobId, 'failed', null, null, err.message);
            throw err;
        }
    }, {
        connection: conn,
        concurrency: 1,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
    });

    pipelineWorker.on('completed', (job) => {
        console.log(`[queue] Worker: job ${job.id} completed`);
    });

    pipelineWorker.on('failed', (job, err) => {
        console.error(`[queue] Worker: job ${job?.id} failed:`, err.message);
    });

    console.log('Pipeline queue initialized (Redis + BullMQ, concurrency: 5)');
    return { queue: pipelineQueue, worker: pipelineWorker };
}

// ==================== IN-MEMORY FALLBACK ====================

const inMemoryJobs = [];

function initInMemoryQueue() {
    pipelineQueue = {
        add: async (name, data) => {
            const fakeJob = { id: `mem-${Date.now()}`, data, name };
            inMemoryJobs.push(fakeJob);
            // Process immediately in background
            processInMemoryJob(fakeJob);
            return fakeJob;
        },
        getJobCounts: async () => ({ waiting: 0, active: inMemoryJobs.length, completed: 0, failed: 0 }),
    };

    console.log('Pipeline queue initialized (in-memory fallback)');
    return { queue: pipelineQueue, worker: null };
}

async function processInMemoryJob(job) {
    const { userId, jobId, jobData } = job.data;
    try {
        await db.updateJobStatus(jobId, 'processing', 'prompt_generation');

        // Load user's active config from DB (per-user)
        const configRow = await db.getActiveConfig(userId);
        const userConfig = configRow?.config || {};
        console.log(`[queue] Active config: slot=${configRow?.slot}, skip_llm_merge=${userConfig.skip_llm_merge}, prompts=${userConfig.prompts?.length}, first_prompt_start="${(userConfig.prompts?.[0]?.text || '').substring(0, 40)}..."`);

        const userTokens = await db.getAllPlatformTokens(userId);
        const tokenMap = {};
        for (const [platform, row] of Object.entries(userTokens)) {
            tokenMap[platform] = {
                access_token: row.access_token,
                refresh_token: row.refresh_token,
                metadata: row.metadata || {},
                user_id: row.metadata?.user_id,
            };
        }

        // Pass lastPromptId to avoid repeats
        const lastPromptId = userConfig.last_prompt_id || null;
        const result = await runPipeline(
            { ...jobData, jobId, lastPromptId },
            userConfig,
            tokenMap,
            async (phase) => { await db.updateJobStatus(jobId, 'processing', phase); }
        );

        // Save selected prompt ID to avoid repeats on next run
        if (result.prompt?.selectedPromptId != null) {
            await db.updateConfigField(userId, 'last_prompt_id', result.prompt.selectedPromptId);
        }

        // Save assets to DB so frontend can display them
        try {
            if (result.image?.url) {
                await db.logAsset(userId, {
                    type: 'image', filename: `job${jobId}_image.png`,
                    path: result.image.localPath || '',
                    sourceUrl: result.image.url, publicUrl: result.image.url,
                    executionId: String(jobId), prompt: result.prompt?.imagePrompt || '',
                    metadata: {}, size: 0
                });
            }
            if (result.video?.url) {
                await db.logAsset(userId, {
                    type: 'video', filename: `job${jobId}_video.mp4`,
                    path: result.video.localPath || '',
                    sourceUrl: result.video.url, publicUrl: result.video.url,
                    executionId: String(jobId), prompt: result.prompt?.action || '',
                    metadata: { image_prompt: result.prompt?.imagePrompt }, size: 0
                });
            }
        } catch (assetErr) { console.error('[queue] Asset DB save error:', assetErr.message); }

        await db.updateJobStatus(jobId, 'completed', null, result);
    } catch (err) {
        await db.updateJobStatus(jobId, 'failed', null, null, err.message);
    }
}

// ==================== SUBMIT JOB ====================

async function submitPipelineJob(userId, jobData) {
    // Create job record in DB
    const job = await db.createJob(userId, jobData);

    // Add to queue
    if (pipelineQueue) {
        await pipelineQueue.add('run-pipeline', {
            userId,
            jobId: job.id,
            jobData,
        }, {
            attempts: 2,
            backoff: { type: 'exponential', delay: 10000 },
        });
    }

    return job;
}

// ==================== QUEUE STATS ====================

async function getQueueStats() {
    if (!pipelineQueue?.getJobCounts) return { waiting: 0, active: 0, completed: 0, failed: 0 };
    try {
        return await pipelineQueue.getJobCounts();
    } catch {
        return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
}

module.exports = {
    initQueue,
    submitPipelineJob,
    getQueueStats,
};
