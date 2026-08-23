const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/cmd', async (req, res) => {
    const { deviceId, power, temp, mode, fan } = req.query;
    const cookie = process.env.MELCLOUD_COOKIE;

    if (!cookie) {
        return res.status(500).send("Erreur : Cookie MELCloud non configuré sur Render.");
    }

    try {
        const url = `https://melcloudhome.com/api/ataunit/${deviceId}`;
        const bodyData = {};
        if (power !== undefined) bodyData.power = (power === 'true');
        if (temp !== undefined) bodyData.setTemperature = parseFloat(temp);
        if (mode !== undefined) bodyData.operationMode = mode;
        if (fan !== undefined) bodyData.setFanSpeed = parseInt(fan);

        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Cookie': cookie,
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify(bodyData)
        });

        if (response.ok) {
            res.status(200).send("Succès : Commande envoyée !");
        } else {
            const errText = await response.text();
            res.status(500).send(`Erreur MELCloud (${response.status}): ${errText}`);
        }
    } catch (error) {
        res.status(500).send(`Erreur serveur : ${error.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`Serveur en écoute sur le port ${PORT}`);
});
