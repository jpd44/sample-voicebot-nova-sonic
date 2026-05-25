// Cognito sign-in for SpeechLab. Uses amazon-cognito-identity-js via ESM CDN — no bundler.
// Flow:
//   1. Fetch /api/auth-config to learn the pool/client IDs.
//   2. Render a login form gate. Block the rest of the app until success.
//   3. On submit, do SRP auth with Cognito. Get an idToken.
//   4. Stash the idToken in memory + sessionStorage so other modules can grab it.
//   5. Expose window.__authToken() for the rest of the app to read.

import {
    CognitoUserPool,
    CognitoUser,
    AuthenticationDetails,
    CognitoUserSession,
} from 'https://esm.sh/amazon-cognito-identity-js@6.3.12';

const TOKEN_KEY = 'speechlab.idToken';
const EMAIL_KEY = 'speechlab.email';

let currentToken = null;
let currentEmail = null;
let userPool = null;
let authConfig = null;
let onAuthenticatedCallback = null;

function setToken(token, email) {
    currentToken = token;
    currentEmail = email || null;
    if (token) {
        sessionStorage.setItem(TOKEN_KEY, token);
        if (email) sessionStorage.setItem(EMAIL_KEY, email);
    } else {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(EMAIL_KEY);
    }
}

function readStoredToken() {
    currentToken = sessionStorage.getItem(TOKEN_KEY);
    currentEmail = sessionStorage.getItem(EMAIL_KEY);
}

window.__authToken = () => currentToken;
window.__authEmail = () => currentEmail;

async function fetchAuthConfig() {
    if (authConfig) return authConfig;
    const r = await fetch('/api/auth-config');
    if (!r.ok) throw new Error('Failed to load auth config');
    authConfig = await r.json();
    userPool = new CognitoUserPool({
        UserPoolId: authConfig.userPoolId,
        ClientId: authConfig.clientId,
    });
    return authConfig;
}

function signIn(email, password) {
    return new Promise((resolve, reject) => {
        const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });
        const authDetails = new AuthenticationDetails({ Username: email, Password: password });
        cognitoUser.authenticateUser(authDetails, {
            onSuccess: (session) => resolve(session),
            onFailure: (err) => reject(err),
            newPasswordRequired: () => reject(new Error('Password change required. Sign in via daily-deutsch.com first to set a new password.')),
        });
    });
}

function tryRefreshFromStorage() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    // Decode without verifying — just to see if it's expired. Server verifies on each call.
    try {
        const [, payload] = token.split('.');
        const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
        const nowSec = Math.floor(Date.now() / 1000);
        if (claims.exp && claims.exp > nowSec + 30) {
            return token;   // still good for at least 30 more seconds
        }
    } catch {}
    return null;
}

function renderGate(onAuthenticated) {
    onAuthenticatedCallback = onAuthenticated;
    const gate = document.getElementById('auth-gate');
    if (!gate) return;

    gate.classList.remove('hidden');
    document.getElementById('app')?.classList.add('auth-hidden');

    const form = document.getElementById('auth-form');
    const errorEl = document.getElementById('auth-error');
    const submitBtn = document.getElementById('auth-submit');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.textContent = '';
        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing in…';
        try {
            const email = document.getElementById('auth-email').value.trim();
            const password = document.getElementById('auth-password').value;
            const session = await signIn(email, password);
            const idToken = session.getIdToken().getJwtToken();
            const idPayload = session.getIdToken().payload || {};
            setToken(idToken, idPayload.email || email);
            hideGate();
            onAuthenticatedCallback?.();
        } catch (err) {
            errorEl.textContent = err?.message || 'Sign-in failed';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Sign in';
        }
    });
}

function hideGate() {
    document.getElementById('auth-gate')?.classList.add('hidden');
    document.getElementById('app')?.classList.remove('auth-hidden');
    const headerInfo = document.getElementById('auth-user-info');
    if (headerInfo && currentEmail) {
        headerInfo.textContent = currentEmail;
        headerInfo.classList.remove('hidden');
    }
}

function signOut() {
    setToken(null, null);
    // Reload so all per-conversation state resets cleanly
    window.location.reload();
}

window.__signOut = signOut;

// Public entrypoint. Returns once the user is authenticated (either via stored token or fresh login).
export async function ensureAuthenticated() {
    const cfg = await fetchAuthConfig();
    if (cfg.authDisabled) {
        // No-op when running locally with AUTH_DISABLED=1
        return;
    }
    readStoredToken();
    const stored = tryRefreshFromStorage();
    if (stored) {
        setToken(stored, currentEmail);
        hideGate();
        return;
    }
    // Need fresh login
    await new Promise((resolve) => renderGate(resolve));
}
