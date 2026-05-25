import { ObjectExt } from '../util/ObjectsExt.js';
const AudioPlayerWorkletUrl = new URL('./AudioPlayerProcessor.worklet.js', import.meta.url).toString();
const AudioRecorderWorkletUrl = new URL('./AudioRecorderProcessor.worklet.js', import.meta.url).toString();

export class AudioPlayer {
    constructor() {
        this.onAudioPlayedListeners = [];
        this.initialized = false;
        this.sampleRate = 24000; // Default sample rate
    }

    addEventListener(event, callback) {
        switch (event) {
            case "onAudioPlayed":
                this.onAudioPlayedListeners.push(callback);
                break;
            default:
                console.error("Listener registered for event type: " + JSON.stringify(event) + " which is not supported");
        }
    }

    async start(sampleRate = 24000, initialBufferMs = 200) {
        this.sampleRate = sampleRate;
        this.initialBufferMs = initialBufferMs;
        this.audioContext = new AudioContext({ "sampleRate": this.sampleRate });
        
        // Resume AudioContext immediately (may be suspended due to autoplay policy)
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 512;

        // Chrome caches worklet code more aggressively, so add a nocache parameter to make sure we get the latest
        await this.audioContext.audioWorklet.addModule(AudioPlayerWorkletUrl + "?nocache=" + Date.now());
        await this.audioContext.audioWorklet.addModule(AudioRecorderWorkletUrl + "?nocache=" + Date.now());
        
        this.workletNode = new AudioWorkletNode(this.audioContext, "audio-player-processor");
        this.workletNode.connect(this.analyser);
        this.analyser.connect(this.audioContext.destination);
        
        // Create recorder worklet node to monitor played audio
        this.recorderNode = new AudioWorkletNode(this.audioContext, "audio-recorder-processor");
        this.analyser.connect(this.recorderNode);
        
        // Listen for samples from the recorder worklet
        this.recorderNode.port.onmessage = (event) => {
            if (event.data.type === 'samples') {
                this.onAudioPlayedListeners.forEach(listener => listener(event.data.samples));
            }
        };
        
        // Set initial buffer length immediately after worklet is created
        const bufferSamples = Math.round((this.initialBufferMs / 1000) * this.sampleRate);
        this.workletNode.port.postMessage({
            type: "initial-buffer-length",
            bufferLength: bufferSamples,
        });
        
        this.#maybeOverrideInitialBufferLength();
        this.initialized = true;
    }

    bargeIn() {
        this.workletNode.port.postMessage({
            type: "barge-in",
        })
    }

    async setSampleRate(newSampleRate) {
        if (this.sampleRate === newSampleRate && this.initialized) {
            return; // No change needed
        }
        
        // Need to recreate audio context with new sample rate
        const wasInitialized = this.initialized;
        const currentBufferMs = this.initialBufferMs || 200;
        if (wasInitialized) {
            this.stop();
        }
        
        // Always start with the new sample rate, preserving buffer setting
        await this.start(newSampleRate, currentBufferMs);
    }

    setInitialBufferMs(bufferMs) {
        if (!this.initialized || !this.workletNode) {
            console.warn('AudioPlayer not initialized, cannot set buffer');
            return;
        }
        // Convert ms to samples based on current sample rate
        const bufferSamples = Math.round((bufferMs / 1000) * this.sampleRate);
        this.workletNode.port.postMessage({
            type: "initial-buffer-length",
            bufferLength: bufferSamples,
        });
    }

    stop() {
        if (ObjectExt.exists(this.audioContext)) {
            this.audioContext.close();
        }

        if (ObjectExt.exists(this.analyser)) {
            this.analyser.disconnect();
        }

        if (ObjectExt.exists(this.workletNode)) {
            this.workletNode.disconnect();
        }

        if (ObjectExt.exists(this.recorderNode)) {
            this.recorderNode.disconnect();
        }

        this.initialized = false;
        this.audioContext = null;
        this.analyser = null;
        this.workletNode = null;
        this.recorderNode = null;
    }

    #maybeOverrideInitialBufferLength() {
        // Read a user-specified initial buffer length from the URL parameters to help with tinkering
        const params = new URLSearchParams(window.location.search);
        const value = params.get("audioPlayerInitialBufferLength");
        if (value === null) {
            return;  // No override specified
        }
        const bufferLength = parseInt(value);
        if (isNaN(bufferLength)) {
            console.error("Invalid audioPlayerInitialBufferLength value:", JSON.stringify(value));
            return;
        }
        this.workletNode.port.postMessage({
            type: "initial-buffer-length",
            bufferLength: bufferLength,
        });
    }

    async playAudio(samples) {
        if (!this.initialized) {
            console.error("The audio player is not initialized. Call init() before attempting to play audio.");
            return;
        }
        
        // Resume AudioContext if suspended (required after user gesture)
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        
        this.workletNode.port.postMessage({
            type: "audio",
            audioData: samples,
        });
    }

    getSamples() {
        if (!this.initialized) {
            return null;
        }
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        this.analyser.getByteTimeDomainData(dataArray);
        return [...dataArray].map(e => e / 128 - 1);
    }

    getVolume() {
        if (!this.initialized) {
            return 0;
        }
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        this.analyser.getByteTimeDomainData(dataArray);
        let normSamples = [...dataArray].map(e => e / 128 - 1);
        let sum = 0;
        for (let i = 0; i < normSamples.length; i++) {
            sum += normSamples[i] * normSamples[i];
        }
        return Math.sqrt(sum / normSamples.length);
    }
}
