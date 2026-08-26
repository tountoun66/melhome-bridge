const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ------------------------------------------------------------------
// MELCLOUD HOME OAUTH / PERSISTENCE
// ------------------------------------------------------------------
const AUTH_BASE = 'https://auth.melcloudhome.com';
const TOKEN_URL = `${AUTH_BASE}/connect/token`;
const API_BASE = 'https://api.melcloudhome.com/api/v1';
const CLIENT_ID = 'mobile';

const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
      })
    : null;

const oauthSession = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0
};

let pairCodes = {};
let cachedDevices = [];
let lastCacheTime = 0;
const CACHE_TTL = 30000;
const MAX_PAIR_AGE_MS = 10 * 60 * 1000;
let dbReady = false;

async function initDatabase() {
    if (!pool) {
        console.warn('[DB] DATABASE_URL absent : OAuth restera en mémoire.');
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS melhome_oauth_session (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                access_token TEXT,
                refresh_token TEXT NOT NULL,
                expires_at BIGINT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        const result = await pool.query(
            'SELECT access_token, refresh_token, expires_at FROM melhome_oauth_session WHERE id = 1'
        );

        if (result.rows.length) {
            const row = result.rows[0];
            oauthSession.accessToken = row.access_token || null;
            oauthSession.refreshToken = row.refresh_token || null;
            oauthSession.expiresAt = Number(row.expires_at) || 0;
            console.log('[DB] Session OAuth restaurée.');
        } else {
            console.log('[DB] Aucune session OAuth persistante.');
        }
        dbReady = true;
    } catch (error) {
        console.error('[DB] Initialisation impossible :', error.message);
    }
}

async function persistOAuthSession() {
    if (!pool || !oauthSession.refreshToken) return;

    await pool.query(
        `INSERT INTO melhome_oauth_session (id, access_token, refresh_token, expires_at, updated_at)
         VALUES (1, $1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE SET
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [oauthSession.accessToken, oauthSession.refreshToken, oauthSession.expiresAt]
    );
}

async function saveOAuthSession(token) {
    if (!token?.refresh_token) throw new Error('Réponse OAuth sans refresh_token');

    oauthSession.accessToken = token.access_token || null;
    oauthSession.refreshToken = token.refresh_token;
    oauthSession.expiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;

    await persistOAuthSession();
}

async function refreshOAuthSession(force = false) {
    if (!oauthSession.refreshToken) return false;

    const refreshWindowMs = 5 * 60 * 1000;
    if (!force && oauthSession.accessToken && oauthSession.expiresAt > Date.now() + refreshWindowMs) {
        return true;
    }

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: oauthSession.refreshToken
    });

    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString()
    });

    if (!response.ok) {
        const text = await response.text();
        console.error(`[OAUTH] Refresh refusé (${response.status}): ${text.slice(0, 300)}`);
        return false;
    }

    const token = await response.json();
    if (!token.refresh_token) token.refresh_token = oauthSession.refreshToken;
    await saveOAuthSession(token);
    console.log('[OAUTH] Access token renouvelé et session persistée.');
    return true;
}

async function getAccessToken() {
    if (await refreshOAuthSession(false)) return oauthSession.accessToken;
    return null;
}

function clearCache() {
    cachedDevices = [];
    lastCacheTime = 0;
}

function makePairCode(value) {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    pairCodes[code] = { value, createdAt: Date.now() };
    return code;
}

function getPairValue(code) {
    const entry = pairCodes[code];
    if (!entry) return null;
    if (Date.now() - entry.createdAt > MAX_PAIR_AGE_MS) {
        delete pairCodes[code];
        return null;
    }
    return entry.value;
}

function extractXsrf(cookieStr) {
    if (!cookieStr) return '1';
    const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/i);
    if (!match) return '1';
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function getSetting(clim, keys) {
    for (const key of keys) {
        if (clim[key] !== undefined && clim[key] !== null) return clim[key];
    }
    const containers = [];
    if (Array.isArray(clim.settings)) containers.push(clim.settings);
    if (Array.isArray(clim.unitSettings)) containers.push(clim.unitSettings);

    for (const container of containers) {
        for (const item of container) {
            const itemName = String(item.name || item.Name || '').toLowerCase();
            if (keys.some(k => k.toLowerCase() === itemName)) {
                if (item.value !== undefined && item.value !== null) return item.value;
                if (item.Value !== undefined && item.Value !== null) return item.Value;
            }
        }
    }
    return null;
}

function isPoweredOn(clim) {
    const val = getSetting(clim, ['power', 'Power']);
    return val === true || String(val).toLowerCase() === 'true';
}

function getRoomTemp(clim) {
    const val = getSetting(clim, ['roomTemperature', 'RoomTemperature', 'indoorTemperature', 'IndoorTemperature']);
    const num = parseFloat(val);
    return Number.isFinite(num) && num > 0 && num < 60 ? num : 20.0;
}

function getTemp(clim) {
    const val = getSetting(clim, ['setTemperature', 'SetTemperature', 'targetTemperature', 'TargetTemperature', 'defaultTemperature']);
    const num = parseFloat(val);
    return Number.isFinite(num) && num > 0 && num < 60 ? num : 20.0;
}

function getGoogleMode(clim) {
    if (!isPoweredOn(clim)) return 'off';
    const mode = String(getSetting(clim, ['operationMode', 'OperationMode']) || 'Automatic').toLowerCase();
    if (mode.includes('cool')) return 'cool';
    if (mode.includes('heat')) return 'heat';
    if (mode.includes('dry')) return 'dry';
    if (mode.includes('fan')) return 'fan-only';
    return 'auto';
}

function getGoogleFanSpeed(clim) {
    const val = getSetting(clim, ['setFanSpeed', 'SetFanSpeed', 'fanSpeed', 'FanSpeed']);
    if (val === undefined || val === null) return 'Auto';
    const str = String(val).toLowerCase();
    if (str.includes('one') || str === '1') return 'One';
    if (str.includes('two') || str === '2') return 'Two';
    if (str.includes('three') || str === '3') return 'Three';
    if (str.includes('four') || str === '4') return 'Four';
    if (str.includes('five') || str === '5') return 'Five';
    return 'Auto';
}

async function fetchWithOAuth(path, options = {}) {
    const accessToken = await getAccessToken();
    if (!accessToken) return null;

    let response = await fetch(`${API_BASE}/${path.replace(/^\//, '')}`, {
        ...options,
        headers: {
            Accept: 'application/json, text/plain, */*',
            ...(options.headers || {}),
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (response.status === 401) {
        const refreshed = await refreshOAuthSession(true);
        if (!refreshed) return response;
        response = await fetch(`${API_BASE}/${path.replace(/^\//, '')}`, {
            ...options,
            headers: {
                Accept: 'application/json, text/plain, */*',
                ...(options.headers || {}),
                Authorization: `Bearer ${oauthSession.accessToken}`
            }
        });
    }
    return response;
}

async function fetchMelcloudDevicesFromCookie(cookie) {
    const xsrf = extractXsrf(cookie);
    const safeCookie = cookie.trim().replace(/\n|\r/g, '');
    const response = await fetch('https://melcloudhome.com/api/user/context', {
        method: 'GET',
        headers: {
            Cookie: safeCookie,
            'X-XSRF-TOKEN': xsrf,
            'X-Csrf': '1',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://melcloudhome.com/',
            Origin: 'https://melcloudhome.com'
        }
    });
    if (!response.ok) throw new Error(`Cookie API HTTP ${response.status}`);
    const data = await response.json();
    return data.buildings?.[0]?.airToAirUnits || [];
}

async function fetchMelcloudDevices(cookieFallback = '') {
    const now = Date.now();
    if (cachedDevices.length && now - lastCacheTime < CACHE_TTL) return cachedDevices;

    // OAuth est désormais prioritaire.
    try {
        const response = await fetchWithOAuth('context');
        if (response?.ok) {
            const data = await response.json();
            const units = data.buildings?.[0]?.airToAirUnits || [];
            if (units.length) {
                cachedDevices = units;
                lastCacheTime = Date.now();
            }
            return units;
        }
    } catch (error) {
        console.warn('[API] OAuth context échoué, fallback cookie :', error.message);
    }

    if (cookieFallback) {
        const units = await fetchMelcloudDevicesFromCookie(cookieFallback);
        cachedDevices = units;
        lastCacheTime = Date.now();
        return units;
    }

    throw new Error('Aucune session MELCloud disponible');
}

async function updateAtaUnitWithOAuth(deviceId, payload) {
    return fetchWithOAuth(`ataunit/${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload)
    });
}

async function updateAtaUnitWithCookie(cookie, deviceId, payload) {
    const xsrf = extractXsrf(cookie);
    const safeCookie = cookie.trim().replace(/\n|\r/g, '');
    return fetch(`https://melcloudhome.com/api/ataunit/${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Cookie: safeCookie,
            'X-XSRF-TOKEN': xsrf,
            'X-Csrf': '1',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://melcloudhome.com/',
            Origin: 'https://melcloudhome.com'
        },
        body: JSON.stringify(payload)
    });
}

// ------------------------------------------------------------------
// SESSION STATUS / ANDROID SYNC
// ------------------------------------------------------------------
app.get('/api/check-status', (req, res) => {
    if (oauthSession.refreshToken) {
        return res.json({ status: 'OK', auth: 'OAUTH', action: 'NONE' });
    }
    if (pairCodes.master_cookie) {
        return res.json({ status: 'OK', auth: 'COOKIE_FALLBACK', action: 'NONE' });
    }
    return res.json({
        status: 'ERROR',
        auth: 'NONE',
        action: 'PUSH_OAUTH_REQUIRED',
        message: 'Aucune session MELCloud persistante disponible.'
    });
});

app.post('/api/save-cookie', (req, res) => {
    const { cookie } = req.body || {};
    if (!cookie) return res.status(400).json({ error: 'Cookie manquant' });
    pairCodes.master_cookie = cookie;
    clearCache();
    const pairCode = makePairCode('cookie');
    console.log('[SYNC] Cookie V1.11 reçu (fallback conservé).');
    res.json({ success: true, pairCode });
});

app.post('/api/save-oauth', async (req, res) => {
    try {
        const { access_token, refresh_token, expires_in } = req.body || {};
        if (!refresh_token) return res.status(400).json({ error: 'refresh_token manquant' });
        await saveOAuthSession({ access_token: access_token || null, refresh_token, expires_in: expires_in || 3600 });
        clearCache();
        const pairCode = makePairCode('oauth');
        console.log('[SYNC] Session OAuth reçue et persistée.');
        res.json({ success: true, pairCode, auth: 'OAUTH' });
    } catch (error) {
        console.error('[SYNC] save-oauth:', error.message);
        res.status(500).json({ error: 'Impossible de persister la session OAuth' });
    }
});

app.get('/api/oauth-status', (req, res) => {
    res.json({
        configured: Boolean(oauthSession.refreshToken),
        expires_at: oauthSession.expiresAt || null,
        expires_in_seconds: oauthSession.expiresAt ? Math.max(0, Math.floor((oauthSession.expiresAt - Date.now()) / 1000)) : null,
        database: Boolean(pool && dbReady)
    });
});

// ------------------------------------------------------------------
// GOOGLE HOME ACCOUNT LINKING
// ------------------------------------------------------------------
app.get('/oauth/auth', (req, res) => {
    const redirectUri = String(req.query.redirect_uri || '');
    const state = String(req.query.state || '');
    res.send(`
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connexion Melhome</title></head>
        <body style="font-family:Arial;padding:40px;text-align:center">
          <h2>Associer Melhome</h2>
          <form method="POST" action="/oauth/login">
            <input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, '&quot;')}" />
            <input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}" />
            <input type="text" name="pairCode" placeholder="Code" maxlength="4" style="padding:10px;width:200px;font-size:24px;text-align:center;letter-spacing:5px" required />
            <br><br><button type="submit" style="padding:12px 24px">Valider</button>
          </form>
        </body></html>
    `);
});

app.post('/oauth/login', (req, res) => {
    const { pairCode, redirect_uri, state } = req.body || {};
    const valid = getPairValue(pairCode);
    if (!valid && !oauthSession.refreshToken && !pairCodes.master_cookie) {
        return res.status(400).send('Erreur : aucune session MELCloud disponible.');
    }
    const authCode = `auth_${Math.random().toString(36).slice(2, 12)}`;
    pairCodes[authCode] = { value: 'google_link', createdAt: Date.now() };
    const separator = String(redirect_uri).includes('?') ? '&' : '?';
    res.redirect(`${redirect_uri}${separator}code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(state || '')}`);
});

app.all('/oauth/token', (req, res) => {
    const code = req.body?.code || req.query?.code;
    if (!String(code || '').startsWith('auth_')) return res.status(400).json({ error: 'invalid_grant' });
    const accessToken = Buffer.from(`melhome-google-${Date.now()}`).toString('base64url');
    res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 31536000 });
});

// ------------------------------------------------------------------
// GOOGLE SMART HOME
// ------------------------------------------------------------------
app.post('/fulfillment', async (req, res) => {
    const body = req.body || {};
    const requestId = body.requestId;
    const intent = body.inputs?.[0]?.intent;
    if (!req.headers.authorization) return res.status(401).send('Non autorisé');

    const cookieFallback = pairCodes.master_cookie || '';

    try {
        if (intent === 'action.devices.SYNC') {
            const clims = await fetchMelcloudDevices(cookieFallback);
            const googleDevices = clims.map(clim => ({
                id: String(clim.id ?? clim.ID),
                type: 'action.devices.types.THERMOSTAT',
                traits: ['action.devices.traits.TemperatureSetting', 'action.devices.traits.FanSpeed'],
                name: { name: clim.givenDisplayName || clim.GivenDisplayName || 'Climatiseur' },
                willReportState: false,
                attributes: {
                    availableThermostatModes: 'off,on,heat,cool,dry,fan-only,auto',
                    thermostatTemperatureUnit: 'C',
                    supportsFanSpeedPercent: false,
                    commandOnlyFanSpeed: false,
                    availableFanSpeeds: {
                        speeds: [
                            { speed_name: 'Auto', speed_values: [{ lang: 'fr', speed_synonym: ['Auto', 'Automatique'] }, { lang: 'en', speed_synonym: ['Auto', 'Automatic'] }] },
                            { speed_name: 'One', speed_values: [{ lang: 'fr', speed_synonym: ['Vitesse 1', '1', 'Un'] }, { lang: 'en', speed_synonym: ['Speed 1', '1', 'One'] }] },
                            { speed_name: 'Two', speed_values: [{ lang: 'fr', speed_synonym: ['Vitesse 2', '2', 'Deux'] }, { lang: 'en', speed_synonym: ['Speed 2', '2', 'Two'] }] },
                            { speed_name: 'Three', speed_values: [{ lang: 'fr', speed_synonym: ['Vitesse 3', '3', 'Trois'] }, { lang: 'en', speed_synonym: ['Speed 3', '3', 'Three'] }] },
                            { speed_name: 'Four', speed_values: [{ lang: 'fr', speed_synonym: ['Vitesse 4', '4', 'Quatre'] }, { lang: 'en', speed_synonym: ['Speed 4', '4', 'Four'] }] },
                            { speed_name: 'Five', speed_values: [{ lang: 'fr', speed_synonym: ['Vitesse 5', '5', 'Cinq'] }, { lang: 'en', speed_synonym: ['Speed 5', '5', 'Five'] }] }
                        ],
                        ordered: true
                    }
                }
            }));
            return res.json({ requestId, payload: { agentUserId: 'melhome_user', devices: googleDevices } });
        }

        if (intent === 'action.devices.QUERY') {
            const clims = await fetchMelcloudDevices(cookieFallback);
            const devicesState = {};
            clims.forEach(clim => {
                const id = String(clim.id ?? clim.ID);
                devicesState[id] = {
                    online: true,
                    status: 'SUCCESS',
                    thermostatMode: getGoogleMode(clim),
                    thermostatTemperatureSetpoint: getTemp(clim),
                    thermostatTemperatureAmbient: getRoomTemp(clim),
                    currentFanSpeedSetting: getGoogleFanSpeed(clim)
                };
            });
            return res.json({ requestId, payload: { devices: devicesState } });
        }

        if (intent === 'action.devices.EXECUTE') {
            const commands = body.inputs?.[0]?.payload?.commands || [];
            const clims = await fetchMelcloudDevices(cookieFallback);
            const responseCommands = [];

            for (const command of commands) {
                for (const device of command.devices || []) {
                    const climId = String(device.id);
                    const currentDeviceData = clims.find(c => String(c.id ?? c.ID) === climId);
                    if (!currentDeviceData) continue;

                    const payloadJson = {
                        power: null,
                        operationMode: null,
                        setFanSpeed: null,
                        setTemperature: null,
                        vaneHorizontalDirection: null,
                        vaneVerticalDirection: null,
                        temperatureIncrementOverride: null,
                        inStandbyMode: null
                    };

                    const updatedStates = {
                        online: true,
                        thermostatMode: getGoogleMode(currentDeviceData),
                        thermostatTemperatureSetpoint: getTemp(currentDeviceData),
                        currentFanSpeedSetting: getGoogleFanSpeed(currentDeviceData)
                    };

                    for (const exec of command.execution || []) {
                        if (exec.command === 'action.devices.commands.OnOff') {
                            payloadJson.power = Boolean(exec.params?.on);
                            updatedStates.thermostatMode = payloadJson.power ? 'auto' : 'off';
                        }
                        if (exec.command === 'action.devices.commands.ThermostatTemperatureSetpoint') {
                            payloadJson.setTemperature = exec.params?.thermostatTemperatureSetpoint;
                            updatedStates.thermostatTemperatureSetpoint = payloadJson.setTemperature;
                        }
                        if (exec.command === 'action.devices.commands.ThermostatSetMode') {
                            const mode = exec.params?.thermostatMode;
                            updatedStates.thermostatMode = mode;
                            if (mode === 'off') payloadJson.power = false;
                            else {
                                if (!isPoweredOn(currentDeviceData) && payloadJson.power === null) payloadJson.power = true;
                                if (mode === 'cool') payloadJson.operationMode = 'Cool';
                                if (mode === 'heat') payloadJson.operationMode = 'Heat';
                                if (mode === 'dry') payloadJson.operationMode = 'Dry';
                                if (mode === 'fan-only') payloadJson.operationMode = 'Fan';
                                if (mode === 'auto') payloadJson.operationMode = 'Automatic';
                            }
                        }
                        if (exec.command === 'action.devices.commands.SetFanSpeed') {
                            payloadJson.setFanSpeed = exec.params?.fanSpeed;
                            updatedStates.currentFanSpeedSetting = payloadJson.setFanSpeed;
                        }
                    }

                    let commandSuccess = false;
                    try {
                        const oauthResponse = await updateAtaUnitWithOAuth(climId, payloadJson);
                        if (oauthResponse?.ok) commandSuccess = true;
                    } catch (error) {
                        console.warn('[EXECUTE] OAuth indisponible :', error.message);
                    }

                    if (!commandSuccess && cookieFallback) {
                        for (let attempt = 0; attempt <= 3; attempt++) {
                            try {
                                const response = await updateAtaUnitWithCookie(cookieFallback, climId, payloadJson);
                                if (response.ok) {
                                    commandSuccess = true;
                                    break;
                                }
                                if (response.status === 500 && attempt < 3) {
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                    continue;
                                }
                                break;
                            } catch {
                                if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000));
                            }
                        }
                    }

                    if (commandSuccess) {
                        clearCache();
                        responseCommands.push({ ids: [climId], status: 'SUCCESS', states: updatedStates });
                    } else {
                        responseCommands.push({ ids: [climId], status: 'ERROR', errorCode: 'hardError' });
                    }
                }
            }
            return res.json({ requestId, payload: { commands: responseCommands } });
        }

        return res.status(400).json({ requestId, payload: { errorCode: 'invalidIntent' } });
    } catch (error) {
        console.error('[FULFILLMENT]', error.message);
        return res.json({ requestId, payload: { errorCode: 'hardError' } });
    }
});

(async () => {
    await initDatabase();
    app.listen(PORT, () => console.log(`Melhome bridge OAuth listening on ${PORT}`));
})();
