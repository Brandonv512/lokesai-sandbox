const db = require('./db');
const { submitPipelineJob } = require('./queue');
const { callClaude, callGemini } = require('./pipeline');

let schedulerInterval = null;
let lastCheckedMinute = null;

// ==================== SCHEDULER ====================

function startScheduler() {
    if (schedulerInterval) return;

    // Check every 30 seconds
    schedulerInterval = setInterval(checkSchedules, 30000);
    console.log('Scheduler started (checking every 30s)');
}

function stopScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }
}

async function checkSchedules() {
    const now = new Date();
    const currentHH = String(now.getHours()).padStart(2, '0');
    const currentMM = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${currentHH}:${currentMM}`;

    // Avoid duplicate triggers within the same minute
    if (currentTime === lastCheckedMinute) return;
    lastCheckedMinute = currentTime;

    try {
        const schedules = await db.getAllEnabledSchedules();

        for (const schedule of schedules) {
            const cronTimes = schedule.cron_times || [];

            if (cronTimes.includes(currentTime)) {
                console.log(`[scheduler] Triggering scheduled job for user ${schedule.user_id} at ${currentTime}`);

                try {
                    // Get user's active config index (default 0)
                    const configs = await db.getAllUserConfigs(schedule.user_id);
                    const configIndex = 0; // Use first config for scheduled runs

                    // Get user's saved settings from their config
                    const config = configs[0];
                    const data = config?.data || {};

                    // Check for character cards to rotate through
                    let characterCardData = null;
                    let voiceConfig = null;
                    try {
                        const cards = await db.getCharacterCards(schedule.user_id, { sortBy: 'most_used' });
                        if (cards.length > 0) {
                            // Rotate: pick the least-recently-used card
                            const sorted = [...cards].sort((a, b) => {
                                const aTime = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
                                const bTime = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
                                return aTime - bTime;
                            });
                            const card = sorted[0];
                            characterCardData = card.character_data || {};
                            await db.incrementCardUseCount(card.id);
                            console.log(`[scheduler] Using character card: ${card.name} (ID: ${card.id})`);

                            // Load voice config for the card
                            const vc = await db.getVoiceConfig(card.id);
                            if (vc) voiceConfig = vc;
                        }
                    } catch (e) {
                        console.log(`[scheduler] Character card rotation skipped: ${e.message}`);
                    }

                    const jobPayload = {
                        llmProvider: data.llmProvider || 'gemini',
                        imageModel: data.imageModel || 'nano-banana-pro',
                        videoModel: data.videoModel || 'kling-2.6/image-to-video',
                        videoDuration: data.videoDuration || '5',
                        platforms: data.enabledPlatforms || [],
                        source: 'scheduler',
                    };
                    if (characterCardData) jobPayload.characterCardData = characterCardData;
                    if (voiceConfig) jobPayload.voiceConfig = voiceConfig;

                    // If character has bio data, use content agent for in-character content
                    if (characterCardData && (characterCardData.bio || characterCardData.personality || characterCardData.backstory)) {
                        try {
                            console.log(`[scheduler] Character has bio data — generating in-character content plan...`);
                            const agentContent = await generateContentPlan(card, data.llmProvider || 'gemini');
                            if (agentContent) {
                                jobPayload.agentGeneratedContent = agentContent;
                                console.log(`[scheduler] Content plan generated: "${agentContent.imagePrompt?.substring(0, 60)}..."`);
                            }
                        } catch (agentErr) {
                            console.log(`[scheduler] Content agent skipped: ${agentErr.message}`);
                        }
                    }

                    await submitPipelineJob(schedule.user_id, jobPayload, configIndex);

                    console.log(`[scheduler] Job submitted for user ${schedule.user_id}`);
                } catch (err) {
                    console.error(`[scheduler] Failed to submit job for user ${schedule.user_id}:`, err.message);
                }
            }
        }
    } catch (err) {
        console.error('[scheduler] Check failed:', err.message);
    }

    // Also check calendar-based slots
    try {
        await checkCalendarSlots(currentTime);
    } catch (err) {
        console.error('[scheduler] Calendar check failed:', err.message);
    }
}

async function checkCalendarSlots(currentTime) {
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const now = new Date();
    const currentDay = dayNames[now.getDay()];

    const schedules = await db.getAllEnabledSchedules();

    for (const schedule of schedules) {
        try {
            const calendar = await db.getCalendarSchedule(schedule.user_id);
            if (!calendar || !calendar.slots || calendar.slots.length === 0) continue;

            // Check frequency filter
            const freq = calendar.frequency || 'daily';
            if (freq === 'weekdays' && (currentDay === 'sat' || currentDay === 'sun')) continue;
            if (freq === 'weekends' && currentDay !== 'sat' && currentDay !== 'sun') continue;

            // Find matching slot for current day + time
            const matchingSlot = calendar.slots.find(
                s => s.day === currentDay && s.time === currentTime
            );

            if (!matchingSlot || !matchingSlot.lookId) continue;

            const look = await db.getSavedLook(matchingSlot.lookId);
            if (!look) {
                console.log(`[scheduler:calendar] Look ${matchingSlot.lookId} not found, skipping`);
                continue;
            }

            console.log(`[scheduler:calendar] Triggering look "${look.name}" for user ${schedule.user_id} at ${currentDay} ${currentTime}`);

            const settings = look.settings || {};
            const jobPayload = {
                llmProvider: settings.llmProvider || 'gemini',
                imageModel: settings.imageModel || 'nano-banana-pro',
                videoModel: settings.videoModel || 'kling-2.6/image-to-video',
                videoDuration: settings.videoDuration || '5',
                composedPrompt: settings.prompt || '',
                characterCardIds: settings.characterIds || [],
                platforms: settings.platforms || [],
                source: 'calendar',
            };

            await submitPipelineJob(schedule.user_id, jobPayload);
            await db.incrementLookUseCount(matchingSlot.lookId);

            console.log(`[scheduler:calendar] Calendar job submitted for user ${schedule.user_id}`);
        } catch (err) {
            console.error(`[scheduler:calendar] Failed for user ${schedule.user_id}:`, err.message);
        }
    }
}

async function generateContentPlan(card, llmProvider) {
    const cd = card.character_data || {};
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

Respond in valid JSON only with keys: imagePrompt, videoAction, caption, voiceScript, hashtags`;

    const userMessage = 'Create a fresh, unique content idea for today. Make it feel authentic and engaging.';

    let response;
    if (llmProvider === 'claude') {
        response = await callClaude(systemPrompt, userMessage);
    } else {
        response = await callGemini(systemPrompt, userMessage);
    }

    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        const match = response.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error('Could not parse content plan JSON');
    }

    return {
        imagePrompt: parsed.imagePrompt || '',
        videoAction: parsed.videoAction || '',
        caption: parsed.caption || '',
        voiceScript: parsed.voiceScript || '',
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
    };
}

module.exports = {
    startScheduler,
    stopScheduler,
};
