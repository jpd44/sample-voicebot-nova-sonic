import { AudioPlayer } from './lib/play/AudioPlayer.js';
import { ChatHistoryManager } from "./lib/util/ChatHistoryManager.js";
import { scenarioAmbience } from './lib/play/ScenarioAmbience.js';

// Connect to the server
const socket = io();

// DOM elements
const voiceBtn = document.getElementById('voice-btn');
const micIcon = voiceBtn.querySelector('.mic-icon');
const stopIcon = voiceBtn.querySelector('.stop-icon');
const chatContainer = document.getElementById('chat-container');
const voiceHint = document.querySelector('.voice-hint');
const waveformCanvas = document.getElementById('waveform-canvas');
const ctx = waveformCanvas.getContext('2d');
const ringCanvas = document.getElementById('ring-canvas');
const ringCtx = ringCanvas.getContext('2d');
const themeToggle = document.getElementById('theme-toggle');

// Settings elements
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const systemPromptTextarea = document.getElementById('system-prompt');
const temperatureSlider = document.getElementById('temperature');
const temperatureValue = document.getElementById('temperature-value');
const topPSlider = document.getElementById('top-p');
const topPValue = document.getElementById('top-p-value');
const maxTokensSlider = document.getElementById('max-tokens');
const maxTokensValue = document.getElementById('max-tokens-value');
const audioBufferSlider = document.getElementById('audio-buffer');
const audioBufferValue = document.getElementById('audio-buffer-value');

// Custom dropdown elements
const customSelects = document.querySelectorAll('.custom-select');

// Theme
let isDarkMode = false;

// Chat history management
let chat = { history: [] };
const chatRef = { current: chat };
const chatHistoryManager = ChatHistoryManager.getInstance(
    chatRef,
    (newChat) => {
        chat = { ...newChat };
        chatRef.current = chat;
        updateChatUI();
    }
);

// Audio processing variables
let audioContext;
let audioStream;
let isStreaming = false;
let processor;
let sourceNode;
let waitingForAssistantResponse = false;
let waitingForUserTranscription = false;
let pendingToolUses = []; // Array to support multiple tools
let userThinkingIndicator = null;
let assistantThinkingIndicator = null;
let transcriptionReceived = false;
let displayAssistantText = false;
let role;
const audioPlayer = new AudioPlayer();
let sessionInitialized = false;
let manualDisconnect = false;

// Waveform animation
let animationId = null;
let audioLevel = 0;
let targetAudioLevel = 0;
let assistantAudioLevel = 0;
let targetAssistantAudioLevel = 0;
let hueRotation = 0;
let isAnimating = false;

// Audio playback duration tracking
let speechStartTime = 0;
let totalAudioDuration = 0;
let audioFadeTimer = null;

// Ring fade out state
let ringFadeAlpha = 0;
let isRingFadingOut = false;

let samplingRatio = 1;
const TARGET_SAMPLE_RATE = 16000;
const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');

// Configuration state (defaults loaded from server)
let config = {
    awsRegion: 'ap-northeast-1',
    systemPrompt: '',
    language: 'de',
    persona: 'a1',
    scenario: 'none',
    voiceId: 'tiffany',
    responseTiming: 'medium',
    outputSampleRate: 24000,
    audioBufferMs: 200,
    temperature: 1,
    topP: 0.9,
    maxTokens: 2048,
    enabledTools: [],
    correctionsShow: true,
    correctionsLevel: 'all',   // off | major | all
    correctionsSpoken: false,
    botGreetsFirst: false,
};

// Scenario instruction snippets. Each one is appended to the chosen persona prompt
// so the persona's CEFR rules still apply but the conversation has a concrete focus.
const SCENARIOS = {
    none: '',
    introduce_yourself: `SCENARIO: Sich vorstellen.
Greet the learner and introduce yourself in one short sentence. Then ask them to introduce themselves. Cover, one question per turn, in order: name, age, where they live, where they come from, what they do (Beruf or Studium), and a hobby. At B1+ also ask why they live there, what they like about their work, and what their plans are.`,

    order_coffee: `SCENARIO: Café/cafeteria/bar order.
You are the barista at a small local café in the country whose language the learner is practicing. The learner is the customer. Greet them, take their order step by step (drink, food, here or to go), tell them the price.
- If practicing German: a Bäckerei or Café in Germany/Austria — suggest Butterbreze, Brezel, Apfeltasche, Käsekuchen, Streuselkuchen as food. Prices in Euro.
- If practicing Brazilian Portuguese: a padaria/cafeteria in Brazil — suggest pão de queijo, coxinha, brigadeiro, sonho, pastel as food. Prices in reais (R$).
- If practicing Latin American Spanish: a cafetería in Mexico/Colombia/Argentina — suggest empanada, tortilla, churros, medialuna (AR), pan dulce, croissant as food. Prices in local currency (pesos/soles).
- If practicing Italian: a bar italiano — suggest cornetto, sfogliatella, brioche, cannoli, tramezzino as food. Prices in Euro.
IMPORTANT: when the customer asks whether they can pay by card, politely refuse — say cash only ("Es tut mir leid, wir nehmen nur Bargeld" in German, "Desculpe, só aceitamos dinheiro" in Portuguese, "Lo siento, solo aceptamos efectivo" in Spanish, "Mi dispiace, accettiamo solo contanti" in Italian). Accept gracefully if they then offer cash. Speak only as the barista; do not narrate.`,

    ask_directions: `SCENARIO: Nach dem Weg fragen.
You are a friendly local on the street. The learner stops you to ask for directions. Improvise a small German town. When they ask, give clear step-by-step directions using rechts, links, geradeaus, an der Ampel, neben der Kirche. If they don't understand, repeat with simpler language.`,

    grocery_shopping: `SCENARIO: Im Supermarkt einkaufen.
You are a shop assistant. Help the learner find items, weigh produce, answer about prices, suggest alternatives if something is out of stock. They will ask for typical groceries — react naturally.`,

    describe_family: `SCENARIO: Familie beschreiben.
Ask the learner about their family. Cover, one at a time: how many siblings, parents' jobs, where the family lives, what they do together. Share one short fact about your own (fictional) family between questions to keep the conversation balanced.`,

    weekend_story: `SCENARIO: Über das Wochenende erzählen.
Ask the learner what they did last weekend. Push for Perfekt forms with follow-up questions: Wo warst du? Mit wem? Wie war es? Then offer to tell about your own weekend in short Perfekt sentences and let them ask questions back.`,

    doctor_visit: `SCENARIO: Beim Arzt.
You are a Hausarzt. The learner is a patient. Greet them, ask what brings them in (Was fehlt Ihnen?), ask follow-up questions (Seit wann? Wo genau? Haben Sie Fieber?), and suggest a course of action (Medikament, Ruhe, Krankschreibung). Use Sie throughout.`,

    book_hotel: `SCENARIO: Hotel buchen / einchecken.
You are at the hotel reception. The learner walks in to check in (or calls to book). Ask for their name, dates, room type, and any special requests. Confirm price and breakfast inclusion. Use Sie.`,

    apartment_hunt: `SCENARIO: Wohnungssuche.
You are a landlord showing a flat. The learner is the prospective tenant. Describe the rooms (Zimmer, Größe in qm, Stockwerk, Balkon, Heizung, Nebenkosten). Let them ask questions and respond as a realistic landlord would.`,

    make_plans: `SCENARIO: Verabredung treffen.
You are the learner's friend. Suggest doing something together this week (Kino, Essen, Wandern). Negotiate Tag, Uhrzeit, Ort. Use du. If they say no to your first suggestion, offer alternatives.`,

    discuss_film: `SCENARIO: Über einen Film erzählen.
Ask the learner about a film they recently saw. Push for: Worum geht es? Wer spielt mit? Wie hat dir das Ende gefallen? Würdest du den Film empfehlen? Share your opinion about a (fictional) film of your own to model the structure.`,

    complaint: `SCENARIO: Höflich reklamieren.
You play the role of a service representative (Restaurant, Online-Shop, Vermieter — choose contextually). The learner has a problem and complains. Push them to be polite and use Konjunktiv II forms like "Könnten Sie..." and "Ich hätte gern...". Resolve the issue at the end.`,

    advice: `SCENARIO: Ratschläge geben.
You describe a small problem ("Ich habe einen Streit mit meinem Mitbewohner" or "Ich kann mich nicht entscheiden, ob ich den Job annehmen soll"). Ask the learner what they would do. Encourage Konjunktiv II ("An deiner Stelle würde ich..."). Push back on weak advice with follow-up questions.`,

    job_interview: `SCENARIO: Vorstellungsgespräch.
You are the hiring manager. The learner is the candidate. Ask: Was sind Ihre Stärken? Warum interessiert Sie diese Stelle? Wo sehen Sie sich in fünf Jahren? Was sind Ihre Gehaltsvorstellungen? Adapt difficulty to CEFR. Use Sie throughout.`,

    travel_problem: `SCENARIO: Reisepanne lösen.
You are a Bahn employee at the Reisezentrum. The learner has missed their train / lost a suitcase / had a delay. Listen to the problem, ask clarifying questions, offer concrete solutions (umbuchen, Erstattung beantragen, Fundbüro).`,

    debate_topic: `SCENARIO: Über ein aktuelles Thema diskutieren.
Pick a topic that fits the CEFR level (A2: "Was ist besser, Stadt oder Land?"; B1: "Auto oder Fahrrad?"; B2: "Tempolimit auf Autobahnen?"; C1: "KI im Beruf — Chance oder Risiko?"). Take a position and defend it. Push the learner to defend theirs with Konnektoren (allerdings, jedoch, einerseits…andererseits).`,

    describe_chart: `SCENARIO: Eine Grafik beschreiben.
Describe a fictional statistic verbally (e.g. "Die Grafik zeigt, dass der Stromverbrauch in Deutschland zwischen 2010 und 2023 um 12% gesunken ist..."). Ask the learner to summarize what you said, then interpret possible reasons. Practice Steigerung, Vergleich, Prozentangaben.`,

    workplace_conflict: `SCENARIO: Konfliktgespräch am Arbeitsplatz.
You play a colleague the learner has a conflict with (you forgot to share information; they missed a deadline; whatever fits). Roleplay the conversation. Force the learner to be assertive and diplomatic. Resolve constructively at the end.`,

    literary_analysis: `SCENARIO: Literarischen Text interpretieren.
You quote two or three lines from a short German poem or prose passage (Kafka, Brecht, Goethe — pick freely). Ask the learner what it means, what the mood is, what literary devices are present. Push them to use gehobene Lexik.`,

    ethical_debate: `SCENARIO: Über ein ethisches Dilemma debattieren.
Present a moral dilemma (Sterbehilfe, KI-Entscheidungen in der Medizin, Klimagerechtigkeit, Tierversuche). Ask the learner to take a position. Challenge it from the opposite side. Push them to qualify ("Es kommt darauf an, ob…").`,

    negotiation: `SCENARIO: Verhandlung mit komplexen Bedingungen.
Roleplay a contract or business negotiation (Mietvertrag, Gehaltsverhandlung, Vertragsklauseln). Both sides have priorities. Push the learner to formulate Bedingungen, Gegenangebote, and Kompromisse using Konjunktiv II.`,
};

// Per-language overrides for scenario step labels. Defaults below are German-flavored.
// To override for another language, add the same step ID under that language's key with a different label.
const SCENARIO_STEPS_BY_LANG = {
    pt: {
        order_coffee: [
            { id: 'order_cappuccino', label: 'Order a cappuccino' },
            { id: 'order_butterbreze', label: 'Order a pão de queijo (or another Brazilian café item)' },
            { id: 'ask_card', label: 'Ask if you can pay by card' },
            { id: 'accept_cash', label: 'Agree to pay in cash after the barista declines card' },
        ],
    },
    es: {
        order_coffee: [
            { id: 'order_cappuccino', label: 'Order a café con leche' },
            { id: 'order_butterbreze', label: 'Order an empanada (or another Latin American café item)' },
            { id: 'ask_card', label: 'Ask if you can pay by card' },
            { id: 'accept_cash', label: 'Agree to pay in cash after the barista declines card' },
        ],
    },
    it: {
        order_coffee: [
            { id: 'order_cappuccino', label: 'Order a cappuccino' },
            { id: 'order_butterbreze', label: 'Order a cornetto (or another Italian café item)' },
            { id: 'ask_card', label: 'Ask if you can pay by card' },
            { id: 'accept_cash', label: 'Agree to pay in cash after the barista declines card' },
        ],
    },
};

// Per-scenario user-side checklist. Items are short imperative goals the learner should
// accomplish through speech during the scenario. Empty array means "free conversation".
const SCENARIO_USER_STEPS_DE = {
    introduce_yourself: [
        { id: 'name', label: 'Say your name' },
        { id: 'origin', label: 'Say where you are from' },
        { id: 'city', label: 'Say where you currently live' },
        { id: 'work', label: 'Say what you do (work or study)' },
        { id: 'hobby', label: 'Mention one hobby' },
        { id: 'ask_back', label: 'Ask the bot a question about itself' },
    ],
    order_coffee: [
        { id: 'order_cappuccino', label: 'Order a cappuccino' },
        { id: 'order_butterbreze', label: 'Order a Butterbreze' },
        { id: 'ask_card', label: 'Ask if you can pay by card' },
        { id: 'accept_cash', label: 'Agree to pay in cash after the barista declines card' },
    ],
    ask_directions: [
        { id: 'greet', label: 'Politely get the local\'s attention (Entschuldigung / Disculpe / Scusi)' },
        { id: 'destination', label: 'Say where you want to go' },
        { id: 'clarify', label: 'Ask a clarification question if anything is unclear' },
        { id: 'thank', label: 'Thank them at the end' },
    ],
    book_hotel: [
        { id: 'check_in', label: 'Greet and say you have a reservation (or want to book)' },
        { id: 'dates', label: 'Specify the dates' },
        { id: 'room_type', label: 'Specify the room type (single/double, breakfast, etc.)' },
        { id: 'price_confirm', label: 'Confirm the price' },
    ],
    doctor_visit: [
        { id: 'symptom', label: 'Describe your main symptom' },
        { id: 'duration', label: 'Say how long you have had it' },
        { id: 'severity', label: 'Describe how bad it is' },
        { id: 'ask_treatment', label: 'Ask what you should do or take' },
    ],
    job_interview: [
        { id: 'introduce', label: 'Introduce yourself briefly' },
        { id: 'strengths', label: 'Describe one of your strengths' },
        { id: 'motivation', label: 'Explain why you want this job' },
        { id: 'question', label: 'Ask the interviewer one question' },
    ],
    make_plans: [
        { id: 'propose', label: 'Propose an activity' },
        { id: 'time', label: 'Suggest a day or time' },
        { id: 'place', label: 'Agree on a meeting place' },
    ],
    grocery_shopping: [
        { id: 'list_items', label: 'Ask for at least two items' },
        { id: 'quantity', label: 'Give a specific quantity or weight' },
        { id: 'price_or_pay', label: 'Ask the price or pay at checkout' },
    ],
    complaint: [
        { id: 'state_problem', label: 'Politely state the problem' },
        { id: 'request_fix', label: 'Request a specific resolution' },
        { id: 'use_konjunktiv', label: 'Use a polite conditional form (Konjunktiv II / condicional / condizionale)' },
    ],
};

// Accessor — returns the localized step list, falling back to the German default.
const SCENARIO_USER_STEPS = new Proxy({}, {
    get(_target, scenarioKey) {
        const lang = config.language || 'de';
        const override = SCENARIO_STEPS_BY_LANG[lang]?.[scenarioKey];
        return override || SCENARIO_USER_STEPS_DE[scenarioKey];
    }
});

// Available tools (loaded from server)
let availableTools = [];

// Available voices
const voiceData = {
    tiffany: { name: 'Tiffany', gender: 'female' },
    matthew: { name: 'Matthew', gender: 'male' }
};

// Session timeout management (Nova Sonic has 8-minute max connection)
const SESSION_TIMEOUT_MS = 7 * 60 * 1000; // 7 minutes (warn before 8-min limit)
const SESSION_WARNING_MS = 6 * 60 * 1000; // 6 minutes (show warning)
let sessionStartTime = null;
let sessionTimeoutTimer = null;
let sessionWarningTimer = null;

function startSessionTimers() {
    clearSessionTimers();
    sessionStartTime = Date.now();
    
    // Warning timer at 6 minutes
    sessionWarningTimer = setTimeout(() => {
        showSessionWarning();
    }, SESSION_WARNING_MS);
    
    // Auto-renewal timer at 7 minutes
    sessionTimeoutTimer = setTimeout(() => {
        handleSessionTimeout();
    }, SESSION_TIMEOUT_MS);
}

function clearSessionTimers() {
    if (sessionTimeoutTimer) {
        clearTimeout(sessionTimeoutTimer);
        sessionTimeoutTimer = null;
    }
    if (sessionWarningTimer) {
        clearTimeout(sessionWarningTimer);
        sessionWarningTimer = null;
    }
    sessionStartTime = null;
}

function showSessionWarning() {
    const warningDiv = document.createElement('div');
    warningDiv.className = 'message system session-warning';
    warningDiv.id = 'session-warning';
    warningDiv.innerHTML = '<span class="warning-icon">⏱️</span> Session expiring soon. Will auto-renew...';
    chatContainer.appendChild(warningDiv);
    scrollToBottom();
}

function hideSessionWarning() {
    const warning = document.getElementById('session-warning');
    if (warning && warning.parentNode) {
        warning.parentNode.removeChild(warning);
    }
}

async function handleSessionTimeout() {
    console.log('Session timeout - auto-renewing...');
    hideSessionWarning();
    
    // Show renewal indicator
    const renewDiv = document.createElement('div');
    renewDiv.className = 'message system session-renew';
    renewDiv.innerHTML = '<span class="renew-icon">🔄</span> Renewing session...';
    chatContainer.appendChild(renewDiv);
    scrollToBottom();
    
    try {
        const wasStreaming = isStreaming;
        
        // Close current session gracefully and wait for server confirmation
        if (sessionInitialized) {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    console.log('Session close timeout, proceeding anyway');
                    resolve();
                }, 5000);
                
                socket.once('sessionClosed', () => {
                    clearTimeout(timeout);
                    console.log('Session closed confirmed by server');
                    resolve();
                });
                
                socket.emit('stopAudio');
            });
        }
        
        sessionInitialized = false;
        
        // Small delay to ensure server cleanup is complete
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Reinitialize if was streaming
        if (wasStreaming) {
            await initializeSession();
            renewDiv.innerHTML = '<span class="renew-icon">✓</span> Session renewed';
            renewDiv.classList.add('success');
        } else {
            renewDiv.innerHTML = '<span class="renew-icon">✓</span> Session ended';
        }
        
        // Fade out the message
        setTimeout(() => {
            renewDiv.classList.add('fade-out');
            setTimeout(() => {
                if (renewDiv.parentNode) {
                    renewDiv.parentNode.removeChild(renewDiv);
                }
            }, 500);
        }, 2000);
    } catch (error) {
        console.error('Failed to renew session:', error);
        renewDiv.innerHTML = '<span class="renew-icon">⚠️</span> Session renewal failed';
        renewDiv.classList.add('error');
    }
}

// Settings disabled state management
function setSettingsDisabled(disabled) {
    const settingsContent = document.querySelector('.settings-content');
    if (settingsContent) {
        settingsContent.classList.toggle('settings-disabled', disabled);
    }
    
    // Disable/enable all interactive elements
    customSelects.forEach(select => {
        select.classList.toggle('disabled', disabled);
    });
    
    systemPromptTextarea.disabled = disabled;
    temperatureSlider.disabled = disabled;
    temperatureValue.disabled = disabled;
    topPSlider.disabled = disabled;
    topPValue.disabled = disabled;
    maxTokensSlider.disabled = disabled;
    maxTokensValue.disabled = disabled;
    audioBufferSlider.disabled = disabled;
    audioBufferValue.disabled = disabled;
    
    // Disable/enable tools checkboxes
    setToolsDisabled(disabled);
}

// Custom dropdown initialization
function initCustomSelects() {
    customSelects.forEach(select => {
        const trigger = select.querySelector('.custom-select-trigger');
        const options = select.querySelectorAll('.custom-select-option');
        const valueDisplay = select.querySelector('.custom-select-value');
        const selectId = select.dataset.id;
        const settingItem = select.closest('.setting-item') || select.closest('.settings-section');

        // Toggle dropdown
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Don't open if disabled
            if (select.classList.contains('disabled')) return;
            
            // Close other dropdowns and reset their z-index
            customSelects.forEach(s => {
                if (s !== select) {
                    s.classList.remove('open');
                    const parentItem = s.closest('.setting-item') || s.closest('.settings-section');
                    if (parentItem) parentItem.style.zIndex = '';
                }
            });
            
            // Toggle this dropdown
            const isOpening = !select.classList.contains('open');
            select.classList.toggle('open');
            
            // Set high z-index on parent when open
            if (settingItem) {
                settingItem.style.zIndex = isOpening ? '1000' : '';
            }
        });

        // Option selection
        options.forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                const value = option.dataset.value;

                // Update visual state
                options.forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                // Use innerHTML for voice-type to preserve icons
                if (selectId === 'voice-type') {
                    // Clone the option content to preserve icons safely
                    valueDisplay.textContent = '';
                    Array.from(option.childNodes).forEach(node => {
                        valueDisplay.appendChild(node.cloneNode(true));
                    });
                } else {
                    // For options with descriptions, only show the label
                    const label = option.querySelector('.option-label');
                    valueDisplay.textContent = label ? label.textContent.trim() : option.textContent.trim();
                }
                select.dataset.value = value;
                select.classList.remove('open');
                
                // Reset z-index
                if (settingItem) settingItem.style.zIndex = '';

                // Update config based on select id
                updateConfigFromSelect(selectId, value);
            });
        });
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        customSelects.forEach(select => {
            select.classList.remove('open');
            const parentItem = select.closest('.setting-item') || select.closest('.settings-section');
            if (parentItem) parentItem.style.zIndex = '';
        });
    });
}

// Prompt presets cache
const promptPresets = {};

async function fetchPersonaPrompt(personaName) {
    if (personaName === 'custom') return '';
    const lang = config.language || 'de';
    const cacheKey = `${lang}/${personaName}`;
    if (promptPresets[cacheKey]) return promptPresets[cacheKey];
    try {
        const response = await fetch(`/prompts/${lang}/${personaName}.md`);
        if (response.ok) {
            const content = await response.text();
            promptPresets[cacheKey] = content;
            return content;
        }
    } catch (error) {
        console.error('Failed to load persona prompt:', error);
    }
    return '';
}

const SPOKEN_CORRECTION_BLOCK = `SPOKEN CORRECTIONS:
When the learner's last turn contained a clear grammar or word-choice error, briefly correct it aloud BEFORE responding to the content. Use this template in the target language: "Better: <corrected version>." Keep it to one sentence, never more than one correction per turn, and don't lecture. If the learner's turn was correct, do not correct anything.`;

function composeSystemPrompt(personaPrompt, scenarioKey) {
    const scenarioText = SCENARIOS[scenarioKey] || '';
    const profileBlock = (typeof buildProfilePromptBlock === 'function') ? buildProfilePromptBlock() : '';
    let out = personaPrompt;
    if (scenarioText.trim()) out += `\n\n${scenarioText}`;
    if (config.correctionsSpoken) out += `\n\n${SPOKEN_CORRECTION_BLOCK}`;
    if (profileBlock) out += `\n\n${profileBlock}`;
    return out;
}

async function applyPersonaScenarioToTextarea() {
    if (config.persona === 'custom') {
        // In custom mode we don't overwrite the textarea — the user's content is authoritative.
        config.systemPrompt = systemPromptTextarea.value;
        return;
    }
    const personaPrompt = await fetchPersonaPrompt(config.persona);
    const composed = composeSystemPrompt(personaPrompt, config.scenario);
    config.systemPrompt = composed;
    systemPromptTextarea.value = composed;
}

function updateConfigFromSelect(selectId, value) {
    switch (selectId) {
        case 'aws-region':
            config.awsRegion = value;
            break;
        case 'voice-type':
            config.voiceId = value;
            break;
        case 'response-timing':
            config.responseTiming = value;
            break;
        case 'output-sample-rate':
            config.outputSampleRate = parseInt(value, 10);
            break;
        case 'prompt-preset':
            config.persona = value;
            applyPersonaScenarioToTextarea();
            break;
        case 'scenario':
            config.scenario = value;
            applyPersonaScenarioToTextarea();
            if (typeof resetScenarioProgress === 'function') resetScenarioProgress();
            if (typeof refreshScenarioCard === 'function') refreshScenarioCard();
            break;
        case 'language':
            config.language = value;
            // Reload persona for the newly-chosen language
            applyPersonaScenarioToTextarea();
            // Re-render profile (per-language)
            if (typeof renderProfileBlock === 'function') renderProfileBlock();
            break;
        case 'corrections-level':
            config.correctionsLevel = value;
            break;
    }
}

function setCustomSelectValue(selectId, value) {
    const select = document.querySelector(`.custom-select[data-id="${selectId}"]`);
    if (!select) return;

    const options = select.querySelectorAll('.custom-select-option');
    const valueDisplay = select.querySelector('.custom-select-value');

    options.forEach(option => {
        if (option.dataset.value === value) {
            options.forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            // Clone content for voice-type to preserve icons safely
            if (selectId === 'voice-type') {
                valueDisplay.textContent = '';
                Array.from(option.childNodes).forEach(node => {
                    valueDisplay.appendChild(node.cloneNode(true));
                });
            } else {
                // For options with descriptions, only show the label
                const label = option.querySelector('.option-label');
                valueDisplay.textContent = label ? label.textContent.trim() : option.textContent.trim();
            }
            select.dataset.value = value;
        }
    });
}

// Initialize settings UI
async function initSettings() {
    // Load saved config from localStorage
    const savedConfig = localStorage.getItem('novaSonicConfig');
    if (savedConfig) {
        config = { ...config, ...JSON.parse(savedConfig) };
    }

    // Migrate old configs to current schema
    const validLanguages = ['de', 'pt', 'es', 'it', 'fr', 'ru', 'tr'];
    if (!validLanguages.includes(config.language)) {
        config.language = 'de';
    }
    const validPersonas = ['a1', 'a2', 'b1', 'b2', 'c1', 'default', 'custom'];
    if (!validPersonas.includes(config.persona)) {
        config.persona = 'a1';
    }
    if (!Object.keys(SCENARIOS).includes(config.scenario)) {
        config.scenario = 'none';
    }

    // Always rebuild the system prompt from persona + scenario unless persona is custom
    if (config.persona !== 'custom') {
        const personaPrompt = await fetchPersonaPrompt(config.persona);
        config.systemPrompt = composeSystemPrompt(personaPrompt, config.scenario);
    }

    // Initialize custom dropdowns
    initCustomSelects();

    // Apply config to UI
    applyConfigToUI();

    // Settings panel toggle
    settingsToggle.addEventListener('click', () => {
        settingsPanel.classList.add('open');
        settingsOverlay.classList.add('open');
    });

    const closeSettings = () => {
        settingsPanel.classList.remove('open');
        settingsOverlay.classList.remove('open');
        saveConfig();
    };

    settingsClose.addEventListener('click', closeSettings);
    settingsOverlay.addEventListener('click', closeSettings);

    // Slider sync
    setupSliderSync(temperatureSlider, temperatureValue, 'temperature');
    setupSliderSync(topPSlider, topPValue, 'topP');
    setupSliderSync(maxTokensSlider, maxTokensValue, 'maxTokens');
    setupSliderSync(audioBufferSlider, audioBufferValue, 'audioBufferMs', (value) => {
        // Update the AudioPlayer's initial buffer when changed
        if (audioPlayer.initialized) {
            audioPlayer.setInitialBufferMs(value);
        }
    });

    // Textarea handler - switch to Custom when user edits
    systemPromptTextarea.addEventListener('input', (e) => {
        config.systemPrompt = e.target.value;
        config.persona = 'custom';
        setCustomSelectValue('prompt-preset', 'custom');
    });
    
    // Load available tools
    loadAvailableTools();

    // Wire up new toggle controls (corrections, bot-greets-first, ambient)
    const showCorrChk = document.getElementById('corrections-show');
    if (showCorrChk) {
        showCorrChk.checked = config.correctionsShow !== false;
        showCorrChk.addEventListener('change', e => { config.correctionsShow = e.target.checked; saveConfig(); });
    }
    const spokenCorrChk = document.getElementById('corrections-spoken');
    if (spokenCorrChk) {
        spokenCorrChk.checked = !!config.correctionsSpoken;
        spokenCorrChk.addEventListener('change', e => { config.correctionsSpoken = e.target.checked; applyPersonaScenarioToTextarea(); saveConfig(); });
    }
    const greetChk = document.getElementById('bot-greets-first');
    if (greetChk) {
        greetChk.checked = !!config.botGreetsFirst;
        greetChk.addEventListener('change', e => { config.botGreetsFirst = e.target.checked; saveConfig(); });
    }
    const ambientChk = document.getElementById('ambient-enabled');
    if (ambientChk) {
        ambientChk.checked = config.ambientEnabled !== false;
        ambientChk.addEventListener('change', e => { config.ambientEnabled = e.target.checked; saveConfig(); });
    }

    // Render learner profile block
    renderProfileBlock();

    // Wire up the region latency probe + refresh button
    const refreshBtn = document.getElementById('region-latency-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => loadRegionLatencies({ refresh: true }));
    }
    // Run latency probe on app load. The default region is always the lowest-latency
    // one — manual selections only stick until the next measurement.
    loadRegionLatencies({ refresh: false });
}

// Pretty labels for the AWS regions we ship in consts.ts
const REGION_LABELS = {
    'ap-northeast-1': 'Asia Pacific (Tokyo)',
    'us-east-1': 'US East (N. Virginia)',
    'us-west-2': 'US West (Oregon)',
    'eu-north-1': 'Europe (Stockholm)',
    'eu-central-1': 'Europe (Frankfurt)',
};

function formatRegionLabel(region, latencyMs, error) {
    const name = REGION_LABELS[region] || region;
    if (error) return `${name} — unreachable`;
    if (latencyMs == null) return `${name} — measuring…`;
    return `${name} — ${latencyMs} ms`;
}

async function loadRegionLatencies({ refresh = false } = {}) {
    const select = document.querySelector('.custom-select[data-id="aws-region"]');
    const optionsContainer = select?.querySelector('.custom-select-options');
    const refreshBtn = document.getElementById('region-latency-refresh');
    if (!select || !optionsContainer) return;

    refreshBtn?.classList.add('measuring');
    const labelSpan = refreshBtn?.querySelector('.latency-refresh-label');
    const prevLabel = labelSpan?.textContent;
    if (labelSpan) labelSpan.textContent = 'Measuring…';

    try {
        const res = await fetch(`/api/region-latency${refresh ? '?refresh=1' : ''}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const sorted = [...(data.results || [])].sort((a, b) => {
            if (a.latencyMs == null) return 1;
            if (b.latencyMs == null) return -1;
            return a.latencyMs - b.latencyMs;
        });

        optionsContainer.textContent = '';
        sorted.forEach(({ region, latencyMs, error }) => {
            const opt = document.createElement('div');
            opt.className = 'custom-select-option';
            opt.dataset.value = region;
            if (region === config.awsRegion) opt.classList.add('selected');
            opt.textContent = formatRegionLabel(region, latencyMs, error);
            optionsContainer.appendChild(opt);
        });

        // Re-bind option click handlers — they were attached at boot but options didn't exist yet
        bindCustomSelectOptions(select);

        // Always default to the lowest-latency region. Manual mid-session overrides still work,
        // but each refresh resets the selection to whatever is fastest right now.
        const fastest = sorted.find(r => r.latencyMs != null);
        if (fastest && fastest.region !== config.awsRegion) {
            config.awsRegion = fastest.region;
            saveConfig();
        }
        setCustomSelectValue('aws-region', config.awsRegion);
    } catch (error) {
        console.error('Failed to load region latencies:', error);
    } finally {
        refreshBtn?.classList.remove('measuring');
        if (labelSpan && prevLabel) labelSpan.textContent = prevLabel;
    }
}

function bindCustomSelectOptions(select) {
    const options = select.querySelectorAll('.custom-select-option');
    const valueDisplay = select.querySelector('.custom-select-value');
    const selectId = select.dataset.id;
    const settingItem = select.closest('.setting-item') || select.closest('.settings-section') || select.closest('.accordion-content');
    options.forEach(option => {
        if (option.dataset.bound === 'true') return;
        option.dataset.bound = 'true';
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const value = option.dataset.value;
            options.forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            valueDisplay.textContent = option.textContent.trim();
            select.dataset.value = value;
            select.classList.remove('open');
            if (settingItem) settingItem.style.zIndex = '';
            updateConfigFromSelect(selectId, value);
        });
    });
}

function setupSliderSync(slider, input, configKey, onChange = null) {
    slider.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        input.value = value;
        config[configKey] = value;
        updateSliderTrack(slider);
        if (onChange) onChange(value);
    });

    input.addEventListener('change', (e) => {
        let value = parseFloat(e.target.value);
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        value = Math.max(min, Math.min(max, value));
        e.target.value = value;
        slider.value = value;
        config[configKey] = value;
        updateSliderTrack(slider);
        if (onChange) onChange(value);
    });

    updateSliderTrack(slider);
}

function updateSliderTrack(slider) {
    const percent = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.background = `linear-gradient(to right, var(--primary) ${percent}%, var(--bg-input) ${percent}%)`;
}

function applyConfigToUI() {
    // Custom dropdowns
    setCustomSelectValue('aws-region', config.awsRegion);
    setCustomSelectValue('voice-type', config.voiceId);
    setCustomSelectValue('response-timing', config.responseTiming);
    setCustomSelectValue('output-sample-rate', String(config.outputSampleRate));
    setCustomSelectValue('prompt-preset', config.persona);
    setCustomSelectValue('scenario', config.scenario);
    setCustomSelectValue('language', config.language || 'de');
    setCustomSelectValue('corrections-level', config.correctionsLevel || 'all');

    // Textarea
    systemPromptTextarea.value = config.systemPrompt;

    // Sliders
    temperatureSlider.value = config.temperature;
    temperatureValue.value = config.temperature;
    topPSlider.value = config.topP;
    topPValue.value = config.topP;
    maxTokensSlider.value = config.maxTokens;
    maxTokensValue.value = config.maxTokens;
    audioBufferSlider.value = config.audioBufferMs;
    audioBufferValue.value = config.audioBufferMs;

    // Update slider tracks
    updateSliderTrack(temperatureSlider);
    updateSliderTrack(topPSlider);
    updateSliderTrack(maxTokensSlider);
    updateSliderTrack(audioBufferSlider);
}

function saveConfig() {
    localStorage.setItem('novaSonicConfig', JSON.stringify(config));
}

// Tools management
async function loadAvailableTools() {
    const toolsList = document.getElementById('tools-list');
    try {
        const response = await fetch('/api/tools');
        if (!response.ok) throw new Error('Failed to fetch tools');
        
        const data = await response.json();
        availableTools = data.tools || [];
        
        // If enabledTools is empty (first load), enable all tools by default
        if (config.enabledTools.length === 0) {
            config.enabledTools = availableTools.map(t => t.name);
            saveConfig();
        }
        
        renderToolsList();
    } catch (error) {
        console.error('Failed to load tools:', error);
        toolsList.innerHTML = '<div class="tools-loading">Failed to load tools</div>';
    }
}

function truncateDescription(desc, maxLen = 60) {
    if (!desc) return '';
    // Find first sentence (up to ". ")
    const sentenceEnd = desc.indexOf('. ');
    if (sentenceEnd > 0 && sentenceEnd < maxLen) {
        return desc.substring(0, sentenceEnd + 1);
    }
    // Otherwise truncate at maxLen
    if (desc.length <= maxLen) return desc;
    return desc.substring(0, maxLen).trim() + '…';
}

function renderToolsList() {
    const toolsList = document.getElementById('tools-list');
    if (!toolsList || availableTools.length === 0) {
        toolsList.textContent = '';
        const noToolsDiv = document.createElement('div');
        noToolsDiv.className = 'tools-loading';
        noToolsDiv.textContent = 'No tools available';
        toolsList.appendChild(noToolsDiv);
        return;
    }
    
    toolsList.textContent = '';
    availableTools.forEach(tool => {
        const item = document.createElement('div');
        item.className = 'tool-toggle-item';
        item.dataset.tool = tool.name;
        
        const label = document.createElement('label');
        label.className = 'tool-checkbox';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = config.enabledTools.includes(tool.name);
        checkbox.dataset.toolName = tool.name;
        
        const checkmark = document.createElement('span');
        checkmark.className = 'checkmark';
        
        label.appendChild(checkbox);
        label.appendChild(checkmark);
        
        const toolInfo = document.createElement('div');
        toolInfo.className = 'tool-info';
        
        const toolName = document.createElement('div');
        toolName.className = 'tool-info-name';
        toolName.textContent = tool.name;
        
        const toolDesc = document.createElement('div');
        toolDesc.className = 'tool-info-description';
        toolDesc.textContent = truncateDescription(tool.description);
        
        toolInfo.appendChild(toolName);
        toolInfo.appendChild(toolDesc);
        
        item.appendChild(label);
        item.appendChild(toolInfo);
        toolsList.appendChild(item);
        
        checkbox.addEventListener('change', (e) => {
            const name = e.target.dataset.toolName;
            if (e.target.checked) {
                if (!config.enabledTools.includes(name)) {
                    config.enabledTools.push(name);
                }
            } else {
                config.enabledTools = config.enabledTools.filter(t => t !== name);
            }
            saveConfig();
        });
    });
}

function setToolsDisabled(disabled) {
    const toolsList = document.getElementById('tools-list');
    if (!toolsList) return;
    
    toolsList.querySelectorAll('.tool-toggle-item').forEach(item => {
        item.classList.toggle('disabled', disabled);
    });
    toolsList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
        checkbox.disabled = disabled;
    });
}

// Theme toggle
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    isDarkMode = savedTheme === 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    themeToggle.addEventListener('click', () => {
        isDarkMode = !isDarkMode;
        const theme = isDarkMode ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    });
}

// Waveform Animation - Full-width vibrating single line
function initWaveformCanvas() {
    const dpr = window.devicePixelRatio || 1;
    
    // Main waveform canvas (full width)
    const rect = waveformCanvas.getBoundingClientRect();
    waveformCanvas.width = rect.width * dpr;
    waveformCanvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    
    // Ring canvas (around button) - use fixed size matching CSS
    const ringSize = 200;
    ringCanvas.width = ringSize * dpr;
    ringCanvas.height = ringSize * dpr;
    ringCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
    ringCtx.scale(dpr, dpr);
}

function startWaveformAnimation() {
    if (isAnimating) return;
    isAnimating = true;
    animateWaveform();
}

function stopWaveformAnimation() {
    isAnimating = false;
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    // Clear audio fade timer
    if (audioFadeTimer) {
        clearTimeout(audioFadeTimer);
        audioFadeTimer = null;
    }
    // Reset audio levels and duration tracking
    targetAudioLevel = 0;
    targetAssistantAudioLevel = 0;
    audioLevel = 0;
    assistantAudioLevel = 0;
    speechStartTime = 0;
    totalAudioDuration = 0;
    ringFadeAlpha = 0;
    isRingFadingOut = false;
    const rect = waveformCanvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ringCtx.clearRect(0, 0, 200, 200);
}

function animateWaveform() {
    if (!isAnimating) return;

    const rect = waveformCanvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const centerY = height / 2;
    const time = Date.now() * 0.004;

    ctx.clearRect(0, 0, width, height);

    // Smooth audio level transitions
    audioLevel += (targetAudioLevel - audioLevel) * 0.18;
    // Slower smoothing for assistant level to allow visible fade out
    // Only keep level high while actively receiving audio chunks (not during/after fade)
    const isActivelyReceivingAudio = speechStartTime > 0 && !isRingFadingOut && ringFadeAlpha === 1;
    const effectiveTargetAssistantLevel = isActivelyReceivingAudio ? Math.max(targetAssistantAudioLevel, 0.5) : targetAssistantAudioLevel;
    const assistantSmoothing = effectiveTargetAssistantLevel < assistantAudioLevel ? 0.03 : 0.15;
    assistantAudioLevel += (effectiveTargetAssistantLevel - assistantAudioLevel) * assistantSmoothing;
    
    // Horizontal waveform responds only to user's microphone
    const userLevel = audioLevel;
    
    // Base amplitude - nearly flat when idle, energetic when speaking
    const baseAmplitude = 1 + userLevel * 59;
    
    // Vibration intensity - almost completely still when idle
    const vibrationIntensity = 0.005 + userLevel * 0.995;

    // Draw single vibrating line with heavy glow (user mic only)
    drawSingleGlowingWave(ctx, width, centerY, baseAmplitude, time, userLevel, vibrationIntensity);
    
    // Draw circular waveform around button for assistant audio only (on separate canvas)
    const ringSize = 200;
    ringCtx.clearRect(0, 0, ringSize, ringSize);
    
    // Update ring fade alpha
    if (assistantAudioLevel > 0.02 && !isRingFadingOut) {
        ringFadeAlpha = 1;
    } else if (isRingFadingOut && ringFadeAlpha > 0) {
        ringFadeAlpha -= 0.02; // Fade out over ~50 frames (~800ms at 60fps)
        if (ringFadeAlpha <= 0) {
            ringFadeAlpha = 0;
            isRingFadingOut = false;
            // Force reset audio levels to prevent re-triggering
            assistantAudioLevel = 0;
            targetAssistantAudioLevel = 0;
        }
    }
    
    // Draw ring only when there's actual assistant audio
    if (ringFadeAlpha > 0 && (assistantAudioLevel > 0.02 || isRingFadingOut)) {
        const ringCenterX = ringSize / 2;
        const ringCenterY = ringSize / 2;
        // Keep vibration active during fade out - use last known level or minimum active level
        const displayLevel = isRingFadingOut ? Math.max(0.4, assistantAudioLevel) : assistantAudioLevel;
        drawAssistantCircularWave(ringCtx, ringCenterX, ringCenterY, time, displayLevel, ringFadeAlpha);
    }

    animationId = requestAnimationFrame(animateWaveform);
}

function drawSingleGlowingWave(ctx, width, centerY, amplitude, time, level, vibrationIntensity) {
    const freq = 0.012;
    const phase = time * 4;

    // Build the wave path
    ctx.beginPath();
    ctx.moveTo(0, centerY);

    for (let x = 0; x <= width; x += 1) {
        // Main wave components - faster and more dynamic
        const wave1 = Math.sin(x * freq + phase) * amplitude;
        const wave2 = Math.sin(x * freq * 2.3 + phase * 2.5) * amplitude * 0.6;
        const wave3 = Math.sin(x * freq * 0.7 + phase * 1.2) * amplitude * 0.5;
        
        // High-frequency vibration - cranked up
        const vibration = Math.sin(x * 0.1 + time * 25) * amplitude * 0.45 * vibrationIntensity;
        const microVibration = Math.sin(x * 0.25 + time * 45) * amplitude * 0.35 * vibrationIntensity;
        
        // Heavy bounce effects - makes it jump aggressively
        const bounce = Math.sin(time * 35) * amplitude * 0.4 * vibrationIntensity;
        const bounce2 = Math.cos(time * 28) * amplitude * 0.3 * vibrationIntensity;
        const rapidPulse = Math.sin(time * 60 + x * 0.03) * amplitude * 0.25 * vibrationIntensity;
        
        // Maximum chaos - erratic movement
        const jitter = (Math.sin(x * 0.4 + time * 50) * Math.cos(x * 0.22 + time * 35)) * amplitude * 0.4 * level;
        const chaos = Math.sin(x * 0.6 + time * 70) * amplitude * 0.2 * level;
        const chaos2 = Math.cos(x * 0.35 + time * 55) * Math.sin(time * 80) * amplitude * 0.25 * level;
        const spikes = Math.sin(x * 0.8 + time * 90) * amplitude * 0.15 * vibrationIntensity;
        
        const y = centerY + wave1 + wave2 + wave3 + vibration + microVibration + bounce + bounce2 + rapidPulse + jitter + chaos + chaos2 + spikes;
        ctx.lineTo(x, y);
    }

    // Rotating hue for rainbow effect
    hueRotation = (hueRotation + 0.5) % 360;
    const hue1 = hueRotation;
    const hue2 = (hueRotation + 60) % 360;
    const hue3 = (hueRotation + 180) % 360;

    // Create rainbow gradient
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    const alpha = 0.7 + level * 0.3;
    gradient.addColorStop(0, `hsla(${hue1}, 100%, 60%, ${alpha})`);
    gradient.addColorStop(0.33, `hsla(${hue2}, 100%, 65%, ${alpha})`);
    gradient.addColorStop(0.66, `hsla(${hue3}, 100%, 60%, ${alpha})`);
    gradient.addColorStop(1, `hsla(${(hue1 + 300) % 360}, 100%, 65%, ${alpha})`);

    // Heavy glow effect - multiple layers
    ctx.save();
    
    // Outer glow
    ctx.shadowColor = `hsla(${hue2}, 100%, 60%, ${0.4 + level * 0.4})`;
    ctx.shadowBlur = 25 + level * 40;
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2 + level * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    
    // Middle glow layer
    ctx.shadowColor = `hsla(${hue1}, 100%, 70%, ${0.5 + level * 0.3})`;
    ctx.shadowBlur = 15 + level * 25;
    ctx.stroke();
    
    // Inner bright core
    ctx.shadowColor = `hsla(${hue3}, 100%, 80%, ${0.6 + level * 0.4})`;
    ctx.shadowBlur = 8 + level * 15;
    ctx.lineWidth = 1.5 + level * 1.5;
    ctx.stroke();
    
    ctx.restore();
}

function drawAssistantCircularWave(context, centerX, centerY, time, level, fadeAlpha = 1) {
    const buttonRadius = 50;
    const ringRadius = buttonRadius + 12 + level * 15;
    
    // Blue hue (220) when idle, rotating rainbow when active
    const baseHue = 220; // Blue
    const hue = level > 0.1 ? (time * 50) % 360 : baseHue;
    const alpha = (0.6 + level * 0.4) * fadeAlpha;
    
    // Draw full outer circle ring with vibrating thickness
    const segments = 120;
    
    // Create gradient around the circle
    context.beginPath();
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        
        // More reactive vibration based on audio level
        const vibration = Math.sin(angle * 8 + time * 12) * 8 * level;
        const microVibration = Math.sin(angle * 16 + time * 20) * 5 * level;
        const pulse = Math.sin(time * 5) * 6 * level;
        const jitter = Math.sin(angle * 24 + time * 30) * 3 * level;
        const r = ringRadius + vibration + microVibration + pulse + jitter;
        
        const x = centerX + Math.cos(angle) * r;
        const y = centerY + Math.sin(angle) * r;
        
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
    }
    context.closePath();
    
    // Multi-layer glow effect
    context.save();
    
    // Outer glow
    context.shadowColor = `hsla(${hue}, 100%, 60%, ${alpha * 0.8})`;
    context.shadowBlur = 30 + level * 50;
    context.strokeStyle = `hsla(${hue}, 100%, 65%, ${alpha})`;
    context.lineWidth = 2 + level * 3;
    context.stroke();
    
    // Middle glow with shifted color (only shift when active)
    const hue2 = level > 0.1 ? (hue + 60) % 360 : baseHue;
    context.shadowColor = `hsla(${hue2}, 100%, 60%, ${alpha * 0.6})`;
    context.shadowBlur = 20 + level * 35;
    context.stroke();
    
    // Inner bright core
    const hue3 = level > 0.1 ? (hue + 120) % 360 : baseHue;
    context.shadowColor = `hsla(${hue3}, 100%, 70%, ${alpha * 0.7})`;
    context.shadowBlur = 10 + level * 20;
    context.lineWidth = 1 + level * 2;
    context.stroke();
    
    context.restore();
}

function updateAudioLevel(level) {
    targetAudioLevel = Math.min(1, level * 3);
}

function updateAssistantAudioLevel(level) {
    targetAssistantAudioLevel = Math.min(1, level * 3);
}

// Initialize WebSocket audio
async function initAudio() {
    try {
        // Request microphone access
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: { ideal: true },
                noiseSuppression: { ideal: true },
                autoGainControl: { ideal: true },
                googEchoCancellation: { ideal: true },
                googAutoGainControl: { ideal: true },
                googNoiseSuppression: { ideal: true },
                googHighpassFilter: { ideal: true }
            }
        });

        // Create audio context if needed
        if (!audioContext || audioContext.state === 'closed') {
            if (isFirefox) {
                audioContext = new AudioContext();
            } else {
                audioContext = new AudioContext({
                    sampleRate: TARGET_SAMPLE_RATE
                });
            }
        }

        samplingRatio = audioContext.sampleRate / TARGET_SAMPLE_RATE;
        await audioPlayer.start(config.outputSampleRate, config.audioBufferMs);
    } catch (error) {
        console.error("Error accessing microphone:", error);
        throw error;
    }
}

// Map response timing to AWS endpointingSensitivity
const responseTimingToSensitivity = {
    fast: 'HIGH',
    medium: 'MEDIUM',
    slow: 'LOW'
};

// Initialize the session with Bedrock
async function initializeSession() {
    if (sessionInitialized) return;

    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);

            socket.emit('initializeConnection', {
                region: config.awsRegion,
                inferenceConfig: {
                    maxTokens: config.maxTokens,
                    temperature: config.temperature,
                    topP: config.topP
                },
                turnDetectionConfig: {
                    endpointingSensitivity: responseTimingToSensitivity[config.responseTiming] || 'MEDIUM'
                },
                enabledTools: config.enabledTools
            }, (ack) => {
                clearTimeout(timeout);
                if (ack?.success) resolve();
                else reject(new Error(ack?.error || 'Connection failed'));
            });
        });

        // Update audio player sample rate BEFORE starting audio stream
        await audioPlayer.setSampleRate(config.outputSampleRate);

        socket.emit('promptStart', { 
            voiceId: config.voiceId,
            outputSampleRate: config.outputSampleRate 
        });
        
        socket.emit('systemPrompt', {
            content: config.systemPrompt,
            voiceId: config.voiceId
        });
        socket.emit('audioStart');

        // If "Bot greets first" is on, seed the conversation once audio is ready
        if (config.botGreetsFirst) {
            socket.once('audioReady', () => {
                const seed = greetingSeedForCurrentConfig();
                socket.emit('textInput', { content: seed });
                if (window.showAssistantThinkingIndicator) window.showAssistantThinkingIndicator();
            });
        }

        sessionInitialized = true;
        startSessionTimers(); // Start session timeout tracking
    } catch (error) {
        console.error("Failed to initialize session:", error);
        throw error;
    }
}

async function startStreaming() {
    if (isStreaming) return;

    try {
        // Clear chat history on new conversation start
        chatHistoryManager.clearHistory();
        clearChatUI();

        if (!socket.connected) {
            socket.connect();
            await new Promise((resolve) => {
                if (socket.connected) resolve();
                else socket.once('connect', resolve);
            });
        }

        // Re-initialize audio if microphone was released
        if (!audioStream || !audioContext || audioContext.state === 'closed') {
            await initAudio();
        }

        if (!audioPlayer.initialized) {
            await audioPlayer.start(config.outputSampleRate, config.audioBufferMs);
        }

        if (!sessionInitialized) {
            await initializeSession();
        }

        sourceNode = audioContext.createMediaStreamSource(audioStream);

        if (audioContext.createScriptProcessor) {
            processor = audioContext.createScriptProcessor(512, 1, 1);

            processor.onaudioprocess = (e) => {
                if (!isStreaming) return;

                const inputData = e.inputBuffer.getChannelData(0);
                const numSamples = Math.round(inputData.length / samplingRatio);
                const pcmData = isFirefox ? (new Int16Array(numSamples)) : (new Int16Array(inputData.length));

                // Calculate audio level for visualization
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) {
                    sum += inputData[i] * inputData[i];
                }
                const rms = Math.sqrt(sum / inputData.length);
                updateAudioLevel(rms);

                if (isFirefox) {
                    for (let i = 0; i < numSamples; i++) {
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[Math.floor(i * samplingRatio)])) * 0x7FFF;
                    }
                } else {
                    for (let i = 0; i < inputData.length; i++) {
                        pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                    }
                }

                const base64Data = arrayBufferToBase64(pcmData.buffer);
                socket.emit('audioInput', base64Data);
            };

            sourceNode.connect(processor);
            processor.connect(audioContext.destination);
        }

        isStreaming = true;
        voiceBtn.classList.add('active');
        micIcon.classList.add('hidden');
        stopIcon.classList.remove('hidden');
        voiceHint.textContent = 'Tap to stop';

        // Start scenario ambient audio if enabled and the scenario has a recipe
        if (config.ambientEnabled !== false) {
            try { scenarioAmbience.start(config.scenario); } catch (e) { console.warn('Ambient start failed:', e); }
        }
        
        // Disable settings during conversation
        setSettingsDisabled(true);

        // Start waveform animation
        initWaveformCanvas();
        startWaveformAnimation();

        transcriptionReceived = false;

    } catch (error) {
        console.error("Error starting recording:", error);
    }
}

function arrayBufferToBase64(buffer) {
    const binary = [];
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary.push(String.fromCharCode(bytes[i]));
    }
    return btoa(binary.join(''));
}

function stopStreaming() {
    if (!isStreaming) return;

    isStreaming = false;
    clearSessionTimers(); // Clear session timeout timers
    hideSessionWarning();

    if (processor) {
        processor.disconnect();
        sourceNode.disconnect();
        processor = null;
        sourceNode = null;
    }

    // Release the microphone by stopping all tracks
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }

    // Close the audio context
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
        audioContext = null;
    }

    voiceBtn.classList.remove('active');
    micIcon.classList.remove('hidden');
    stopIcon.classList.add('hidden');
    voiceHint.textContent = 'Tap to start conversation';

    // Stop scenario ambient
    try { scenarioAmbience.stop(); } catch {}

    // Stop waveform animation
    stopWaveformAnimation();

    audioPlayer.bargeIn();
    socket.emit('stopAudio');
    chatHistoryManager.endTurn();

    sessionInitialized = false;
    manualDisconnect = true;
    socket.disconnect();

    // Re-enable settings after conversation ends
    setSettingsDisabled(false);

    // Generate end-of-session summary + update learner profile
    requestSessionSummary();
}

function base64ToFloat32Array(base64String) {
    try {
        const binaryString = window.atob(base64String);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        return float32Array;
    } catch (error) {
        console.error('Error in base64ToFloat32Array:', error);
        throw error;
    }
}

function handleTextOutput(data) {
    if (data.content) {
        const messageData = {
            role: data.role,
            message: data.content
        };
        chatHistoryManager.addTextMessage(messageData);
    }
}

function createNovaIcon() {
    const img = document.createElement('img');
    img.src = '/nova-icon.png';
    img.alt = 'Nova';
    img.className = 'nova-icon';
    return img;
}

// Track rendered message count to avoid re-rendering
let renderedMessageCount = 0;

function createMessageElement(item) {
    if (item.endOfConversation) {
        const endDiv = document.createElement('div');
        endDiv.className = 'message system';
        endDiv.textContent = "Conversation ended";
        return endDiv;
    }

    // Handle tool usage cards
    if (item.type === 'tool') {
        return createToolCard(item);
    }

    if (item.role) {
        const messageDiv = document.createElement('div');
        const roleLowerCase = item.role.toLowerCase();
        messageDiv.className = `message ${roleLowerCase}`;

        // Add Nova icon for assistant messages
        if (roleLowerCase === 'assistant') {
            const iconWrapper = document.createElement('div');
            iconWrapper.className = 'message-icon';
            iconWrapper.appendChild(createNovaIcon());
            messageDiv.appendChild(iconWrapper);
        }

        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = item.message || "";
        
        // Add interrupted indicator for assistant messages
        if (roleLowerCase === 'assistant' && item.interrupted) {
            const interruptedSpan = document.createElement('div');
            interruptedSpan.className = 'interrupted-indicator';
            interruptedSpan.textContent = '(interrupted)';
            content.appendChild(interruptedSpan);
        }
        
        messageDiv.appendChild(content);

        return messageDiv;
    }
    return null;
}

function createToolCard(item) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolUseId = item.toolUseId;

    // Header (clickable to expand/collapse)
    const header = document.createElement('div');
    header.className = 'tool-header';
    
    // Tool icon (wrench/gear)
    const toolIconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    toolIconSvg.setAttribute('class', 'tool-icon');
    toolIconSvg.setAttribute('viewBox', '0 0 24 24');
    toolIconSvg.setAttribute('fill', 'none');
    toolIconSvg.setAttribute('stroke', 'currentColor');
    toolIconSvg.setAttribute('stroke-width', '2');
    const toolIconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    toolIconPath.setAttribute('d', 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z');
    toolIconSvg.appendChild(toolIconPath);
    header.appendChild(toolIconSvg);

    const toolName = document.createElement('span');
    toolName.className = 'tool-name';
    toolName.textContent = formatToolName(item.toolName);
    header.appendChild(toolName);

    // Status indicator
    const status = document.createElement('div');
    status.className = `tool-status ${item.status}`;
    
    if (item.status === 'running') {
        const spinner = document.createElement('div');
        spinner.className = 'tool-spinner';
        const runningText = document.createElement('span');
        runningText.textContent = 'Running';
        status.appendChild(spinner);
        status.appendChild(runningText);
    } else {
        const elapsed = item.elapsed ? formatElapsed(item.elapsed) : '';
        const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        checkSvg.setAttribute('class', 'tool-check');
        checkSvg.setAttribute('viewBox', '0 0 24 24');
        checkSvg.setAttribute('fill', 'none');
        checkSvg.setAttribute('stroke', 'currentColor');
        checkSvg.setAttribute('stroke-width', '2');
        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', '20 6 9 17 4 12');
        checkSvg.appendChild(polyline);
        const elapsedSpan = document.createElement('span');
        elapsedSpan.className = 'tool-elapsed';
        elapsedSpan.textContent = elapsed;
        status.appendChild(checkSvg);
        status.appendChild(elapsedSpan);
    }
    header.appendChild(status);

    // Expand icon
    const expandSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    expandSvg.setAttribute('class', 'tool-expand-icon');
    expandSvg.setAttribute('viewBox', '0 0 24 24');
    expandSvg.setAttribute('fill', 'none');
    expandSvg.setAttribute('stroke', 'currentColor');
    expandSvg.setAttribute('stroke-width', '2');
    const expandPolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    expandPolyline.setAttribute('points', '6 9 12 15 18 9');
    expandSvg.appendChild(expandPolyline);
    header.appendChild(expandSvg);

    card.appendChild(header);

    // Details section (collapsible)
    const details = document.createElement('div');
    details.className = 'tool-details';

    // Input section
    const inputSection = document.createElement('div');
    inputSection.className = 'tool-section';
    const inputLabel = document.createElement('div');
    inputLabel.className = 'tool-section-label';
    inputLabel.textContent = 'Input';
    const inputContent = document.createElement('div');
    inputContent.className = 'tool-section-content';
    inputContent.textContent = formatToolData(item.input);
    inputSection.appendChild(inputLabel);
    inputSection.appendChild(inputContent);
    details.appendChild(inputSection);

    // Output section (only if completed)
    if (item.status === 'completed' && item.output !== undefined) {
        const outputSection = document.createElement('div');
        outputSection.className = 'tool-section';
        const outputLabel = document.createElement('div');
        outputLabel.className = 'tool-section-label';
        outputLabel.textContent = 'Output';
        const outputContent = document.createElement('div');
        outputContent.className = 'tool-section-content';
        outputContent.textContent = formatToolData(item.output);
        outputSection.appendChild(outputLabel);
        outputSection.appendChild(outputContent);
        details.appendChild(outputSection);
    }

    card.appendChild(details);

    // Toggle expand on header click
    header.addEventListener('click', () => {
        card.classList.toggle('expanded');
    });

    return card;
}

function formatToolName(name) {
    // Convert camelCase or snake_case to readable format
    return name
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .replace(/^./, str => str.toUpperCase())
        .trim();
}

function formatElapsed(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatToolData(data) {
    if (data === null || data === undefined) return 'null';
    if (typeof data === 'string') {
        try {
            const parsed = JSON.parse(data);
            return JSON.stringify(parsed, null, 2);
        } catch {
            return data;
        }
    }
    return JSON.stringify(data, null, 2);
}

// Floating tool card that stays at the bottom during streaming
let floatingToolCards = new Map(); // Map of toolUseId -> card element

function showToolCard(toolData) {
    // Don't create duplicate cards
    if (floatingToolCards.has(toolData.toolUseId)) {
        return;
    }
    
    const card = createToolCard(toolData);
    card.dataset.toolUseId = toolData.toolUseId;
    floatingToolCards.set(toolData.toolUseId, card);
    chatContainer.appendChild(card);
    scrollToBottom();
}

function updateToolCardById(toolUseId, toolData) {
    const card = floatingToolCards.get(toolUseId);
    if (!card) return;
    
    // Check if this is an error result
    const isError = toolData.output?.error === true;
    
    // Update status indicator
    const status = card.querySelector('.tool-status');
    if (status && !card.dataset.completed) {
        const elapsed = toolData.elapsed ? formatElapsed(toolData.elapsed) : '';
        
        status.textContent = '';
        
        if (isError) {
            status.className = 'tool-status error';
            const errorSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            errorSvg.setAttribute('class', 'tool-error');
            errorSvg.setAttribute('viewBox', '0 0 24 24');
            errorSvg.setAttribute('fill', 'none');
            errorSvg.setAttribute('stroke', 'currentColor');
            errorSvg.setAttribute('stroke-width', '2');
            const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line1.setAttribute('x1', '18'); line1.setAttribute('y1', '6');
            line1.setAttribute('x2', '6'); line1.setAttribute('y2', '18');
            const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line2.setAttribute('x1', '6'); line2.setAttribute('y1', '6');
            line2.setAttribute('x2', '18'); line2.setAttribute('y2', '18');
            errorSvg.appendChild(line1);
            errorSvg.appendChild(line2);
            const elapsedSpan = document.createElement('span');
            elapsedSpan.className = 'tool-elapsed';
            elapsedSpan.textContent = elapsed;
            status.appendChild(errorSvg);
            status.appendChild(elapsedSpan);
        } else {
            status.className = 'tool-status completed';
            const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            checkSvg.setAttribute('class', 'tool-check');
            checkSvg.setAttribute('viewBox', '0 0 24 24');
            checkSvg.setAttribute('fill', 'none');
            checkSvg.setAttribute('stroke', 'currentColor');
            checkSvg.setAttribute('stroke-width', '2');
            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', '20 6 9 17 4 12');
            checkSvg.appendChild(polyline);
            const elapsedSpan = document.createElement('span');
            elapsedSpan.className = 'tool-elapsed';
            elapsedSpan.textContent = elapsed;
            status.appendChild(checkSvg);
            status.appendChild(elapsedSpan);
        }
        card.dataset.completed = 'true';
    }
    
    // Add output section only once
    const details = card.querySelector('.tool-details');
    if (details && toolData.output !== undefined && !card.dataset.hasOutput) {
        const outputSection = document.createElement('div');
        outputSection.className = 'tool-section' + (isError ? ' tool-error-output' : '');
        const outputLabelText = isError ? 'Error' : 'Output';
        const outputContentText = isError ? toolData.output.message : formatToolData(toolData.output);
        
        const outputLabel = document.createElement('div');
        outputLabel.className = 'tool-section-label';
        outputLabel.textContent = outputLabelText;
        
        const outputContent = document.createElement('div');
        outputContent.className = 'tool-section-content';
        outputContent.textContent = outputContentText;
        
        outputSection.appendChild(outputLabel);
        outputSection.appendChild(outputContent);
        details.appendChild(outputSection);
        card.dataset.hasOutput = 'true';
    }
}

function clearAllToolCards() {
    floatingToolCards.forEach((card) => {
        if (card && card.parentNode) {
            card.parentNode.removeChild(card);
        }
    });
    floatingToolCards.clear();
    pendingToolUses = [];
}

// No longer needed - remove the constant re-appending
function ensureToolCardAtBottom() {
    // Do nothing - cards stay where they are
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

function updateChatUI() {
    if (!chatContainer) return;

    // Remove thinking indicators before updating
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();

    // If chat was reset (fewer messages than rendered), clear and re-render
    if (chat.history.length < renderedMessageCount) {
        chatContainer.innerHTML = '';
        renderedMessageCount = 0;
    }

    // Check if the last message was updated (same count but content changed)
    if (chat.history.length === renderedMessageCount && renderedMessageCount > 0) {
        const lastItem = chat.history[chat.history.length - 1];
        
        // Handle tool card updates
        if (lastItem.type === 'tool') {
            const existingCard = chatContainer.querySelector(`.tool-card[data-tool-use-id="${lastItem.toolUseId}"]`);
            if (existingCard) {
                updateToolCard(existingCard, lastItem);
            }
        } else {
            // Update the last message element's content
            const messageElements = chatContainer.querySelectorAll('.message:not(.system):not(.thinking)');
            const lastMessageEl = messageElements[messageElements.length - 1];
            if (lastMessageEl && lastItem.role) {
                const contentEl = lastMessageEl.querySelector('.message-content');
                if (contentEl) {
                    // Update text content
                    contentEl.textContent = lastItem.message || "";
                    
                    // Add interrupted indicator if needed
                    if (lastItem.role.toLowerCase() === 'assistant' && lastItem.interrupted) {
                        const existingIndicator = contentEl.querySelector('.interrupted-indicator');
                        if (!existingIndicator) {
                            const interruptedSpan = document.createElement('div');
                            interruptedSpan.className = 'interrupted-indicator';
                            interruptedSpan.textContent = '(interrupted)';
                            contentEl.appendChild(interruptedSpan);
                        }
                    }
                }
            }
        }
    } else {
        // Only render new messages (incremental update)
        const newMessages = chat.history.slice(renderedMessageCount);
        
        newMessages.forEach(item => {
            const messageEl = createMessageElement(item);
            if (messageEl) {
                chatContainer.appendChild(messageEl);
            }
        });
        
        renderedMessageCount = chat.history.length;
    }

    // Also check for any tool cards that need updating (status change from running to completed)
    chat.history.forEach(item => {
        if (item.type === 'tool' && item.status === 'completed') {
            const existingCard = chatContainer.querySelector(`.tool-card[data-tool-use-id="${item.toolUseId}"]`);
            if (existingCard && !existingCard.dataset.completed) {
                updateToolCard(existingCard, item);
                existingCard.dataset.completed = 'true';
            }
        }
    });

    // Check for any assistant messages that need interrupted indicator
    const messageElements = chatContainer.querySelectorAll('.message.assistant:not(.thinking)');
    chat.history.forEach((item, index) => {
        if (item.role?.toLowerCase() === 'assistant' && item.interrupted) {
            // Find the corresponding message element
            let assistantIndex = 0;
            for (let i = 0; i <= index; i++) {
                if (chat.history[i].role?.toLowerCase() === 'assistant') {
                    assistantIndex++;
                }
            }
            const messageEl = messageElements[assistantIndex - 1];
            if (messageEl) {
                const contentEl = messageEl.querySelector('.message-content');
                if (contentEl && !contentEl.querySelector('.interrupted-indicator')) {
                    const interruptedSpan = document.createElement('div');
                    interruptedSpan.className = 'interrupted-indicator';
                    interruptedSpan.textContent = '(interrupted)';
                    contentEl.appendChild(interruptedSpan);
                }
            }
        }
    });

    // Re-add thinking indicators if needed
    if (waitingForAssistantResponse) showAssistantThinkingIndicator();

    scrollToBottom();
}

function updateToolCard(card, item) {
    // Update status
    const status = card.querySelector('.tool-status');
    if (status && item.status === 'completed') {
        status.className = 'tool-status completed';
        status.textContent = '';
        const elapsed = item.elapsed ? formatElapsed(item.elapsed) : '';
        
        const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        checkSvg.setAttribute('class', 'tool-check');
        checkSvg.setAttribute('viewBox', '0 0 24 24');
        checkSvg.setAttribute('fill', 'none');
        checkSvg.setAttribute('stroke', 'currentColor');
        checkSvg.setAttribute('stroke-width', '2');
        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', '20 6 9 17 4 12');
        checkSvg.appendChild(polyline);
        
        const elapsedSpan = document.createElement('span');
        elapsedSpan.className = 'tool-elapsed';
        elapsedSpan.textContent = elapsed;
        
        status.appendChild(checkSvg);
        status.appendChild(elapsedSpan);
    }

    // Add output section if not present
    const details = card.querySelector('.tool-details');
    if (details && item.output !== undefined && !details.querySelector('.tool-section:nth-child(2)')) {
        const outputSection = document.createElement('div');
        outputSection.className = 'tool-section';
        
        const outputLabel = document.createElement('div');
        outputLabel.className = 'tool-section-label';
        outputLabel.textContent = 'Output';
        
        const outputContent = document.createElement('div');
        outputContent.className = 'tool-section-content';
        outputContent.textContent = formatToolData(item.output);
        
        outputSection.appendChild(outputLabel);
        outputSection.appendChild(outputContent);
        details.appendChild(outputSection);
    }
}

function clearChatUI() {
    chatContainer.innerHTML = '';
    renderedMessageCount = 0;
    clearAllToolCards();
    if (typeof allCorrections !== 'undefined') {
        allCorrections.length = 0;
        refreshFeedbackPanel();
        updateFeedbackBadge();
    }
    if (typeof resetScenarioProgress === 'function') resetScenarioProgress();
    if (typeof refreshScenarioCard === 'function') refreshScenarioCard();
}

function showUserThinkingIndicator() {
    hideUserThinkingIndicator();
    waitingForUserTranscription = true;

    userThinkingIndicator = document.createElement('div');
    userThinkingIndicator.className = 'message user thinking';

    const listeningText = document.createElement('div');
    listeningText.className = 'thinking-text';
    listeningText.textContent = 'Listening';
    userThinkingIndicator.appendChild(listeningText);

    const dotContainer = document.createElement('div');
    dotContainer.className = 'thinking-dots';
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dotContainer.appendChild(dot);
    }
    userThinkingIndicator.appendChild(dotContainer);

    chatContainer.appendChild(userThinkingIndicator);
    scrollToBottom();
}

function showAssistantThinkingIndicator() {
    hideAssistantThinkingIndicator();
    waitingForAssistantResponse = true;

    assistantThinkingIndicator = document.createElement('div');
    assistantThinkingIndicator.className = 'message assistant thinking';

    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'message-icon';
    iconWrapper.appendChild(createNovaIcon());
    assistantThinkingIndicator.appendChild(iconWrapper);

    const thinkingText = document.createElement('div');
    thinkingText.className = 'thinking-text';
    thinkingText.textContent = 'Thinking';
    assistantThinkingIndicator.appendChild(thinkingText);

    const dotContainer = document.createElement('div');
    dotContainer.className = 'thinking-dots';
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dotContainer.appendChild(dot);
    }
    assistantThinkingIndicator.appendChild(dotContainer);

    chatContainer.appendChild(assistantThinkingIndicator);
    scrollToBottom();
}

function hideUserThinkingIndicator() {
    waitingForUserTranscription = false;
    if (userThinkingIndicator && userThinkingIndicator.parentNode) {
        userThinkingIndicator.parentNode.removeChild(userThinkingIndicator);
    }
    userThinkingIndicator = null;
}

function hideAssistantThinkingIndicator() {
    waitingForAssistantResponse = false;
    if (assistantThinkingIndicator && assistantThinkingIndicator.parentNode) {
        assistantThinkingIndicator.parentNode.removeChild(assistantThinkingIndicator);
    }
    assistantThinkingIndicator = null;
}

// Socket event handlers
socket.on('contentStart', (data) => {
    if (data.type === 'TEXT') {
        role = data.role;
        if (data.role === 'USER') {
            // Don't hide user thinking indicator here - wait for actual text
        } else if (data.role === 'ASSISTANT') {
            hideAssistantThinkingIndicator();
            let isSpeculative = false;
            try {
                if (data.additionalModelFields) {
                    const additionalFields = JSON.parse(data.additionalModelFields);
                    isSpeculative = additionalFields.generationStage === "SPECULATIVE";
                    displayAssistantText = isSpeculative;
                } else {
                    displayAssistantText = false;
                }
            } catch (e) {
                console.error("Error parsing additionalModelFields:", e);
            }
        }
    } else if (data.type === 'AUDIO') {
        // Don't re-show indicator here, it's already shown when recording starts
    }
});

socket.on('textOutput', (data) => {
    if (role === 'USER') {
        hideUserThinkingIndicator();
        transcriptionReceived = true;
        handleTextOutput({ role: data.role, content: data.content });
        showAssistantThinkingIndicator();
    } else if (role === 'ASSISTANT') {
        // Only show speculative text (real-time), skip final text (avoid duplicates)
        if (displayAssistantText) {
            handleTextOutput({ role: data.role, content: data.content });
        }
    }
});

socket.on('audioOutput', (data) => {
    if (data.content) {
        try {
            const audioData = base64ToFloat32Array(data.content);
            audioPlayer.playAudio(audioData);

            // Calculate this chunk's duration based on sample rate
            const chunkDuration = (audioData.length / config.outputSampleRate) * 1000; // in ms
            
            // Track speech start time and accumulate total duration
            if (speechStartTime === 0) {
                speechStartTime = Date.now();
                totalAudioDuration = 0;
                // Reset fade state when new speech starts
                isRingFadingOut = false;
                ringFadeAlpha = 1;
            }
            totalAudioDuration += chunkDuration;

            // Update waveform with assistant audio output level (circular wave)
            let sum = 0;
            for (let i = 0; i < audioData.length; i++) {
                sum += audioData[i] * audioData[i];
            }
            const rms = Math.sqrt(sum / audioData.length);
            updateAssistantAudioLevel(rms);
            
            // Clear any existing fade timer
            if (audioFadeTimer) {
                clearTimeout(audioFadeTimer);
                audioFadeTimer = null;
            }
        } catch (error) {
            console.error('Error processing audio data:', error);
        }
    }
});

socket.on('contentEnd', (data) => {
    if (data.type === 'TEXT') {
        if (role === 'USER') {
            hideUserThinkingIndicator();
            showAssistantThinkingIndicator();
            // Trigger German learner analysis on completed user turn
            scheduleGermanAnalysisForLastUserTurn();
        } else if (role === 'ASSISTANT') {
            hideAssistantThinkingIndicator();
        }

        if (data.stopReason?.toUpperCase() === 'END_TURN') {
            // Clear pending tools - they're already displayed as floating cards
            // No need to re-add to history, just clear the tracking array
            pendingToolUses = [];
            chatHistoryManager.endTurn();
        } else if (data.stopReason?.toUpperCase() === 'INTERRUPTED') {
            audioPlayer.bargeIn();
            chatHistoryManager.markLastAssistantInterrupted();
            
            // Immediately stop the ring animation on interruption
            if (audioFadeTimer) {
                clearTimeout(audioFadeTimer);
                audioFadeTimer = null;
            }
            isRingFadingOut = true;
            targetAssistantAudioLevel = 0;
            assistantAudioLevel = 0;
            speechStartTime = 0;
            totalAudioDuration = 0;
        }
    } else if (data.type === 'AUDIO') {
        // Prevent double triggering if already fading
        if (isRingFadingOut) {
            console.log('Audio contentEnd: already fading, skipping');
            return;
        }
        
        // Calculate remaining playback time: totalDuration - elapsed since speech started
        // Add buffer offset based on configured audio buffer size
        const audioBufferDelay = config.audioBufferMs;
        const elapsedSinceSpeechStart = Date.now() - speechStartTime;
        const remainingPlayback = Math.max(0, totalAudioDuration + audioBufferDelay - elapsedSinceSpeechStart);
        
        console.debug(`Audio contentEnd: totalDuration=${totalAudioDuration}ms, elapsed=${elapsedSinceSpeechStart}ms, remaining=${remainingPlayback}ms`);
        
        // Clear any existing timer
        if (audioFadeTimer) {
            clearTimeout(audioFadeTimer);
        }
        
        // Start gradual fade out after remaining audio finishes
        audioFadeTimer = setTimeout(() => {
            console.debug(`Starting ring fade out, current assistantAudioLevel=${assistantAudioLevel}, ringFadeAlpha=${ringFadeAlpha}`);
            
            // Trigger the ring fade out animation
            isRingFadingOut = true;
            targetAssistantAudioLevel = 0;
            
            // Reset tracking after fade completes
            setTimeout(() => {
                speechStartTime = 0;
                totalAudioDuration = 0;
                audioFadeTimer = null;
                console.debug('Fade out complete');
            }, 1500);
        }, remainingPlayback);
    }
});

socket.on('bargeIn', (data) => {
    console.log('Barge-in event received:', data);
    audioPlayer.bargeIn();
    chatHistoryManager.markLastAssistantInterrupted();
    
    // Immediately stop the ring animation on barge-in
    if (audioFadeTimer) {
        clearTimeout(audioFadeTimer);
        audioFadeTimer = null;
    }
    isRingFadingOut = true;
    targetAssistantAudioLevel = 0;
    speechStartTime = 0;
    totalAudioDuration = 0;
});

socket.on('toolUse', (data) => {
    console.log('Tool use event received:', data);
    hideAssistantThinkingIndicator();
    
    // Parse content if it's a JSON string
    let inputData = data.content;
    if (typeof inputData === 'string') {
        try {
            inputData = JSON.parse(inputData);
        } catch (e) {
            // Keep as string if not valid JSON
        }
    }
    
    // Create tool data
    const toolData = {
        toolUseId: data.toolUseId,
        toolName: data.toolName,
        input: inputData || {},
        startTime: Date.now(),
        status: 'running'
    };
    
    // Add to pending tools array
    pendingToolUses.push(toolData);
    
    // Show tool card immediately at the bottom of chat
    showToolCard(toolData);
});

socket.on('toolResult', (data) => {
    console.log('Tool result event received:', data);
    
    // Find and update the matching pending tool
    const toolIndex = pendingToolUses.findIndex(t => t.toolUseId === data.toolUseId);
    if (toolIndex !== -1) {
        const tool = pendingToolUses[toolIndex];
        tool.output = data.result;
        tool.endTime = Date.now();
        // Use server-provided execution time if available, otherwise calculate from client timestamps
        tool.elapsed = data.executionTimeMs || (tool.endTime - tool.startTime);
        tool.status = 'completed';
        
        // Update the displayed tool card
        updateToolCardById(data.toolUseId, tool);
    }
    
    showAssistantThinkingIndicator();
});

socket.on('streamComplete', () => {
    if (isStreaming) stopStreaming();
});

socket.on('streamInterrupted', (data) => {
    console.log('Stream interrupted (recoverable):', data);
    // Don't stop streaming - audio might still be playing
    // Just log it for debugging
});

socket.on('connect', () => {
    sessionInitialized = false;
});

socket.on('disconnect', () => {
    if (manualDisconnect) {
        manualDisconnect = false;
    }
    sessionInitialized = false;
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
    stopWaveformAnimation();
});

socket.on('error', (error) => {
    console.error("Server error:", error);
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
    
    // Handle stream errors from AWS - stop conversation and show error
    if (error?.source === 'responseStream' && error?.details) {
        console.log('Stream error detected, stopping conversation');
        if (isStreaming) {
            stopStreaming();
        }
        const errorDiv = document.createElement('div');
        errorDiv.className = 'message system';
        const warningIcon = document.createElement('span');
        warningIcon.className = 'warning-icon';
        warningIcon.textContent = '⚠️';
        errorDiv.appendChild(warningIcon);
        errorDiv.appendChild(document.createTextNode(' ' + error.details));
        chatContainer.appendChild(errorDiv);
        scrollToBottom();
        return;
    }
    
    // Stop streaming if session is no longer active
    if (error?.message === 'No active session for audio input' && isStreaming) {
        console.log('Session closed, stopping audio capture');
        stopStreaming();
    }
});

// Voice button handler
voiceBtn.addEventListener('click', () => {
    if (isStreaming) {
        stopStreaming();
    } else {
        startStreaming();
    }
});

// Window resize handler for canvas
window.addEventListener('resize', () => {
    if (isAnimating) {
        initWaveformCanvas();
    }
});

// ─── German learner analysis ────────────────────────────────────────────────
// After each completed user turn we POST the transcript to /api/analyze-german
// for inline correction marks + cumulative pattern summary in the feedback panel.

const allCorrections = []; // accumulated for this conversation
const completedScenarioStepIds = new Set();

// Human-readable titles for each scenario, used in the right-side panel header.
const SCENARIO_TITLES = {
    introduce_yourself: 'Introduce yourself',
    order_coffee: 'Order at a café',
    ask_directions: 'Ask for directions',
    grocery_shopping: 'Grocery shopping',
    describe_family: 'Describe your family',
    weekend_story: 'Tell about your weekend',
    doctor_visit: 'Visit the doctor',
    book_hotel: 'Book or check in to a hotel',
    apartment_hunt: 'Apartment hunting',
    make_plans: 'Make plans',
    discuss_film: 'Talk about a film',
    complaint: 'Politely complain',
    advice: 'Give advice',
    job_interview: 'Job interview',
    travel_problem: 'Solve a travel problem',
    debate_topic: 'Debate a topic',
    describe_chart: 'Describe a chart',
    workplace_conflict: 'Workplace conflict',
    literary_analysis: 'Analyze a literary text',
    ethical_debate: 'Ethical debate',
    negotiation: 'Negotiation',
};

function renderCheckCircleSVG(done) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'scenario-step-icon' + (done ? ' done' : ''));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');

    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    circle.setAttribute('class', 'scenario-step-circle');
    svg.appendChild(circle);

    if (done) {
        const check = document.createElementNS(svgNS, 'polyline');
        check.setAttribute('points', '7 12.5 10.5 16 17 9');
        check.setAttribute('class', 'scenario-step-check');
        svg.appendChild(check);
    }
    return svg;
}

function refreshScenarioCard() {
    const panel = document.getElementById('scenario-panel');
    const steps = SCENARIO_USER_STEPS[config.scenario];
    const hasSteps = Array.isArray(steps) && steps.length > 0;

    if (!panel) return;
    if (!hasSteps) {
        panel.classList.add('hidden');
        panel.textContent = '';
        return;
    }

    panel.classList.remove('hidden');
    let card = document.getElementById('scenario-card');
    if (!card) {
        panel.textContent = '';
        card = document.createElement('div');
        card.id = 'scenario-card';
        card.className = 'scenario-card';
        panel.appendChild(card);
    }

    const doneCount = steps.filter(s => completedScenarioStepIds.has(s.id)).length;
    const totalCount = steps.length;
    const pct = Math.round((doneCount / totalCount) * 100);
    const allDone = doneCount === totalCount;

    // Detect which step IDs were already in the DOM as "done" so we can highlight new ones
    const previouslyDone = new Set(
        Array.from(card.querySelectorAll('.scenario-step.done')).map(el => el.dataset.stepId)
    );

    card.textContent = '';
    card.classList.toggle('all-done', allDone);

    // Header — scenario title + progress count
    const header = document.createElement('div');
    header.className = 'scenario-header';
    const titleEl = document.createElement('h3');
    titleEl.className = 'scenario-title';
    titleEl.textContent = SCENARIO_TITLES[config.scenario] || 'Your tasks';
    const progressLabel = document.createElement('span');
    progressLabel.className = 'scenario-progress-label';
    progressLabel.textContent = `${doneCount} / ${totalCount}`;
    header.appendChild(titleEl);
    header.appendChild(progressLabel);
    card.appendChild(header);

    // Progress bar
    const bar = document.createElement('div');
    bar.className = 'scenario-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'scenario-progress-fill';
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    card.appendChild(bar);

    // Steps
    const ul = document.createElement('ul');
    ul.className = 'scenario-checklist';
    steps.forEach((step, idx) => {
        const isDone = completedScenarioStepIds.has(step.id);
        const isNewlyDone = isDone && !previouslyDone.has(step.id);

        const li = document.createElement('li');
        li.className = 'scenario-step' + (isDone ? ' done' : '') + (isNewlyDone ? ' just-completed' : '');
        li.dataset.stepId = step.id;
        li.style.setProperty('--step-index', String(idx));

        li.appendChild(renderCheckCircleSVG(isDone));

        const label = document.createElement('span');
        label.className = 'scenario-step-label';
        label.textContent = step.label;
        li.appendChild(label);

        ul.appendChild(li);
    });
    card.appendChild(ul);

    if (allDone) {
        const done = document.createElement('div');
        done.className = 'scenario-done';
        const dot = document.createElement('span');
        dot.className = 'scenario-done-dot';
        const text = document.createElement('span');
        text.textContent = 'Well done — scenario complete';
        done.appendChild(dot);
        done.appendChild(text);
        card.appendChild(done);
    }
}

// Reset scenario progress whenever a new conversation starts
function resetScenarioProgress() {
    completedScenarioStepIds.clear();
    const card = document.getElementById('scenario-card');
    if (card) card.remove();
    const panel = document.getElementById('scenario-panel');
    if (panel) panel.classList.add('hidden');
}

function scheduleGermanAnalysisForLastUserTurn() {
    // Respect the user's Corrections settings — skip entirely when off.
    if (config.correctionsLevel === 'off') return;

    // We snapshot which user-message DOM element should receive the annotation,
    // because by the time the analysis returns the chat will have advanced.
    const userMessages = chatContainer.querySelectorAll('.message.user:not(.thinking)');
    const targetEl = userMessages[userMessages.length - 1];
    if (!targetEl) return;

    const userText = targetEl.querySelector('.message-content')?.textContent?.trim();
    if (!userText) return;

    // Mark loading
    if (targetEl.dataset.analyzed) return;
    targetEl.dataset.analyzed = 'pending';

    const loading = document.createElement('div');
    loading.className = 'message-annotations loading';
    loading.textContent = 'Wird analysiert…';
    targetEl.appendChild(loading);

    // Gather everything the learner has said so far this session (for scenario step judgment)
    const transcriptSoFar = (chat.history || [])
        .filter(t => t && t.role && t.role.toUpperCase() === 'USER' && t.message)
        .map(t => t.message)
        .join(' ');

    const scenarioSteps = SCENARIO_USER_STEPS[config.scenario];

    fetch('/api/analyze-german', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: userText,
            cefr: config.persona,
            scenario: config.scenario,
            scenarioSteps,
            transcriptSoFar,
            language: config.language || 'de',
        }),
    })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(result => {
            loading.remove();
            targetEl.dataset.analyzed = 'done';

            // Filter corrections by strictness level. "major" keeps only grammar/vocab.
            let filtered = { ...result };
            if (config.correctionsLevel === 'major') {
                filtered.corrections = (result.corrections || []).filter(c => c.type === 'grammar' || c.type === 'vocab');
            }

            // Inline rendering respects the show toggle, but the feedback panel always
            // accumulates so the user can flip the toggle on later and see the history.
            if (config.correctionsShow) {
                renderInlineAnnotations(targetEl, filtered);
            }
            if (filtered.corrections?.length) {
                filtered.corrections.forEach(c => allCorrections.push({ ...c, ts: Date.now(), utterance: userText }));
                refreshFeedbackPanel();
                updateFeedbackBadge();
            }
            // Scenario step completion
            if (Array.isArray(result.completedStepIds)) {
                result.completedStepIds.forEach(id => completedScenarioStepIds.add(id));
                refreshScenarioCard();
            }
        })
        .catch(error => {
            console.error('Analysis failed:', error);
            loading.remove();
            targetEl.dataset.analyzed = 'failed';
        });
}

const TYPE_LABELS = {
    grammar: 'Grammatik',
    vocab: 'Wortschatz',
    usage: 'Stil',
    pronunciation: 'Aussprache',
    register: 'Register',
};

function renderInlineAnnotations(messageEl, result) {
    const wrap = document.createElement('div');
    wrap.className = 'message-annotations';

    if (!result.corrections || result.corrections.length === 0) {
        const ok = document.createElement('div');
        ok.className = 'annotation-ok';
        ok.textContent = result.strengths?.length ? `✓ ${result.strengths[0]}` : '✓ Sehr gut!';
        wrap.appendChild(ok);
        messageEl.appendChild(wrap);
        return;
    }

    result.corrections.forEach(c => {
        const item = document.createElement('div');
        item.className = `annotation annotation-${c.type || 'usage'}`;

        const badge = document.createElement('span');
        badge.className = 'annotation-badge';
        badge.textContent = TYPE_LABELS[c.type] || c.type || 'Hinweis';
        item.appendChild(badge);

        const fix = document.createElement('span');
        fix.className = 'annotation-fix';
        const orig = document.createElement('span');
        orig.className = 'annotation-original';
        orig.textContent = c.original;
        const arrow = document.createElement('span');
        arrow.className = 'annotation-arrow';
        arrow.textContent = ' → ';
        const correct = document.createElement('span');
        correct.className = 'annotation-correct';
        correct.textContent = c.correct;
        fix.appendChild(orig);
        fix.appendChild(arrow);
        fix.appendChild(correct);
        item.appendChild(fix);

        if (c.explanation) {
            const exp = document.createElement('div');
            exp.className = 'annotation-explanation';
            exp.textContent = c.explanation;
            item.appendChild(exp);
        }
        wrap.appendChild(item);
    });

    messageEl.appendChild(wrap);
}

// ─── Feedback panel ─────────────────────────────────────────────────────────
function initFeedbackPanel() {
    const toggle = document.getElementById('feedback-toggle');
    const panel = document.getElementById('feedback-panel');
    const overlay = document.getElementById('feedback-overlay');
    const close = document.getElementById('feedback-close');

    toggle?.addEventListener('click', () => {
        panel?.classList.add('open');
        overlay?.classList.add('open');
        refreshFeedbackPanel();
    });
    const dismiss = () => {
        panel?.classList.remove('open');
        overlay?.classList.remove('open');
    };
    close?.addEventListener('click', dismiss);
    overlay?.addEventListener('click', dismiss);
}

function updateFeedbackBadge() {
    const badge = document.getElementById('feedback-badge');
    if (!badge) return;
    if (allCorrections.length === 0) {
        badge.classList.add('hidden');
        badge.textContent = '0';
    } else {
        badge.classList.remove('hidden');
        badge.textContent = String(allCorrections.length);
    }
}

function refreshFeedbackPanel() {
    const empty = document.getElementById('feedback-empty');
    const summary = document.getElementById('feedback-summary');
    const patterns = document.getElementById('feedback-patterns');
    const list = document.getElementById('feedback-list');
    if (!list || !empty || !summary || !patterns) return;

    list.textContent = '';
    patterns.textContent = '';

    if (allCorrections.length === 0) {
        empty.classList.remove('hidden');
        summary.classList.add('hidden');
        return;
    }
    empty.classList.add('hidden');
    summary.classList.remove('hidden');

    // Aggregate by category
    const counts = new Map();
    allCorrections.forEach(c => {
        const key = `${c.category || c.type || 'other'}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    sorted.forEach(([cat, n]) => {
        const chip = document.createElement('div');
        chip.className = 'pattern-chip';
        chip.innerHTML = `<span class="pattern-name"></span><span class="pattern-count"></span>`;
        chip.querySelector('.pattern-name').textContent = cat;
        chip.querySelector('.pattern-count').textContent = `${n}×`;
        patterns.appendChild(chip);
    });

    // Render each correction, most recent first
    [...allCorrections].reverse().forEach(c => {
        const item = document.createElement('div');
        item.className = `feedback-item feedback-item-${c.type || 'usage'}`;

        const header = document.createElement('div');
        header.className = 'feedback-item-header';
        const badge = document.createElement('span');
        badge.className = 'annotation-badge';
        badge.textContent = TYPE_LABELS[c.type] || c.type || 'Hinweis';
        const cat = document.createElement('span');
        cat.className = 'feedback-category';
        cat.textContent = c.category || '';
        header.appendChild(badge);
        header.appendChild(cat);

        const fix = document.createElement('div');
        fix.className = 'annotation-fix';
        const orig = document.createElement('span');
        orig.className = 'annotation-original';
        orig.textContent = c.original;
        const arrow = document.createElement('span');
        arrow.className = 'annotation-arrow';
        arrow.textContent = ' → ';
        const correct = document.createElement('span');
        correct.className = 'annotation-correct';
        correct.textContent = c.correct;
        fix.appendChild(orig);
        fix.appendChild(arrow);
        fix.appendChild(correct);

        const exp = document.createElement('div');
        exp.className = 'annotation-explanation';
        exp.textContent = c.explanation || '';

        item.appendChild(header);
        item.appendChild(fix);
        if (c.explanation) item.appendChild(exp);

        list.appendChild(item);
    });
}

// Tiny seed message sent to the model when "Bot greets first" is enabled.
// We use the learner's L1-language (English here) so the model executes the directive,
// but the model's response will be in the target language per the persona prompt.
function greetingSeedForCurrentConfig() {
    if (config.scenario && config.scenario !== 'none') {
        return 'Begin the scenario now in the target language. Greet me briefly and ask the first question.';
    }
    return 'Please begin our conversation in the target language. Greet me and ask me a question to get started.';
}

// ─── End-of-session summary + learner profile memory ────────────────────────
// On stop, send the full transcript to /api/end-session. Render a summary card.
// Merge returned profile delta into localStorage[`learnerProfile_<language>`].

function getLearnerProfile() {
    const key = `learnerProfile_${config.language || 'de'}`;
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveLearnerProfile(profile) {
    const key = `learnerProfile_${config.language || 'de'}`;
    localStorage.setItem(key, JSON.stringify(profile));
}

function clearLearnerProfile() {
    const key = `learnerProfile_${config.language || 'de'}`;
    localStorage.removeItem(key);
    renderProfileBlock();
}

function requestSessionSummary() {
    const transcript = (chat.history || [])
        .filter(t => t && t.role && t.message && !t.type)
        .map(t => ({ role: t.role, message: t.message }));

    if (transcript.length < 2) return; // nothing meaningful to summarize

    // Show a placeholder card immediately
    const card = document.createElement('div');
    card.className = 'session-summary-card loading';
    card.textContent = 'Generating session summary…';
    chatContainer.appendChild(card);
    scrollToBottom();

    const previousProfile = getLearnerProfile();

    fetch('/api/end-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            transcript,
            language: config.language || 'de',
            cefr: config.persona,
            previousProfile,
        }),
    })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(result => {
            renderSessionSummaryCard(card, result);
            if (result.profile) {
                saveLearnerProfile(result.profile);
                renderProfileBlock();
            }
        })
        .catch(error => {
            console.error('Session summary failed:', error);
            card.textContent = 'Summary unavailable.';
            card.classList.remove('loading');
            card.classList.add('error');
        });
}

function renderSessionSummaryCard(card, result) {
    card.classList.remove('loading');
    card.textContent = '';

    const title = document.createElement('h3');
    title.textContent = 'Session summary';
    card.appendChild(title);

    if (result.summary) {
        const p = document.createElement('p');
        p.className = 'summary-text';
        p.textContent = result.summary;
        card.appendChild(p);
    }

    function addList(label, items, cls) {
        if (!items || items.length === 0) return;
        const wrap = document.createElement('div');
        wrap.className = `summary-section ${cls}`;
        const h = document.createElement('h4');
        h.textContent = label;
        wrap.appendChild(h);
        const ul = document.createElement('ul');
        items.forEach(x => {
            const li = document.createElement('li');
            li.textContent = x;
            ul.appendChild(li);
        });
        wrap.appendChild(ul);
        card.appendChild(wrap);
    }
    addList('Strengths', result.strengths, 'strengths');
    addList('Areas to work on', result.weaknesses, 'weaknesses');
    addList('Try next', result.suggestions, 'suggestions');

    scrollToBottom();
}

// Profile block in settings — read-only display + clear button
function renderProfileBlock() {
    const container = document.getElementById('learner-profile-block');
    if (!container) return;
    container.textContent = '';
    const profile = getLearnerProfile();
    if (!profile || Object.keys(profile).length === 0) {
        const empty = document.createElement('p');
        empty.className = 'setting-hint';
        empty.textContent = 'No profile yet. After your first conversation the bot will start remembering things about you.';
        container.appendChild(empty);
        return;
    }
    const list = document.createElement('dl');
    list.className = 'profile-list';
    const FIELDS = [
        ['name', 'Name'],
        ['age', 'Age'],
        ['city', 'City'],
        ['country', 'Country'],
        ['occupation', 'Occupation'],
        ['family', 'Family'],
        ['learningGoals', 'Learning goals'],
    ];
    FIELDS.forEach(([k, label]) => {
        if (!profile[k]) return;
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = profile[k];
        list.appendChild(dt);
        list.appendChild(dd);
    });
    ['languages', 'hobbies', 'observedErrors', 'facts'].forEach(k => {
        const arr = profile[k];
        if (!Array.isArray(arr) || arr.length === 0) return;
        const dt = document.createElement('dt');
        dt.textContent = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
        const dd = document.createElement('dd');
        dd.textContent = arr.join(', ');
        list.appendChild(dt);
        list.appendChild(dd);
    });
    container.appendChild(list);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'latency-refresh-btn';
    clearBtn.textContent = 'Clear profile';
    clearBtn.addEventListener('click', () => {
        if (confirm('Clear stored learner profile? The bot will forget everything it has learned about you.')) {
            clearLearnerProfile();
        }
    });
    container.appendChild(clearBtn);
}

function buildProfilePromptBlock() {
    const profile = getLearnerProfile();
    if (!profile || Object.keys(profile).length === 0) return '';
    const lines = ['', 'WHAT YOU REMEMBER ABOUT THIS LEARNER (from previous sessions):'];
    if (profile.name) lines.push(`- Name: ${profile.name}`);
    if (profile.age) lines.push(`- Age: ${profile.age}`);
    if (profile.city) lines.push(`- City: ${profile.city}${profile.country ? ', ' + profile.country : ''}`);
    if (profile.occupation) lines.push(`- Occupation: ${profile.occupation}`);
    if (profile.family) lines.push(`- Family: ${profile.family}`);
    if (Array.isArray(profile.hobbies) && profile.hobbies.length) lines.push(`- Hobbies: ${profile.hobbies.join(', ')}`);
    if (Array.isArray(profile.languages) && profile.languages.length) lines.push(`- Languages: ${profile.languages.join(', ')}`);
    if (profile.learningGoals) lines.push(`- Learning goals: ${profile.learningGoals}`);
    if (Array.isArray(profile.observedErrors) && profile.observedErrors.length) {
        lines.push(`- Errors to gently watch for: ${profile.observedErrors.join('; ')}`);
    }
    if (Array.isArray(profile.facts) && profile.facts.length) {
        lines.push(`- Other facts: ${profile.facts.join('; ')}`);
    }
    lines.push('');
    lines.push('Use this naturally — refer back, ask follow-ups based on it. Do NOT recite the profile back at them.');
    return lines.join('\n');
}

// Expose variables for typing.js
window.socket = socket;
window.showAssistantThinkingIndicator = showAssistantThinkingIndicator;
window.chatHistoryManager = chatHistoryManager;
window.scheduleGermanAnalysisForLastUserTurn = scheduleGermanAnalysisForLastUserTurn;
Object.defineProperty(window, 'sessionInitialized', {
    get: () => sessionInitialized
});

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await initSettings();
    initFeedbackPanel();
    initWaveformCanvas();
});
