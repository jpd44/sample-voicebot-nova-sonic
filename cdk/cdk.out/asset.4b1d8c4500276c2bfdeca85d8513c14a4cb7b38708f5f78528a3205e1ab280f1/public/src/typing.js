// Typing Window Feature - Clean Standalone Implementation

// Wait for socket to be available
function waitForSocket() {
    return new Promise((resolve) => {
        if (window.socket) {
            resolve(window.socket);
        } else {
            const checkInterval = setInterval(() => {
                if (window.socket) {
                    clearInterval(checkInterval);
                    resolve(window.socket);
                }
            }, 100);
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // Wait for socket to be available
    const socket = await waitForSocket();
    
    const keyboardToggle = document.getElementById('keyboard-toggle');
    const typingWindow = document.getElementById('typing-window');
    const textInput = document.getElementById('text-input');
    const sendTextBtn = document.getElementById('send-text-btn');
    const hideTypingBtn = document.getElementById('hide-typing-btn');
    const voiceBtn = document.getElementById('voice-btn');
    
    if (!keyboardToggle || !typingWindow || !textInput || !sendTextBtn || !voiceBtn) {
        console.error('Typing window: Required elements not found');
        return;
    }
    
    let isTypingMode = false;
    
    // Watch for voice button state to show/hide keyboard button
    const observer = new MutationObserver(() => {
        const isRecording = voiceBtn.classList.contains('active');
        keyboardToggle.classList.toggle('visible', isRecording);
        
        if (!isRecording && isTypingMode) {
            toggleTypingWindow();
        }
    });
    
    observer.observe(voiceBtn, {
        attributes: true,
        attributeFilter: ['class']
    });
    
    // Check initial state in case voice button is already active
    if (voiceBtn.classList.contains('active')) {
        keyboardToggle.classList.add('visible');
    }
    
    function toggleTypingWindow() {
        isTypingMode = !isTypingMode;
        typingWindow.classList.toggle('hidden', !isTypingMode);
        keyboardToggle.classList.toggle('active', isTypingMode);
        
        if (isTypingMode) {
            setTimeout(() => {
                textInput.focus();
                // Scroll chat to bottom when typing window opens
                const chatContainer = document.getElementById('chat-container');
                if (chatContainer) {
                    chatContainer.scrollTo({
                        top: chatContainer.scrollHeight,
                        behavior: 'smooth'
                    });
                }
            }, 100);
        }
    }
    
    function autoResize() {
        textInput.style.height = 'auto';
        textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
    }
    
    async function sendMessage() {
        const message = textInput.value.trim();
        if (!message) return;
        
        sendTextBtn.disabled = true;
        
        try {
            // Socket is already available from waitForSocket
            if (!socket) {
                throw new Error('Socket not available. Please refresh the page.');
            }
            
            // Connect if not connected
            if (!socket.connected) {
                socket.connect();
                // Wait for connection
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
                    if (socket.connected) {
                        clearTimeout(timeout);
                        resolve();
                    } else {
                        socket.once('connect', () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    }
                });
            }
            
            // Get chat manager from window (exposed by main.js)
            const chatHistoryManager = window.chatHistoryManager;
            if (!chatHistoryManager) {
                throw new Error('Chat manager not available. Please refresh the page.');
            }
            
            // Check if session is initialized
            if (!window.sessionInitialized) {
                throw new Error('Please start a voice session first by clicking the microphone button');
            }
            
            // Add message to chat
            chatHistoryManager.addTextMessage({
                role: 'USER',
                message: message
            });
            
            // Clear input
            textInput.value = '';
            autoResize();
            
            // Show thinking indicator (exposed by main.js)
            if (window.showAssistantThinkingIndicator) {
                window.showAssistantThinkingIndicator();
            }
            
            // Send to server
            socket.emit('textInput', { content: message });

            // Trigger German learner analysis for typed input (voice triggers via contentEnd)
            if (window.scheduleGermanAnalysisForLastUserTurn) {
                // defer one tick so the message is in the DOM
                setTimeout(() => window.scheduleGermanAnalysisForLastUserTurn(), 0);
            }
            
        } catch (error) {
            console.error('Error sending message:', error);
            
            // Show error in chat
            const chatContainer = document.getElementById('chat-container');
            if (chatContainer) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'message system';
                const warningIcon = document.createElement('span');
                warningIcon.className = 'warning-icon';
                warningIcon.textContent = '⚠️';
                errorDiv.appendChild(warningIcon);
                errorDiv.appendChild(document.createTextNode(' ' + error.message));
                chatContainer.appendChild(errorDiv);
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }
        } finally {
            sendTextBtn.disabled = false;
        }
    }
    
    // Event listeners
    keyboardToggle.addEventListener('click', toggleTypingWindow);
    if (hideTypingBtn) {
        hideTypingBtn.addEventListener('click', toggleTypingWindow);
    }
    textInput.addEventListener('input', autoResize);
    textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    sendTextBtn.addEventListener('click', sendMessage);
});