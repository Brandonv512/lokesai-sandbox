const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

const EMPTY_CONFIG = {
    character_description: '', prompts: [], actions: [], scenes: [],
    variations: {}, content_rules: '', reference_image_url: '',
    custom_prompt_override: '', music: [], caption_template: '', video_suffix: ''
};

function loadDataFile() {
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (Array.isArray(raw.configs)) return raw;
        const migrated = {
            activeConfig: 0,
            configs: [
                { name: 'Config 1', ...raw },
                { name: 'Config 2', ...JSON.parse(JSON.stringify(EMPTY_CONFIG)) },
                { name: 'Config 3', ...JSON.parse(JSON.stringify(EMPTY_CONFIG)) }
            ]
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(migrated, null, 2));
        return migrated;
    } catch {
        return {
            activeConfig: 0,
            configs: [
                { name: 'Config 1', ...JSON.parse(JSON.stringify(EMPTY_CONFIG)) },
                { name: 'Config 2', ...JSON.parse(JSON.stringify(EMPTY_CONFIG)) },
                { name: 'Config 3', ...JSON.parse(JSON.stringify(EMPTY_CONFIG)) }
            ]
        };
    }
}

function saveDataFile(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getActiveConfigFile(data) {
    return data.configs[data.activeConfig] || data.configs[0];
}

module.exports = { loadDataFile, saveDataFile, getActiveConfigFile, EMPTY_CONFIG, DATA_FILE };
