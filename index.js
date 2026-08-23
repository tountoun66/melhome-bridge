const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Point d'entrée unique (Fulfillment) requis par Google Smart Home
app.post('/fulfillment', async (req, res) => {
    const body = req.body;
    const requestId = body.requestId;
    
    // Récupération de l'intention envoyée par Google (SYNC, QUERY, EXECUTE)
    const input = body.inputs && body.inputs[0];
    const intent = input && input.intent;

    console.log(`Reçu intention Google Smart Home : ${intent}`);

    let payload = {};

    switch (intent) {
        // ==========================================
        // 1. SYNC : Liste des appareils de l'utilisateur
        // ==========================================
        case 'action.devices.SYNC':
            // TODO: Récupérer les vrais appareils depuis MELCloud Home pour l'utilisateur connecté
            payload = {
                devices: [
                    {
                        id: 'clim_salon_123', // ID unique de l'appareil
                        type: 'action.devices.types.AC_UNIT', // Type Google pour un climatiseur
                        traits: [
                            'action.devices.traits.OnOff',
                            'action.devices.traits.TemperatureSetting'
                        ],
                        name: {
                            defaultNames: ['Climatiseur Melhome'],
                            name: 'Salon',
                            nicknames: ['Salon', 'Clim salon']
                        },
                        willReportState: false,
                        attributes: {
                            availableThermostatModes: 'off,heat,cool,fan_only,auto',
                            temperatureUnit: 'C'
                        }
                    }
                ]
            };
            break;

        // ==========================================
        // 2. QUERY : État actuel des appareils
        // ==========================================
        case 'action.devices.QUERY':
            // TODO: Interroger l'API MELCloud Home pour obtenir l'état réel de l'appareil
            payload = {
                devices: {
                    'clim_salon_123': {
                        on: true,
                        online: true,
                        thermostatMode: 'heat',
                        thermostatTemperatureSetpoint: 21.0,
                        thermostatAmbientTemperature: 19.5
                    }
                }
            };
            break;

        // ==========================================
        // 3. EXECUTE : Ordre de pilotage (Voix / App)
        // ==========================================
        case 'action.devices.EXECUTE':
            const command = input.payload.commands[0];
            const deviceIds = command.devices.map(d => d.id);
            const execution = command.execution[0];
            
            const commandName = execution.command;
            const params = execution.params;

            console.log(`Commande reçue pour les appareils ${deviceIds} : ${commandName}`, params);

            // TODO : Traduire cet ordre et l'envoyer à l'API de MELCloud Home via le jeton de l'utilisateur

            payload = {
                commands: [
                    {
                        ids: deviceIds,
                        status: 'SUCCESS',
                        states: {
                            on: params.on !== undefined ? params.on : true,
                            online: true
                        }
                    }
                ]
            };
            break;

        default:
            return res.status(400).send({ error: `Intention non supportée : ${intent}` });
    }

    // Réponse au format exigé par Google
    res.json({
        requestId: requestId,
        payload: payload
    });
});

app.listen(PORT, () => {
    console.log(`Serveur Cloud-to-Cloud Google Smart Home en écoute sur le port ${PORT}`);
});
