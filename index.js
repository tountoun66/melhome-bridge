const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- BASE DE DONNÉES EN MÉMOIRE ---
// Lie le code à 4 chiffres généré au Cookie de l'utilisateur
const pairCodes = {}; 
// Lie le Jeton Google d'association au Cookie de l'utilisateur
const userTokens = {}; 

// --- FONCTIONS UTILITAIRES MELCLOUD HOME ---

// Extrait le XSRF-TOKEN du cookie pour l'authentification (Comme en Kotlin)
function extractXsrf(cookieStr) {
    const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/i);
    if (match) return decodeURIComponent(match[1]);
    return "1";
}

// Récupère la liste complète des climatiseurs
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
    
    if (!response.ok) throw new Error("Erreur de connexion à MELCloud Home");
    
    const data = await response.json();
    return (data.buildings && data.buildings.length > 0) ? (data.buildings[0].airToAirUnits || []) : [];
}

// Convertit le mode MELCloud en mode Google Home
function getGoogleMode(clim) {
    const power = clim.power ?? clim.Power ?? false;
    if (!power) return "off";
    
    const mode = (clim.operationMode ?? clim.OperationMode ?? "Automatic").toLowerCase();
    if (mode.includes("cool")) return "cool";
    if (mode.includes("heat")) return "heat";
    if (mode.includes("dry")) return "dry";
    if (mode.includes("fan")) return "fan-only";
    return "auto";
}

// --- ROUTES DE L'APPLICATION ---

// 1. L'application Android appelle cette route pour déposer le cookie
app.post('/api/save-cookie', (req, res) => {
    const { cookie } = req.body;
    if (!cookie) return res.status(400).json({ error: "Cookie manquant" });

    // Génère un code d'appairage à 4 chiffres (ex: 8492)
    const pairCode = Math.floor(1000 + Math.random() * 9000).toString();
    pairCodes[pairCode] = cookie;
    
    console.log(`Nouveau Cookie reçu ! Code d'appairage généré : ${pairCode}`);
    res.json({ success: true, pairCode: pairCode });
});

// 2. Page de connexion affichée dans Google Home
app.get('/oauth/auth', (req, res) => {
    const { redirect_uri, state } = req.query;

    res.send(`
        <html>
            <head><title>Connexion Melhome</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2>Associer Melhome</h2>
                <p>Ouvrez votre application Melhome sur votre téléphone pour obtenir votre code d'association à 4 chiffres.</p>
                <form method="POST" action="/oauth/login">
                    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}" />
                    <input type="hidden" name="state" value="${state || ''}" />
                    <div style="margin: 20px;">
                        <input type="text" name="pairCode" placeholder="Code à 4 chiffres" maxlength="4" style="padding: 10px; width: 200px; font-size: 24px; text-align: center; letter-spacing: 5px;" required />
                    </div>
                    <button type="submit" style="padding: 12px 24px; background: #2196F3; color: white; border: none; cursor: pointer; font-size: 16px; border-radius: 5px;">Valider le code</button>
                </form>
            </body>
        </html>
    `);
});

// 3. Traitement de la connexion Google
app.post('/oauth/login', (req, res) => {
    const { pairCode, redirect_uri, state } = req.body;
    
    // On vérifie si le code à 4 chiffres existe dans la mémoire
    const userCookie = pairCodes[pairCode];
    if (!userCookie) {
        return res.send("Erreur : Code invalide ou expiré. Veuillez relancer l'application Melhome.");
    }

    // Le code est bon, on le transforme en AuthCode pour Google
    const authCode = "auth_" + pairCode + "_" + Math.random().toString(36).substr(2, 5);
    pairCodes[authCode] = userCookie; // On transfère le cookie sur le nouveau code

    res.redirect(`${redirect_uri}?code=${authCode}&state=${state || ''}`);
});

// 4. Échange du code contre un Jeton d'accès
app.all('/oauth/token', (req, res) => {
    const code = req.body.code || req.query.code;
    const userCookie = pairCodes[code];

    const accessToken = "token_" + Math.random().toString(36).substr(2, 9);
    userTokens[accessToken] = userCookie; // Sauvegarde finale pour les futures commandes

    res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 31536000
    });
});

// 5. Cœur de l'intégration : FULFILLMENT Google Home
app.post('/fulfillment', async (req, res) => {
    const body = req.body;
    const requestId = body?.requestId;
    const intent = body?.inputs[0]?.intent;

    // Récupération du Cookie de l'utilisateur grâce au Token caché par Google
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).send("Non autorisé");
    const accessToken = authHeader.split(' ')[1];
    const userCookie = userTokens[accessToken];

    if (!userCookie) return res.status(401).send("Jeton expiré ou non reconnu");

    try {
        // A. Étape SYNC (Détection des clims)
        if (intent === 'action.devices.SYNC') {
            const clims = await fetchMelcloudDevices(userCookie);
            
            const googleDevices = clims.map(clim => ({
                id: (clim.id || clim.ID).toString(),
                type: "action.devices.types.THERMOSTAT",
                traits: [
                    "action.devices.traits.TemperatureSetting",
                    "action.devices.traits.OnOff"
                ],
                name: {
                    name: clim.givenDisplayName || clim.GivenDisplayName || "Climatiseur"
                },
                willReportState: false,
                attributes: {
                    availableThermostatModes: "off,heat,cool,dry,fan-only,auto",
                    temperatureUnit: "C"
                }
            }));

            return res.json({ requestId, payload: { agentUserId: accessToken, devices: googleDevices } });
        }

        // B. Étape QUERY (État actuel)
        if (intent === 'action.devices.QUERY') {
            const clims = await fetchMelcloudDevices(userCookie);
            const devicesState = {};

            clims.forEach(clim => {
                const id = (clim.id || clim.ID).toString();
                devicesState[id] = {
                    online: true,
                    status: "SUCCESS",
                    on: clim.power ?? clim.Power ?? false,
                    thermostatMode: getGoogleMode(clim),
                    thermostatTemperatureSetpoint: clim.setTemperature ?? clim.SetTemperature ?? 20,
                    thermostatAmbientTemperature: clim.roomTemperature ?? clim.RoomTemperature ?? 20
                };
            });

            return res.json({ requestId, payload: { devices: devicesState } });
        }

        // C. Étape EXECUTE (Ordres)
        if (intent === 'action.devices.EXECUTE') {
            const commands = body.inputs[0].payload.commands;
            // On récupère d'abord l'état actuel de toutes les clims (car le PUT demande le bloc complet)
            const clims = await fetchMelcloudDevices(userCookie);
            const xsrf = extractXsrf(userCookie);
            const safeCookie = userCookie.trim().replace(/\n|\r/g, "");

            for (let command of commands) {
                for (let device of command.devices) {
                    const climId = device.id;
                    const currentDeviceData = clims.find(c => (c.id || c.ID).toString() === climId);
                    if (!currentDeviceData) continue;

                    let payloadJson = { ...currentDeviceData }; // Copie de l'état actuel
                    
                    // Applique les modifications demandées par Google
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

                    // Envoi effectif à Mitsubishi (Equivalent de votre sendAtaunitCommand)
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

            // Indique à Google que tout s'est bien passé
            return res.json({
                requestId,
                payload: {
                    commands: commands.map(c => ({
                        ids: c.devices.map(d => d.id),
                        status: "SUCCESS"
                    }))
                }
            });
        }
    } catch (error) {
        console.error("Erreur exécution MELCloud :", error);
    }

    res.json({ requestId, payload: {} });
});

app.listen(PORT, () => {
    console.log(`Serveur Bridge en ligne sur le port ${PORT}`);
});
