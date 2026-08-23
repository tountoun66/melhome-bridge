const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pairCodes = {}; 

// --- 1. L'EXTRACTION ROBUSTE (Inspirée de votre application) ---
function extractXsrf(cookieStr) {
    const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/i);
    if (match) {
        try { return decodeURIComponent(match[1]); } catch(e) { return match[1]; }
    }
    return "1";
}

function getSetting(clim, keys) {
    for (let key of keys) {
        if (clim[key] !== undefined && clim[key] !== null) return clim[key];
    }
    const containers = [];
    if (Array.isArray(clim.settings)) containers.push(clim.settings);
    if (Array.isArray(clim.unitSettings)) containers.push(clim.unitSettings);
    
    for (let container of containers) {
        for (let item of container) {
            const itemName = String(item.name || item.Name || "").toLowerCase();
            if (keys.some(k => k.toLowerCase() === itemName)) {
                if (item.value !== undefined && item.value !== null) return item.value;
                if (item.Value !== undefined && item.Value !== null) return item.Value;
            }
        }
    }
    return null;
}

function isPoweredOn(clim) {
    const val = getSetting(clim, ["power", "Power"]);
    return val === true || String(val).toLowerCase() === "true";
}

function getRoomTemp(clim) {
    const val = getSetting(clim, ["roomTemperature", "RoomTemperature", "indoorTemperature", "IndoorTemperature"]);
    const num = parseFloat(val);
    return (!isNaN(num) && num > 0 && num < 60) ? num : 20.0;
}

function getTemp(clim) {
    const val = getSetting(clim, ["setTemperature", "SetTemperature", "targetTemperature", "TargetTemperature", "defaultTemperature"]);
    const num = parseFloat(val);
    return (!isNaN(num) && num > 0 && num < 60) ? num : 20.0;
}

function getFanSpeed(clim) {
    const val = getSetting(clim, ["setFanSpeed", "SetFanSpeed", "fanSpeed", "FanSpeed"]);
    const num = parseInt(val, 10);
    return (!isNaN(num) && num >= 0 && num <= 5) ? num : 0;
}

function getGoogleMode(clim) {
    if (!isPoweredOn(clim)) return "off"; 
    
    const val = getSetting(clim, ["operationMode", "OperationMode"]);
    const mode = String(val || "Automatic").toLowerCase();
    
    if (mode.includes("cool")) return "cool";
    if (mode.includes("heat")) return "heat";
    if (mode.includes("dry")) return "dry";
    if (mode.includes("fan")) return "fan-only";
    return "auto";
}

// --- 2. FONCTIONS RÉSEAU MITSUBISHI ---
async function fetchMelcloudDevices(cookie) {
    const xsrf = extractXsrf(cookie);
    const safeCookie = cookie.trim().replace(/\n|\r/g, "");
    
    const response = await fetch("https://melcloudhome.com/api/user/context", {
        method: 'GET',
        headers: {
            "Cookie": safeCookie,
            "X-XSRF-TOKEN": xsrf,
            "X-Csrf": "1",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/plain, */*"
        }
    });
    
    if (!response.ok) throw new Error("Erreur de connexion API HTTP " + response.status);
    const data = await response.json();
    return (data.buildings && data.buildings.length > 0) ? (data.buildings[0].airToAirUnits || []) : [];
}

// --- 3. ROUTES D'ASSOCIATION ---
app.post('/api/save-cookie', (req, res) => {
    const { cookie } = req.body;
    if (!cookie) return res.status(400).json({ error: "Cookie manquant" });
    const pairCode = Math.floor(1000 + Math.random() * 9000).toString();
    pairCodes[pairCode] = cookie;
    res.json({ success: true, pairCode: pairCode });
});

app.get('/oauth/auth', (req, res) => {
    const { redirect_uri, state } = req.query;
    res.send(`
        <html>
            <head><title>Connexion Melhome</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2>Associer Melhome</h2>
                <form method="POST" action="/oauth/login">
                    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}" />
                    <input type="hidden" name="state" value="${state || ''}" />
                    <input type="text" name="pairCode" placeholder="Code" maxlength="4" style="padding: 10px; width: 200px; font-size: 24px; text-align: center; letter-spacing: 5px;" required />
                    <br><br><button type="submit" style="padding: 12px 24px; background: #2196F3; color: white; border: none; cursor: pointer; border-radius: 5px;">Valider</button>
                </form>
            </body>
        </html>
    `);
});

app.post('/oauth/login', (req, res) => {
    const { pairCode, redirect_uri, state } = req.body;
    const userCookie = pairCodes[pairCode];
    if (!userCookie) return res.send("Erreur : Code invalide.");
    const authCode = "auth_" + pairCode + "_" + Math.random().toString(36).substr(2, 5);
    pairCodes[authCode] = userCookie; 
    res.redirect(`${redirect_uri}?code=${authCode}&state=${state || ''}`);
});

app.all('/oauth/token', (req, res) => {
    const code = req.body.code || req.query.code;
    const userCookie = pairCodes[code];
    if (!userCookie) return res.status(400).send("Code expiré");
    const accessToken = Buffer.from(userCookie).toString('base64');
    delete pairCodes[code]; 
    res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 31536000 });
});

// --- 4. LE FULFILLMENT (Traduction Google -> Votre logique Kotlin) ---
app.post('/fulfillment', async (req, res) => {
    const body = req.body;
    const requestId = body?.requestId;
    const intent = body?.inputs[0]?.intent;
    const authHeader = req.headers.authorization;

    if (!authHeader) return res.status(401).send("Non autorisé");
    
    let userCookie = "";
    try {
        userCookie = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf-8');
    } catch(e) {
        return res.status(401).send("Jeton invalide");
    }

    try {
        if (intent === 'action.devices.SYNC') {
            const clims = await fetchMelcloudDevices(userCookie);
            const googleDevices = clims.map(clim => ({
                id: (clim.id || clim.ID).toString(),
                type: "action.devices.types.THERMOSTAT",
                traits: [
                    "action.devices.traits.TemperatureSetting",
                    "action.devices.traits.FanSpeed"
                ],
                name: { name: clim.givenDisplayName || clim.GivenDisplayName || "Climatiseur" },
                willReportState: false,
                attributes: { 
                    availableThermostatModes: "off,on,heat,cool,dry,fan-only,auto", 
                    thermostatTemperatureUnit: "C",
                    supportsFanSpeedPercent: false,
                    availableFanSpeeds: {
                        speeds: [
                            { speed_name: "auto", speed_values: [{ lang_format: "en", speed_synonym: ["auto"] }, { lang_format: "fr", speed_synonym: ["automatique", "auto"] }] },
                            { speed_name: "1", speed_values: [{ lang_format: "en", speed_synonym: ["speed 1", "one"] }, { lang_format: "fr", speed_synonym: ["vitesse 1", "un"] }] },
                            { speed_name: "2", speed_values: [{ lang_format: "en", speed_synonym: ["speed 2", "two"] }, { lang_format: "fr", speed_synonym: ["vitesse 2", "deux"] }] },
                            { speed_name: "3", speed_values: [{ lang_format: "en", speed_synonym: ["speed 3", "three"] }, { lang_format: "fr", speed_synonym: ["vitesse 3", "trois"] }] },
                            { speed_name: "4", speed_values: [{ lang_format: "en", speed_synonym: ["speed 4", "four"] }, { lang_format: "fr", speed_synonym: ["vitesse 4", "quatre"] }] },
                            { speed_name: "5", speed_values: [{ lang_format: "en", speed_synonym: ["speed 5", "five"] }, { lang_format: "fr", speed_synonym: ["vitesse 5", "cinq"] }] }
                        ],
                        ordered: true
                    }
                }
            }));
            return res.json({ requestId, payload: { agentUserId: "melhome_user", devices: googleDevices } });
        }

        if (intent === 'action.devices.QUERY') {
            const clims = await fetchMelcloudDevices(userCookie);
            const devicesState = {};

            clims.forEach(clim => {
                const id = (clim.id || clim.ID).toString();
                const fanVal = getFanSpeed(clim);
                const fanName = fanVal === 0 ? "auto" : fanVal.toString();

                devicesState[id] = {
                    online: true,
                    status: "SUCCESS",
                    thermostatMode: getGoogleMode(clim),
                    thermostatTemperatureSetpoint: getTemp(clim),
                    thermostatTemperatureAmbient: getRoomTemp(clim),
                    currentFanSpeedSetting: fanName
                };
            });
            
            return res.json({ requestId, payload: { devices: devicesState } });
        }

        if (intent === 'action.devices.EXECUTE') {
            const commands = body.inputs[0].payload.commands;
            const clims = await fetchMelcloudDevices(userCookie);
            const xsrf = extractXsrf(userCookie);
            const safeCookie = userCookie.trim().replace(/\n|\r/g, "");

            for (let command of commands) {
                for (let device of command.devices) {
                    const climId = device.id;
                    const currentDeviceData = clims.find(c => (c.id || c.ID).toString() === climId);
                    if (!currentDeviceData) continue;

                    // COPIE EXACTE DU COMPORTEMENT DE VOTRE KOTLIN (jsonMap.putAll(device))
                    let jsonMap = JSON.parse(JSON.stringify(currentDeviceData)); 
                    
                    command.execution.forEach(exec => {
                        if (exec.command === 'action.devices.commands.OnOff') {
                            jsonMap.power = exec.params.on;
                        }
                        if (exec.command === 'action.devices.commands.ThermostatTemperatureSetpoint') {
                            jsonMap.setTemperature = exec.params.thermostatTemperatureSetpoint;
                        }
                        if (exec.command === 'action.devices.commands.ThermostatSetMode') {
                            const mode = exec.params.thermostatMode;
                            if (mode === "off") {
                                jsonMap.power = false;
                            } else {
                                jsonMap.power = true;
                                if (mode === "cool") jsonMap.operationMode = "Cool";
                                if (mode === "heat") jsonMap.operationMode = "Heat";
                                if (mode === "dry") jsonMap.operationMode = "Dry";
                                if (mode === "fan-only") jsonMap.operationMode = "Fan";
                                if (mode === "auto") jsonMap.operationMode = "Automatic";
                            }
                        }
                        // Traduction directe de la commande FanSpeed de Google vers votre variable setFanSpeed
                        if (exec.command === 'action.devices.commands.FanSpeed') {
                            const speedStr = exec.params.fanSpeed;
                            jsonMap.setFanSpeed = (speedStr === "auto") ? 0 : parseInt(speedStr, 10);
                            jsonMap.power = true; // S'assure que l'appareil est sous tension
                        }
                    });

                    console.log(`=== REQUÊTE PUT MITSUBISHI (CLIM ${climId}) ===`, JSON.stringify(jsonMap));

                    // REQUÊTE IDENTIQUE À VOTRE APP ANDROID (sendAtaunitCommand)
                    await fetch(`https://melcloudhome.com/api/ataunit/${climId}`, {
                        method: 'PUT',
                        headers: {
                            "Content-Type": "application/json; charset=utf-8",
                            "Cookie": safeCookie,
                            "X-XSRF-TOKEN": xsrf,
                            "X-Csrf": "1",
                            "X-Requested-With": "XMLHttpRequest",
                            "Accept": "application/json, text/plain, */*"
                        },
                        body: JSON.stringify(jsonMap)
                    });
                }
            }
            return res.json({ requestId, payload: { commands: commands.map(c => ({ ids: c.devices.map(d => d.id), status: "SUCCESS" })) } });
        }
    } catch (error) {
        console.error("Erreur d'exécution MELCloud :", error);
        return res.json({ requestId, payload: { errorCode: "hardError" } });
    }

    res.json({ requestId, payload: {} });
});

app.listen(PORT, () => console.log(`Serveur Bridge en ligne sur le port ${PORT}`));
