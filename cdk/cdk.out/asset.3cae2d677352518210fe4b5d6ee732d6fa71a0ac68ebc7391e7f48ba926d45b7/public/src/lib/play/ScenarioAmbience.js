// Procedural ambient sound generator for scenarios. No external audio assets.
// Currently supports: cafe (filtered pink noise + occasional ceramic clinks).
// Designed to be quiet — sits well below voice without masking it.

export class ScenarioAmbience {
    constructor() {
        this.ctx = null;
        this.master = null;
        this.nodes = [];
        this.timers = [];
        this.currentScenario = null;
    }

    async start(scenario) {
        if (this.currentScenario === scenario) return;
        this.stop();
        if (!SCENARIO_RECIPES[scenario]) return;
        this.currentScenario = scenario;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        this.ctx = new AudioCtx();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0;
        this.master.connect(this.ctx.destination);

        // Fade in
        this.master.gain.linearRampToValueAtTime(SCENARIO_RECIPES[scenario].targetGain, this.ctx.currentTime + 1.2);

        SCENARIO_RECIPES[scenario].build(this.ctx, this.master, this.nodes, this.timers);
    }

    stop() {
        if (!this.ctx) return;
        const ctx = this.ctx;
        const master = this.master;
        try {
            master.gain.cancelScheduledValues(ctx.currentTime);
            master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
        } catch {}
        // Clear timers immediately so no new sounds are scheduled during fadeout
        this.timers.forEach(t => clearTimeout(t));
        this.timers = [];
        // Close the context once the fade-out finishes
        setTimeout(() => {
            this.nodes.forEach(n => { try { n.stop?.(); n.disconnect?.(); } catch {} });
            this.nodes = [];
            try { ctx.close(); } catch {}
        }, 800);
        this.ctx = null;
        this.master = null;
        this.currentScenario = null;
    }
}

// --- Recipes ---------------------------------------------------------------

function createPinkNoiseBuffer(ctx, seconds = 6) {
    // Voss-McCartney algorithm approximation. Good-enough pink noise.
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * seconds;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
    }
    return buffer;
}

function playClink(ctx, master, when) {
    // A short ringing tone with quick decay, suggestive of a ceramic cup tap.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;

    osc.type = 'sine';
    const baseFreq = 2400 + Math.random() * 1200;
    osc.frequency.setValueAtTime(baseFreq, when);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.85, when + 0.18);

    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(0.06 + Math.random() * 0.04, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);

    osc.connect(gain);
    gain.connect(hp);
    hp.connect(master);
    osc.start(when);
    osc.stop(when + 0.3);
}

const SCENARIO_RECIPES = {
    order_coffee: {
        targetGain: 0.07,   // intentionally quiet, voice stays clearly on top
        build(ctx, master, nodes, timers) {
            // Pink noise base = murmur of chatter
            const noiseBuf = createPinkNoiseBuffer(ctx, 8);
            const noise = ctx.createBufferSource();
            noise.buffer = noiseBuf;
            noise.loop = true;

            // Band-pass around speech frequencies for "chatter" feel, then low-pass to soften
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 500;
            bp.Q.value = 0.7;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 2000;

            noise.connect(bp);
            bp.connect(lp);
            lp.connect(master);
            noise.start();
            nodes.push(noise, bp, lp);

            // Occasional clinks
            function scheduleNextClink() {
                const delayMs = 2500 + Math.random() * 4500;
                const t = setTimeout(() => {
                    if (!ctx || ctx.state === 'closed') return;
                    playClink(ctx, master, ctx.currentTime + 0.01);
                    scheduleNextClink();
                }, delayMs);
                timers.push(t);
            }
            scheduleNextClink();
        }
    }
};

export const scenarioAmbience = new ScenarioAmbience();
