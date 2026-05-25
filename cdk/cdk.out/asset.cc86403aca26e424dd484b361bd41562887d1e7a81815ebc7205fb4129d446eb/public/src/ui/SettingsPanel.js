/**
 * SettingsPanel - Handles settings UI logic and configuration management
 */

const DEFAULT_CONFIG = {
    awsRegion: 'ap-northeast-1',
    systemPrompt: '',
    voiceId: 'tiffany',
    responseTiming: 'medium',
    outputSampleRate: 24000,
    audioBufferMs: 200,
    temperature: 1,
    topP: 0.9,
    maxTokens: 2048,
    enabledTools: []
};

export class SettingsPanel {
    constructor(elements, onConfigChange) {
        this.elements = elements;
        this.onConfigChange = onConfigChange;
        this.config = { ...DEFAULT_CONFIG };
        this.promptPresets = {};
        this.customSelects = document.querySelectorAll('.custom-select');

        this.init();
    }

    init() {
        this.loadSavedConfig();
        this.initCustomSelects();
        this.initSliders();
        this.initPanelToggle();
        this.initTextarea();
        this.applyConfigToUI();
    }

    loadSavedConfig() {
        const saved = localStorage.getItem('novaSonicConfig');
        if (saved) {
            this.config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
        }
        if (!this.config.systemPrompt?.trim()) {
            this.loadPromptPreset('default');
        }
    }

    saveConfig() {
        localStorage.setItem('novaSonicConfig', JSON.stringify(this.config));
    }

    getConfig() {
        return { ...this.config };
    }

    setDisabled(disabled) {
        const settingsContent = document.querySelector('.settings-content');
        if (settingsContent) {
            settingsContent.classList.toggle('settings-disabled', disabled);
        }

        this.customSelects.forEach(select => {
            select.classList.toggle('disabled', disabled);
        });

        const { systemPrompt, temperature, temperatureValue, topP, topPValue, 
                maxTokens, maxTokensValue, audioBuffer, audioBufferValue } = this.elements;

        [systemPrompt, temperature, temperatureValue, topP, topPValue,
         maxTokens, maxTokensValue, audioBuffer, audioBufferValue].forEach(el => {
            if (el) el.disabled = disabled;
        });
    }

    initCustomSelects() {
        this.customSelects.forEach(select => {
            const trigger = select.querySelector('.custom-select-trigger');
            const options = select.querySelectorAll('.custom-select-option');
            const valueDisplay = select.querySelector('.custom-select-value');
            const selectId = select.dataset.id;
            const settingItem = select.closest('.setting-item') || select.closest('.settings-section');

            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                if (select.classList.contains('disabled')) return;

                this.customSelects.forEach(s => {
                    if (s !== select) {
                        s.classList.remove('open');
                        const parentItem = s.closest('.setting-item') || s.closest('.settings-section');
                        if (parentItem) parentItem.style.zIndex = '';
                    }
                });

                const isOpening = !select.classList.contains('open');
                select.classList.toggle('open');
                if (settingItem) {
                    settingItem.style.zIndex = isOpening ? '1000' : '';
                }
            });

            options.forEach(option => {
                option.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const value = option.dataset.value;

                    options.forEach(o => o.classList.remove('selected'));
                    option.classList.add('selected');

                    if (selectId === 'voice-type') {
                        // Clone content to preserve icons safely
                        valueDisplay.textContent = '';
                        Array.from(option.childNodes).forEach(node => {
                            valueDisplay.appendChild(node.cloneNode(true));
                        });
                    } else {
                        const label = option.querySelector('.option-label');
                        valueDisplay.textContent = label ? label.textContent.trim() : option.textContent.trim();
                    }

                    select.dataset.value = value;
                    select.classList.remove('open');
                    if (settingItem) settingItem.style.zIndex = '';

                    this.updateConfigFromSelect(selectId, value);
                });
            });
        });

        document.addEventListener('click', () => {
            this.customSelects.forEach(select => {
                select.classList.remove('open');
                const parentItem = select.closest('.setting-item') || select.closest('.settings-section');
                if (parentItem) parentItem.style.zIndex = '';
            });
        });
    }

    async loadPromptPreset(presetName) {
        if (presetName === 'custom') return;

        if (this.promptPresets[presetName]) {
            this.config.systemPrompt = this.promptPresets[presetName];
            this.elements.systemPrompt.value = this.promptPresets[presetName];
            return;
        }

        try {
            const response = await fetch(`/prompts/${presetName}.md`);
            if (response.ok) {
                const content = await response.text();
                this.promptPresets[presetName] = content;
                this.config.systemPrompt = content;
                this.elements.systemPrompt.value = content;
            }
        } catch (error) {
            console.error('Failed to load prompt preset:', error);
        }
    }

    updateConfigFromSelect(selectId, value) {
        switch (selectId) {
            case 'aws-region':
                this.config.awsRegion = value;
                break;
            case 'voice-type':
                this.config.voiceId = value;
                break;
            case 'response-timing':
                this.config.responseTiming = value;
                break;
            case 'output-sample-rate':
                this.config.outputSampleRate = parseInt(value, 10);
                break;
            case 'prompt-preset':
                this.loadPromptPreset(value);
                break;
        }
        this.onConfigChange?.(this.config);
    }

    setCustomSelectValue(selectId, value) {
        const select = document.querySelector(`.custom-select[data-id="${selectId}"]`);
        if (!select) return;

        const options = select.querySelectorAll('.custom-select-option');
        const valueDisplay = select.querySelector('.custom-select-value');

        options.forEach(option => {
            if (option.dataset.value === value) {
                options.forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');

                if (selectId === 'voice-type') {
                    // Clone content to preserve icons safely
                    valueDisplay.textContent = '';
                    Array.from(option.childNodes).forEach(node => {
                        valueDisplay.appendChild(node.cloneNode(true));
                    });
                } else {
                    const label = option.querySelector('.option-label');
                    valueDisplay.textContent = label ? label.textContent.trim() : option.textContent.trim();
                }
                select.dataset.value = value;
            }
        });
    }

    initSliders() {
        const { temperature, temperatureValue, topP, topPValue, 
                maxTokens, maxTokensValue, audioBuffer, audioBufferValue } = this.elements;

        this.setupSliderSync(temperature, temperatureValue, 'temperature');
        this.setupSliderSync(topP, topPValue, 'topP');
        this.setupSliderSync(maxTokens, maxTokensValue, 'maxTokens');
        this.setupSliderSync(audioBuffer, audioBufferValue, 'audioBufferMs', (value) => {
            this.onConfigChange?.(this.config, 'audioBufferMs', value);
        });
    }

    setupSliderSync(slider, input, configKey, onChange = null) {
        if (!slider || !input) return;

        slider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            input.value = value;
            this.config[configKey] = value;
            this.updateSliderTrack(slider);
            onChange?.(value);
            this.onConfigChange?.(this.config);
        });

        input.addEventListener('change', (e) => {
            let value = parseFloat(e.target.value);
            const min = parseFloat(slider.min);
            const max = parseFloat(slider.max);
            value = Math.max(min, Math.min(max, value));
            e.target.value = value;
            slider.value = value;
            this.config[configKey] = value;
            this.updateSliderTrack(slider);
            onChange?.(value);
            this.onConfigChange?.(this.config);
        });

        this.updateSliderTrack(slider);
    }

    updateSliderTrack(slider) {
        if (!slider) return;
        const percent = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
        slider.style.background = `linear-gradient(to right, var(--primary) ${percent}%, var(--bg-input) ${percent}%)`;
    }

    initPanelToggle() {
        const { settingsToggle, settingsPanel, settingsOverlay, settingsClose } = this.elements;

        settingsToggle?.addEventListener('click', () => {
            settingsPanel?.classList.add('open');
            settingsOverlay?.classList.add('open');
        });

        const closeSettings = () => {
            settingsPanel?.classList.remove('open');
            settingsOverlay?.classList.remove('open');
            this.saveConfig();
        };

        settingsClose?.addEventListener('click', closeSettings);
        settingsOverlay?.addEventListener('click', closeSettings);
    }

    initTextarea() {
        this.elements.systemPrompt?.addEventListener('input', (e) => {
            this.config.systemPrompt = e.target.value;
            this.setCustomSelectValue('prompt-preset', 'custom');
            this.onConfigChange?.(this.config);
        });
    }

    applyConfigToUI() {
        this.setCustomSelectValue('aws-region', this.config.awsRegion);
        this.setCustomSelectValue('voice-type', this.config.voiceId);
        this.setCustomSelectValue('response-timing', this.config.responseTiming);
        this.setCustomSelectValue('output-sample-rate', String(this.config.outputSampleRate));

        const { systemPrompt, temperature, temperatureValue, topP, topPValue,
                maxTokens, maxTokensValue, audioBuffer, audioBufferValue } = this.elements;

        if (systemPrompt) systemPrompt.value = this.config.systemPrompt;
        if (temperature) { temperature.value = this.config.temperature; this.updateSliderTrack(temperature); }
        if (temperatureValue) temperatureValue.value = this.config.temperature;
        if (topP) { topP.value = this.config.topP; this.updateSliderTrack(topP); }
        if (topPValue) topPValue.value = this.config.topP;
        if (maxTokens) { maxTokens.value = this.config.maxTokens; this.updateSliderTrack(maxTokens); }
        if (maxTokensValue) maxTokensValue.value = this.config.maxTokens;
        if (audioBuffer) { audioBuffer.value = this.config.audioBufferMs; this.updateSliderTrack(audioBuffer); }
        if (audioBufferValue) audioBufferValue.value = this.config.audioBufferMs;
    }
}
