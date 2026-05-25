import express from 'express';
import http from 'http';
import path from 'path';
import * as tls from 'node:tls';
import { Server } from 'socket.io';
import { NovaSonicBidirectionalStreamClient, StreamSession } from './client';
import { Buffer } from 'node:buffer';
import { AWSConfig } from './consts';
import { analyzeGerman } from './germanAnalysis';
import { summarizeSession } from './sessionSummary';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const DEFAULT_REGION = process.env.AWS_REGION || AWSConfig.defaultRegion;

// ─── Cognito auth ─────────────────────────────────────────────────────────
// The pool + client are configurable via env so a different env can override,
// but the defaults match the existing daily-deutsch user pool.
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'us-east-1_dqBKmK639';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || '2uspue6gjg3dug6ugsprcj3u23';
const COGNITO_REGION = process.env.COGNITO_REGION || 'us-east-1';
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';   // local-only escape hatch

const jwtVerifier = AUTH_DISABLED ? null : CognitoJwtVerifier.create({
    userPoolId: COGNITO_USER_POOL_ID,
    tokenUse: 'id',
    clientId: COGNITO_CLIENT_ID,
});

async function verifyJwt(token: string | undefined): Promise<{ sub: string; email?: string } | null> {
    if (!token) return null;
    if (!jwtVerifier) return { sub: 'auth-disabled', email: 'local@dev' };
    try {
        const payload = await jwtVerifier.verify(token);
        return { sub: payload.sub as string, email: payload.email as string | undefined };
    } catch (err) {
        return null;
    }
}

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Store clients per region
const regionClients = new Map<string, NovaSonicBidirectionalStreamClient>();

// Get or create a client for a specific region
function getClientForRegion(region: string): NovaSonicBidirectionalStreamClient {
    if (!regionClients.has(region)) {
        console.log(`Creating new Bedrock client for region: ${region}`);
        
        // AWS SDK automatically uses credential chain:
        // 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
        // 2. Shared credentials file (uses AWS_PROFILE env var if set, otherwise 'default')
        // 3. ECS container credentials
        // 4. EC2 instance metadata (IAM role)
        const client = new NovaSonicBidirectionalStreamClient({
            requestHandlerConfig: {
                maxConcurrentStreams: 10,
            },
            clientConfig: {
                region: region
                // credentials omitted - SDK uses default chain
            }
        });
        regionClients.set(region, client);
    }
    return regionClients.get(region)!;
}

// Initialize default region client
const defaultClient = getClientForRegion(DEFAULT_REGION);

// Track active sessions per socket
const socketSessions = new Map<string, StreamSession>();
const socketClients = new Map<string, NovaSonicBidirectionalStreamClient>();
const socketConfigs = new Map<string, any>();

// Session states
enum SessionState {
    INITIALIZING = 'initializing',
    READY = 'ready',
    ACTIVE = 'active',
    CLOSED = 'closed'
}

const sessionStates = new Map<string, SessionState>();
const cleanupInProgress = new Map<string, boolean>();

// ─── Idle sweeper ─────────────────────────────────────────────────────────
// Drop sessions that have had no audio for 90 seconds. Nova Sonic charges for the
// open socket, so a forgotten tab is real money. The client also warns at 60s of silence.
const IDLE_TIMEOUT_MS = 90 * 1000;
setInterval(() => {
    const now = Date.now();
    regionClients.forEach((client, region) => {
        client.getActiveSessions().forEach(sessionId => {
            const lastActivity = client.getLastActivityTime(sessionId);
            if (now - lastActivity > IDLE_TIMEOUT_MS) {
                console.log(`Closing idle session ${sessionId} in region ${region} (no activity for ${Math.round((now - lastActivity) / 1000)}s)`);
                try {
                    // Notify the client first so the UI can show a clear message
                    const sock = io.sockets.sockets.get(sessionId);
                    if (sock) sock.emit('idleTimeout', { reason: 'No audio for 90 seconds. Session paused to save credits.' });
                    client.forceCloseSession(sessionId);
                } catch (error) {
                    console.error('Error force closing idle session %s:', sessionId, error);
                }
            }
        });
    });
}, 15000);  // check every 15s instead of 60s — keeps the response snappy

// ─── Per-user daily usage tracking (10-minute ceiling) ─────────────────────
// Keyed by Cognito sub. Persisted to a JSON file so restarts within the same UTC day
// preserve users' usage and don't accidentally give them another full budget.
const DAILY_CEILING_SECONDS = 10 * 60;
const USAGE_FILE = process.env.USAGE_FILE || '/tmp/speechlab-usage.json';
type UsageEntry = { date: string; secondsUsed: number };
const userUsage = new Map<string, UsageEntry>();
const userToSocketId = new Map<string, string>();   // Cognito sub → live socket.id (one at a time)

function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
}

function getUserUsageSeconds(sub: string): number {
    const entry = userUsage.get(sub);
    if (!entry || entry.date !== todayUtc()) return 0;
    return entry.secondsUsed;
}

function addUserUsageSeconds(sub: string, seconds: number): number {
    const today = todayUtc();
    const entry = userUsage.get(sub);
    if (!entry || entry.date !== today) {
        userUsage.set(sub, { date: today, secondsUsed: seconds });
    } else {
        entry.secondsUsed += seconds;
    }
    return userUsage.get(sub)!.secondsUsed;
}

// Load + persist (best-effort). Single-task Fargate setup; for multi-task we'd move to DynamoDB.
(function loadUsage() {
    try {
        const fs = require('fs');
        if (fs.existsSync(USAGE_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
            const today = todayUtc();
            for (const [sub, entry] of Object.entries(parsed)) {
                if ((entry as UsageEntry).date === today) {
                    userUsage.set(sub, entry as UsageEntry);
                }
            }
            console.log(`Loaded ${userUsage.size} active usage entries for ${today}`);
        }
    } catch (err) {
        console.warn('Failed to load usage file:', err);
    }
})();

setInterval(() => {
    try {
        const fs = require('fs');
        const out: Record<string, UsageEntry> = {};
        userUsage.forEach((entry, sub) => { out[sub] = entry; });
        fs.writeFileSync(USAGE_FILE, JSON.stringify(out));
    } catch (err) {
        // non-fatal — usage just resets on restart
    }
}, 30000);

// Serve static files from the public directory
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.json({ limit: '64kb' }));

// Public bootstrap endpoint — the browser fetches this BEFORE login to know which
// Cognito pool/client to use. Returns no secrets.
app.get('/api/auth-config', (_req, res) => {
    res.status(200).json({
        userPoolId: COGNITO_USER_POOL_ID,
        clientId: COGNITO_CLIENT_ID,
        region: COGNITO_REGION,
        authDisabled: AUTH_DISABLED,
    });
});

// Auth gate for all other /api/* routes (auth-config above is matched first, /health is outside /api)
app.use('/api', async (req, res, next) => {
    if (req.path === '/auth-config') return next();   // belt-and-suspenders
    if (AUTH_DISABLED) return next();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.substring(7) : undefined;
    const claims = await verifyJwt(token);
    if (!claims) {
        res.status(401).json({ error: 'auth required' });
        return;
    }
    (req as any).user = claims;
    next();
});

// Socket.IO auth middleware — runs before connection
io.use(async (socket, next) => {
    if (AUTH_DISABLED) return next();
    const token = (socket.handshake.auth as any)?.token as string | undefined;
    const claims = await verifyJwt(token);
    if (!claims) {
        next(new Error('Unauthorized'));
        return;
    }
    (socket.data as any).user = claims;
    next();
});

// End-of-session report — combined coaching summary + persistent learner profile delta
app.post('/api/end-session', async (req, res) => {
    try {
        const { transcript, language, cefr, previousProfile } = req.body || {};
        if (!Array.isArray(transcript) || transcript.length === 0) {
            res.status(400).json({ error: 'transcript required (non-empty array)' });
            return;
        }
        const result = await summarizeSession(transcript, language || 'de', cefr || 'a1', previousProfile);
        res.status(200).json(result);
    } catch (error) {
        console.error('end-session error:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

// German learner analysis endpoint — returns inline-style corrections + summary for a single utterance
app.post('/api/analyze-german', async (req, res) => {
    try {
        const { text, cefr, scenario, scenarioSteps, transcriptSoFar, language } = req.body || {};
        if (!text || typeof text !== 'string' || !text.trim()) {
            res.status(400).json({ error: 'text required' });
            return;
        }
        const result = await analyzeGerman(
            text.trim(),
            cefr || 'a1',
            scenario,
            Array.isArray(scenarioSteps) ? scenarioSteps : undefined,
            typeof transcriptSoFar === 'string' ? transcriptSoFar : undefined,
            language || 'de'
        );
        res.status(200).json(result);
    } catch (error) {
        console.error('analyze-german error:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

// Helper function to create and initialize a new session
async function createNewSession(socket: any, config: any = {}): Promise<StreamSession> {
    const sessionId = socket.id;
    const region = config.region || DEFAULT_REGION;
    const client = getClientForRegion(region);

    try {
        console.log(`Creating new session for client: ${sessionId} in region: ${region}`);
        sessionStates.set(sessionId, SessionState.INITIALIZING);

        // Create session with inference config and turn detection if provided
        const sessionConfig: any = {};
        
        if (config.inferenceConfig) {
            sessionConfig.inferenceConfig = {
                maxTokens: config.inferenceConfig.maxTokens || 2048,
                topP: config.inferenceConfig.topP || 0.9,
                temperature: config.inferenceConfig.temperature || 1,
            };
        }

        if (config.turnDetectionConfig?.endpointingSensitivity) {
            sessionConfig.turnDetectionConfig = {
                endpointingSensitivity: config.turnDetectionConfig.endpointingSensitivity
            };
        }

        // Pass enabled tools filter
        if (config.enabledTools && Array.isArray(config.enabledTools)) {
            sessionConfig.enabledTools = config.enabledTools;
        }

        const session = client.createStreamSession(sessionId, Object.keys(sessionConfig).length > 0 ? sessionConfig : undefined);
        setupSessionEventHandlers(session, socket);

        socketSessions.set(sessionId, session);
        socketClients.set(sessionId, client);
        socketConfigs.set(sessionId, config);
        sessionStates.set(sessionId, SessionState.READY);

        console.log(`Session ${sessionId} created and ready`);
        return session;
    } catch (error) {
        console.error('Error creating session for %s:', sessionId, error);
        sessionStates.set(sessionId, SessionState.CLOSED);
        throw error;
    }
}

// Helper function to set up event handlers for a session
function setupSessionEventHandlers(session: StreamSession, socket: any) {
    session.onEvent('usageEvent', (data) => {
        socket.emit('usageEvent', data);
    });

    session.onEvent('completionStart', (data) => {
        console.log('completionStart:', data);
        socket.emit('completionStart', data);
    });

    session.onEvent('contentStart', (data) => {
        const { audioOutputConfiguration, ...logData } = data;
        console.log('contentStart:', logData);
        socket.emit('contentStart', data);
    });

    session.onEvent('textOutput', (data) => {
        console.log('Text output:', data);
        socket.emit('textOutput', data);
    });

    session.onEvent('audioOutput', (data) => {
        socket.emit('audioOutput', data);
    });

    session.onEvent('error', (data) => {
        console.error('Error in session:', data);
        socket.emit('error', data);
    });

    session.onEvent('toolUse', (data) => {
        const params = data.toolUseContent?.content ? JSON.parse(data.toolUseContent.content) : data.toolUseContent;
        console.log('[Event] Tool requested: %s', data.toolName, params ? 'params: ' + JSON.stringify(params) : '');
        socket.emit('toolUse', data);
    });

    session.onEvent('toolResult', (data) => {
        console.log(`[Event] Tool result ready for ${data.toolUseId?.substring(0, 8)}...`);
        socket.emit('toolResult', data);
    });

    session.onEvent('contentEnd', (data) => {
        console.log('Content end received: ', data);
        socket.emit('contentEnd', data);
    });

    session.onEvent('bargeIn', (data) => {
        console.log('Barge-in detected:', data);
        socket.emit('bargeIn', data);
    });

    session.onEvent('streamComplete', () => {
        console.log('Stream completed for client:', socket.id);
        socket.emit('streamComplete');
        sessionStates.set(socket.id, SessionState.CLOSED);
    });

    session.onEvent('streamInterrupted', (data) => {
        console.log('Stream interrupted for client:', socket.id, data);
        // Don't emit streamComplete - just log it
        // The audio might still be playing on the client
        socket.emit('streamInterrupted', data);
    });
}

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    sessionStates.set(socket.id, SessionState.CLOSED);

    // ── Concurrent-session limit: at most one socket per Cognito user. New sockets kick old ones. ──
    const user = (socket.data as any).user as { sub: string; email?: string } | undefined;
    if (user?.sub) {
        const previousSocketId = userToSocketId.get(user.sub);
        if (previousSocketId && previousSocketId !== socket.id) {
            const oldSock = io.sockets.sockets.get(previousSocketId);
            if (oldSock) {
                console.log(`User ${user.sub} opened a new socket; closing the previous one (${previousSocketId})`);
                oldSock.emit('replacedByNewSession', { reason: 'You opened a new tab. Switching to it.' });
                oldSock.disconnect(true);
            }
        }
        userToSocketId.set(user.sub, socket.id);

        // ── Daily ceiling enforcement on connect ──
        const usedSec = getUserUsageSeconds(user.sub);
        if (usedSec >= DAILY_CEILING_SECONDS) {
            socket.emit('dailyLimitReached', {
                usedSeconds: usedSec,
                limitSeconds: DAILY_CEILING_SECONDS,
                message: "You've reached today's 10-minute practice limit. Come back tomorrow!",
            });
            // Don't disconnect immediately — give the client time to render the modal — then close.
            setTimeout(() => socket.disconnect(true), 1500);
        }
    }

    // Per-socket "remaining seconds at start of session" — used to emit countdown updates
    let lastUsageEmit = 0;
    function emitUsageUpdate(force = false) {
        if (!user?.sub) return;
        const now = Date.now();
        if (!force && now - lastUsageEmit < 5000) return;
        lastUsageEmit = now;
        const used = getUserUsageSeconds(user.sub);
        socket.emit('usageUpdate', {
            usedSeconds: used,
            limitSeconds: DAILY_CEILING_SECONDS,
            remainingSeconds: Math.max(0, DAILY_CEILING_SECONDS - used),
        });
    }
    emitUsageUpdate(true);
    (socket as any).__emitUsageUpdate = emitUsageUpdate;

    const connectionInterval = setInterval(() => {
        const connectionCount = Object.keys(io.sockets.sockets).length;
        console.log(`Active socket connections: ${connectionCount}`);
    }, 60000);

    // Handle session initialization request with config
    socket.on('initializeConnection', async (data, callback) => {
        try {
            // Handle both old (callback only) and new (data + callback) signatures
            let config = {};
            let cb = callback;
            
            if (typeof data === 'function') {
                cb = data;
            } else if (data && typeof data === 'object') {
                config = data;
            }

            const currentState = sessionStates.get(socket.id);
            console.log('Initializing session for %s, current state: %s, config:', socket.id, currentState, config);
            
            if (currentState === SessionState.INITIALIZING || currentState === SessionState.READY || currentState === SessionState.ACTIVE) {
                console.log(`Session already exists for ${socket.id}, state: ${currentState}`);
                if (cb) cb({ success: true });
                return;
            }

            await createNewSession(socket, config);
            
            // Note: Don't start bidirectional streaming here!
            // Wait for audioStart event which signals all setup events are queued

            sessionStates.set(socket.id, SessionState.READY);
            if (cb) cb({ success: true });

        } catch (error) {
            console.error('Error initializing session:', error);
            sessionStates.set(socket.id, SessionState.CLOSED);
            const cb = typeof data === 'function' ? data : callback;
            if (cb) cb({ success: false, error: error instanceof Error ? error.message : String(error) });
            socket.emit('error', {
                message: 'Failed to initialize session',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Handle starting a new chat
    socket.on('startNewChat', async (config = {}) => {
        try {
            const currentState = sessionStates.get(socket.id);
            console.log(`Starting new chat for ${socket.id}, current state: ${currentState}`);

            const existingSession = socketSessions.get(socket.id);
            const client = socketClients.get(socket.id) || defaultClient;
            
            if (existingSession && client.isSessionActive(socket.id)) {
                console.log(`Cleaning up existing session for ${socket.id}`);
                try {
                    await existingSession.endAudioContent();
                    await existingSession.endPrompt();
                    await existingSession.close();
                } catch (cleanupError) {
                    console.error('Error during cleanup for %s:', socket.id, cleanupError);
                    client.forceCloseSession(socket.id);
                }
                socketSessions.delete(socket.id);
            }

            await createNewSession(socket, config);
        } catch (error) {
            console.error('Error starting new chat:', error);
            socket.emit('error', {
                message: 'Failed to start new chat',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Audio input handler
    // Tracks per-user audio time (16kHz mono int16 PCM → bytes / 32000 = seconds) toward
    // the 10-minute daily ceiling. When the ceiling is hit we gracefully close the session.
    socket.on('audioInput', async (audioData) => {
        try {
            const session = socketSessions.get(socket.id);
            const currentState = sessionStates.get(socket.id);

            if (!session || currentState !== SessionState.ACTIVE) {
                console.error(`Invalid session state for audio input: session=${!!session}, state=${currentState}`);
                socket.emit('error', {
                    message: 'No active session for audio input',
                    details: `Session exists: ${!!session}, Session state: ${currentState}.`
                });
                return;
            }

            const audioBuffer = typeof audioData === 'string'
                ? Buffer.from(audioData, 'base64')
                : Buffer.from(audioData);

            // Account for the audio seconds this packet represents.
            // Default capture: 16kHz mono int16 → 32000 bytes/sec.
            if (user?.sub) {
                const secondsInThisChunk = audioBuffer.length / 32000;
                const totalUsed = addUserUsageSeconds(user.sub, secondsInThisChunk);
                (socket as any).__emitUsageUpdate?.();
                if (totalUsed >= DAILY_CEILING_SECONDS) {
                    socket.emit('dailyLimitReached', {
                        usedSeconds: totalUsed,
                        limitSeconds: DAILY_CEILING_SECONDS,
                        message: "You've reached today's 10-minute practice limit. Come back tomorrow!",
                    });
                    sessionStates.set(socket.id, SessionState.CLOSED);
                    try {
                        await session.endAudioContent();
                        await session.endPrompt();
                        await session.close();
                    } catch {}
                    socketSessions.delete(socket.id);
                    return;
                }
            }

            await session.streamAudio(audioBuffer);
        } catch (error) {
            console.error('Error processing audio:', error);
            socket.emit('error', {
                message: 'Error processing audio',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.on('promptStart', async (data) => {
        try {
            const session = socketSessions.get(socket.id);
            if (!session) {
                socket.emit('error', { message: 'No active session for prompt start' });
                return;
            }
            const voiceId = data?.voiceId;
            const outputSampleRate = data?.outputSampleRate || 24000;
            await session.setupSessionAndPromptStart(voiceId, outputSampleRate);
            console.log(`Prompt start completed for ${socket.id} with sample rate ${outputSampleRate}`);
        } catch (error) {
            console.error('Error processing prompt start:', error);
            socket.emit('error', {
                message: 'Error processing prompt start',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.on('systemPrompt', async (data) => {
        try {
            const session = socketSessions.get(socket.id);
            if (!session) {
                socket.emit('error', { message: 'No active session for system prompt' });
                return;
            }

            // Handle both string (old) and object (new) formats
            let promptContent: string;
            let voiceId: string | undefined;
            
            if (typeof data === 'string') {
                promptContent = data;
            } else if (data && typeof data === 'object') {
                promptContent = data.content || data;
                voiceId = data.voiceId;
            } else {
                promptContent = data;
            }

            await session.setupSystemPrompt(undefined, promptContent, voiceId);
            console.log(`System prompt completed for ${socket.id}`);
        } catch (error) {
            console.error('Error processing system prompt:', error);
            socket.emit('error', {
                message: 'Error processing system prompt',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.on('audioStart', async () => {
        try {
            const session = socketSessions.get(socket.id);
            if (!session) {
                socket.emit('error', { message: 'No active session for audio start' });
                return;
            }

            await session.setupStartAudio();
            console.log(`Audio start setup completed for ${socket.id}`);
            
            // Now that all setup events are queued (sessionStart, promptStart, systemPrompt, audioStart),
            // start the bidirectional streaming
            const client = socketClients.get(socket.id) || defaultClient;
            console.log(`Starting AWS Bedrock connection for ${socket.id}`);
            client.initiateBidirectionalStreaming(socket.id);
            
            sessionStates.set(socket.id, SessionState.ACTIVE);
            socket.emit('audioReady');
        } catch (error) {
            console.error('Error processing audio start:', error);
            sessionStates.set(socket.id, SessionState.CLOSED);
            socket.emit('error', {
                message: 'Error processing audio start',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Text input handler (for typing mode)
    socket.on('textInput', async (data) => {
        try {
            const session = socketSessions.get(socket.id);
            if (!session) {
                socket.emit('error', { message: 'No active session for text input' });
                return;
            }

            const client = socketClients.get(socket.id) || defaultClient;
            const currentState = sessionStates.get(socket.id);

            // If session is ready but not active, start streaming first
            if (currentState === SessionState.READY) {
                client.initiateBidirectionalStreaming(socket.id);
                sessionStates.set(socket.id, SessionState.ACTIVE);
            }

            // Send text input to the model
            await session.sendTextInput(data.content);
        } catch (error) {
            console.error('Error processing text input:', error);
            socket.emit('error', {
                message: 'Error processing text input',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.on('stopAudio', async () => {
        try {
            const session = socketSessions.get(socket.id);
            const client = socketClients.get(socket.id) || defaultClient;
            
            if (!session || cleanupInProgress.get(socket.id)) {
                console.log('No active session to stop or cleanup already in progress');
                socket.emit('sessionClosed'); // Still emit so client doesn't hang
                return;
            }

            console.log('Stop audio requested, beginning proper shutdown sequence');
            cleanupInProgress.set(socket.id, true);
            sessionStates.set(socket.id, SessionState.CLOSED);

            const cleanupPromise = Promise.race([
                (async () => {
                    await session.endAudioContent();
                    await session.endPrompt();
                    await session.close();
                    console.log('Session cleanup complete');
                })(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Session cleanup timeout')), 5000)
                )
            ]);

            await cleanupPromise;

            socketSessions.delete(socket.id);
            socketClients.delete(socket.id);
            socketConfigs.delete(socket.id);
            cleanupInProgress.delete(socket.id);

            socket.emit('sessionClosed');
        } catch (error) {
            console.error('Error processing streaming end events:', error);

            try {
                const client = socketClients.get(socket.id) || defaultClient;
                client.forceCloseSession(socket.id);
                socketSessions.delete(socket.id);
                socketClients.delete(socket.id);
                socketConfigs.delete(socket.id);
                cleanupInProgress.delete(socket.id);
                sessionStates.set(socket.id, SessionState.CLOSED);
            } catch (forceError) {
                console.error('Error during force cleanup:', forceError);
            }

            // Always emit sessionClosed so client can proceed with renewal
            socket.emit('sessionClosed');
            socket.emit('error', {
                message: 'Error processing streaming end events',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    socket.on('disconnect', async () => {
        console.log('Client disconnected:', socket.id);
        // Drop the user→socket entry only if this socket is still the one we have on file
        // (a newer one may have already replaced it).
        if (user?.sub && userToSocketId.get(user.sub) === socket.id) {
            userToSocketId.delete(user.sub);
        }
        clearInterval(connectionInterval);

        const session = socketSessions.get(socket.id);
        const client = socketClients.get(socket.id) || defaultClient;
        const sessionId = socket.id;

        if (session && client.isSessionActive(sessionId) && !cleanupInProgress.get(socket.id)) {
            try {
                console.log(`Beginning cleanup for disconnected session: ${socket.id}`);
                cleanupInProgress.set(socket.id, true);

                const cleanupPromise = Promise.race([
                    (async () => {
                        await session.endAudioContent();
                        await session.endPrompt();
                        await session.close();
                    })(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Session cleanup timeout')), 3000)
                    )
                ]);

                await cleanupPromise;
                console.log(`Successfully cleaned up session: ${socket.id}`);
            } catch (error) {
                console.error('Error cleaning up session: %s', socket.id, error);
                try {
                    client.forceCloseSession(sessionId);
                } catch (e) {
                    console.error('Failed force close for session: %s', sessionId, e);
                }
            }
        }

        socketSessions.delete(socket.id);
        socketClients.delete(socket.id);
        socketConfigs.delete(socket.id);
        sessionStates.delete(socket.id);
        cleanupInProgress.delete(socket.id);

        console.log(`Cleanup complete for client: ${socket.id}`);
    });
});

// Region latency probe — measures TCP+TLS handshake time to Bedrock runtime endpoint per region.
// No Bedrock API call (no cost, no auth), but reflects the round-trip the streaming session pays.
async function measureRegionLatency(region: string, samples = 3, timeoutMs = 4000): Promise<number> {
    const host = `bedrock-runtime.${region}.amazonaws.com`;
    const results: number[] = [];
    for (let i = 0; i < samples; i++) {
        const elapsed = await new Promise<number>((resolve, reject) => {
            const start = Date.now();
            const socket = tls.connect({ host, port: 443, servername: host }, () => {
                const ms = Date.now() - start;
                socket.end();
                resolve(ms);
            });
            socket.setTimeout(timeoutMs, () => {
                socket.destroy();
                reject(new Error('timeout'));
            });
            socket.once('error', (err) => reject(err));
        });
        results.push(elapsed);
    }
    results.sort((a, b) => a - b);
    return results[Math.floor(results.length / 2)];
}

type LatencyResult = { results: Array<{region: string, latencyMs: number | null, error?: string}>, measuredAt: number };
let latencyCache: LatencyResult | null = null;
const LATENCY_CACHE_TTL_MS = 60 * 1000;
let latencyMeasurementInFlight: Promise<LatencyResult> | null = null;

async function probeAllRegions(): Promise<LatencyResult> {
    const results = await Promise.all(
        AWSConfig.availableRegions.map(async (region) => {
            try {
                const latencyMs = await measureRegionLatency(region);
                return { region, latencyMs };
            } catch (error) {
                return { region, latencyMs: null, error: error instanceof Error ? error.message : String(error) };
            }
        })
    );
    latencyCache = { results, measuredAt: Date.now() };
    return latencyCache;
}

app.get('/api/region-latency', async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const cacheFresh = latencyCache && (Date.now() - latencyCache.measuredAt < LATENCY_CACHE_TTL_MS);
    if (!refresh && cacheFresh) {
        res.status(200).json(latencyCache);
        return;
    }
    try {
        if (!latencyMeasurementInFlight) {
            latencyMeasurementInFlight = probeAllRegions().finally(() => {
                latencyMeasurementInFlight = null;
            });
        }
        const fresh = await latencyMeasurementInFlight;
        res.status(200).json(fresh);
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

// Get available tools endpoint
app.get('/api/tools', (_req, res) => {
    const client = getClientForRegion(DEFAULT_REGION);
    const toolSpecs = client.getToolRegistry().getToolSpecs();
    const tools = toolSpecs.map(t => ({
        name: t.toolSpec.name,
        description: t.toolSpec.description
    }));
    res.status(200).json({ tools });
});

// Health check endpoint
app.get('/health', (_req, res) => {
    let totalActiveSessions = 0;
    regionClients.forEach(client => {
        totalActiveSessions += client.getActiveSessions().length;
    });

    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeSessions: totalActiveSessions,
        socketConnections: Object.keys(io.sockets.sockets).length,
        regions: Array.from(regionClients.keys())
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
server.listen(Number(PORT), HOST, () => {
    console.log(`Server listening on ${HOST}:${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});

process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    const forceExitTimer = setTimeout(() => {
        console.error('Forcing server shutdown after timeout');
        process.exit(1);
    }, 5000);

    try {
        await new Promise(resolve => io.close(resolve));
        console.log('Socket.IO server closed');

        for (const [region, client] of regionClients) {
            const activeSessions = client.getActiveSessions();
            console.log(`Closing ${activeSessions.length} sessions in region ${region}...`);

            await Promise.all(activeSessions.map(async (sessionId) => {
                try {
                    await client.closeSession(sessionId);
                } catch (error) {
                    console.error('Error closing session %s:', sessionId, error);
                    client.forceCloseSession(sessionId);
                }
            }));
        }

        await new Promise(resolve => server.close(resolve));
        clearTimeout(forceExitTimer);
        console.log('Server shut down');
        process.exit(0);
    } catch (error) {
        console.error('Error during server shutdown:', error);
        process.exit(1);
    }
});
