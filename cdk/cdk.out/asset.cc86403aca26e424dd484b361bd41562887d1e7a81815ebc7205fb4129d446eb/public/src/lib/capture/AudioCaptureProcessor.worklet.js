// AudioWorklet processor for capturing microphone input
class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.isStreaming = false;
        this.samplingRatio = 1;
        this.isFirefox = false;
        
        this.port.onmessage = (event) => {
            const { type, value } = event.data;
            
            switch (type) {
                case 'setStreaming':
                    this.isStreaming = value;
                    break;
                case 'setSamplingRatio':
                    this.samplingRatio = value;
                    break;
                case 'setIsFirefox':
                    this.isFirefox = value;
                    break;
            }
        };
    }
    
    process(inputs, outputs, parameters) {
        if (!this.isStreaming) {
            return true;
        }
        
        const input = inputs[0];
        if (input.length === 0) {
            return true;
        }
        
        const inputData = input[0];
        if (!inputData || inputData.length === 0) {
            return true;
        }
        
        // Calculate audio level for visualization
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
            sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        
        // Convert to PCM16
        const numSamples = this.isFirefox 
            ? Math.round(inputData.length / this.samplingRatio)
            : inputData.length;
        const pcmData = new Int16Array(numSamples);
        
        if (this.isFirefox) {
            for (let i = 0; i < numSamples; i++) {
                const sample = inputData[Math.floor(i * this.samplingRatio)];
                pcmData[i] = Math.max(-1, Math.min(1, sample)) * 0x7FFF;
            }
        } else {
            for (let i = 0; i < inputData.length; i++) {
                pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
            }
        }
        
        // Send data to main thread
        this.port.postMessage({
            type: 'audioData',
            pcmData: pcmData,
            rms: rms
        });
        
        return true;
    }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
