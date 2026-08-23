const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pairCodes = {}; 

// --- 1. FONCTIONS DE LECTURE ROBUSTES (Filtre anti-zéro) ---
function extractXsrf(cookieStr) {
    const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/i);
    if (match) {
        try { return decodeURIComponent(match[1]); } catch(e) { return match[1]; }
    }
    return "1";
}

// Cherche la vraie température et rejette les 0
function getValidTemp(clim, keys) {
    // 1. Cherche à la racine dans l'ordre de priorité
    for (let key of keys) {
        if (clim[key] !== undefined && clim[key] !== null) {
            let val = parseFloat(clim[key]);
            // On s'assure que la température est réelle (entre 1°C et 60°C)
            if (!isNaN(val) && val > 0 && val < 60) return val; 
        }
    }
    
    // 2. Cherche dans les sous-dossiers si la racine donnait 0
    const containers = [];
    if (Array.isArray(clim.settings)) containers.push(clim.settings);
    if (Array.isArray(clim.unitSettings)) containers.push(clim.unitSettings);
    
    for (let container of containers) {
        for (let item of container) {
            const itemName = String(item.name || item.Name || "").toLowerCase();
            if (keys.some(k => k.toLowerCase() === itemName)) {
                let val = parseFloat(item.value || item.Value);
                if (!isNaN(val) && val > 0 && val < 60) return val;
            }
        }
    }
    return 20.0; // Valeur de secours pour empêcher Google de désactiver la clim
}

function getRoomTemp(clim) {
    return getValidTemp(clim, ["roomTemperature", "RoomTemperature", "indoorTemperature", "IndoorTemperature", "currentTemperature", "temperature"]);
}

function getTemp(clim) {
    return getValidTemp(clim, ["setTemperature", "SetTemperature", "targetTemperature", "TargetTemperature", "defaultTemperature"]);
}

function isPoweredOn(clim) {
    const powerKeys = ["power", "Power"];
    for (let key of powerKeys) {
        if (clim[key] !== undefined && clim[key] !== null) {
            return clim[key] === true || String(clim[key]).toLowerCase() === "true";
        }
    }
    return false;
}

function getGoogleMode(clim) {
    if (!isPoweredOn(clim)) return "off";
    
    let modeValue = "Automatic";
    const modeKeys = ["operationMode", "OperationMode"];
    for (let key of modeKeys) {
        if (clim[key] !== undefined && clim[key] !== null) {
            modeValue = String(clim[key]);
            break;
        }
    }

    const mode = modeValue.toLowerCase();
    if (mode.includes("cool")) return "cool";
    if (mode.includes("heat")) return "heat";
    if (mode.includes("dry")) return "dry";
    if (mode.includes("fan")) return "fan-only";
    return "auto";
}

// --- 2. REQUÊTES MITSUBISHI ---
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
    
    if (!response.ok) throw new Error("Erreur de connexion API");
    const data = await response.json();
    return (data.buildings && data.buildings.length > 0) ? (data.buildings[0].airToAirUnits || []) : [];
}

// --- 3. ROUTES DE L'APPLICATION ---
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
                <p>Ouvrez l'application Melhome pour obtenir votre code d'association.</p>
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

// --- 4. LE FULFILLMENT (Écoute des commandes) ---
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
                traits: ["action.devices.traits.TemperatureSetting", "action.devices.traits.OnOff"],
                name: { name: clim.givenDisplayName || clim.GivenDisplayName || "Climatiseur" },
                willReportState: false,
                attributes: { availableThermostatModes: "off,heat,cool,dry,fan-only,auto", temperatureUnit: "C" }
            }));
            return res.json({ requestId, payload: { agentUserId: "melhome_user", devices: googleDevices } });
        }

        if (intent === 'action.devices.QUERY') {
            const clims = await fetchMelcloudDevices(userCookie);
            const devicesState = {};

            clims.forEach(clim => {
                const id = (clim.id || clim.ID).toString();
                devicesState[id] = {
                    online: true,
                    status: "SUCCESS",
                    on: isPoweredOn(clim),
                    thermostatMode: getGoogleMode(clim),
                    thermostatTemperatureSetpoint: getTemp(clim),
                    thermostatAmbientTemperature: getRoomTemp(clim) // Le correctif s'applique ici !
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

                    let payloadJson = { ...currentDeviceData }; 
                    
                    command.execution.forEach(exec => {
                        if (exec.command === 'action.devices.commands.OnOff') {
                            payloadJson.power = exec.params.on;
                        }
                        if (exec.command === 'action.devices.commands.ThermostatTemperatureSetpoint') {
                            payloadJson.setTemperature = exec.params.thermostatTemperatureSetpoint;
                        }
                        if (exec.command === 'action.devices.commands.ThermostatSetMode') {
                            const mode = exec.params.thermostatMode;
                            if (mode === "off") {
                                payloadJson.power = false;
                            } else {
                                payloadJson.power = true;
                                if (mode === "cool") payloadJson.operationMode = "Cool";
                                if (mode === "heat") payloadJson.operationMode = "Heat";
                                if (mode === "dry") payloadJson.operationMode = "Dry";
                                if (mode === "fan-only") payloadJson.operationMode = "Fan";
                                if (mode === "auto") payloadJson.operationMode = "Automatic";
                            }
                        }
                    });

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
                        body: JSON.stringify(payloadJson)
                    });
                }
            }
            return res.json({ requestId, payload: { commands: commands.map(c => ({ ids: c.devices.map(d => d.id), status: "SUCCESS" })) } });
        }
    } catch (error) {
        console.error("Erreur exécution :", error);
        return res.json({ requestId, payload: { errorCode: "hardError" } });
    }

    res.json({ requestId, payload: {} });
});

app.listen(PORT, () => console.log(`Serveur Bridge en ligne sur le port ${PORT}`));
