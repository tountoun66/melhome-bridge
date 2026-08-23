const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Journalisation ultra-détaillée de TOUTES les requêtes entrantes
app.use((req, res, next) => {
    console.log(`\n--- NOUVELLE REQUÊTE ---`);
    console.log(`[${req.method}] ${req.url}`);
    console.log(`Headers :`, req.headers);
    console.log(`Body :`, req.body);
    console.log(`Query :`, req.query);
    next();
});

// Page d'accueil pour réveiller Render
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Melhome Bridge</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #2196F3;">🟢 Serveur Melhome Bridge Actif</h1>
            </body>
        </html>
    `);
});

// 1. Page de connexion OAuth
app.get('/oauth/auth', (req, res) => {
    const { client_id, redirect_uri, state } = req.query;

    res.send(`
        <html>
            <head><title>Connexion Melhome</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2>Associer Melhome à Google Home</h2>
                <form method="POST" action="/oauth/login">
                    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}" />
                    <input type="hidden" name="state" value="${state || ''}" />
                    <div style="margin: 15px;">
                        <input type="email" name="email" placeholder="Email MELCloud Home" style="padding: 10px; width: 300px; font-size: 16px;" required />
                    </div>
                    <div style="margin: 15px;">
                        <input type="password" name="password" placeholder="Mot de passe" style="padding: 10px; width: 300px; font-size: 16px;" required />
                    </div>
                    <button type="submit" style="padding: 12px 24px; background: #2196F3; color: white; border: none; cursor: pointer; font-size: 16px; border-radius: 5px;">Se connecter et autoriser</button>
                </form>
            </body>
        </html>
    `);
});

// 2. Traitement et redirection vers Google
app.post('/oauth/login', (req, res) => {
    const { redirect_uri, state } = req.body;

    if (!redirect_uri) {
        return res.status(400).send("Erreur : redirect_uri manquant.");
    }

    const authCode = "melhome_auth_code_123";
    const targetUrl = `${redirect_uri}?code=${authCode}&state=${state || ''}`;
    
    console.log(`Redirection validée vers Google : ${targetUrl}`);
    res.redirect(targetUrl);
});

// 3. Token URL (Accepte TOUT et répond au format standard OAuth2)
app.all('/oauth/token', (req, res) => {
    console.log(">>> /oauth/token A BIEN ÉTÉ APPELÉ PAR GOOGLE ! <<<");

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    res.status(200).json({
        access_token: "melhome_access_token_xyz",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "melhome_refresh_token_xyz"
    });
});

// 4. Fulfillment
app.post('/fulfillment', (req, res) => {
    res.json({
        requestId: req.body?.requestId || "req_123",
        payload: { devices: [] }
    });
});

app.listen(PORT, () => {
    console.log(`Serveur en ligne sur le port ${PORT}`);
});
