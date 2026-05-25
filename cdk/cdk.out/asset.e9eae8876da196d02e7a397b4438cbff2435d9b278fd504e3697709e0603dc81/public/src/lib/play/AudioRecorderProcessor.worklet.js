// AudioWorklet processor for recording/monitoring audio playback
class AudioRecorderProcessor extends AudioWorkletProcessor {
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        
        if (input.length > 0 && output.length > 0) {
            const inputChannel = input[0];
            const outputChannel = output[0];
            
            // Pass through audio
            outputChannel.set(inputChannel);
            
            // Send samples to main thread for monitoring
            if (inputChannel.length > 0) {
                this.port.postMessage({
                    type: 'samples',
                    samples: inputChannel.slice()
                });
            }
        }
        
        return true;
    }
}

registerProcessor('audio-recorder-processor', AudioRecorderProcessor);
