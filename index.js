const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Mémoire temporaire pour stocker les sessions OAuth en cours
const oauthSessions = {};

// Middleware de suivi des requêtes
app.use((req, res, next) => {
    console.log(`[${req.method}] ${req.url}`, req.body, req.query);
    next();
});

// 1. Page de connexion (Google arrive ici)
app.get('/oauth/auth', (req, res) => {
    const { client_id, redirect_uri, state, response_type } = req.query;
    
    // Correction de la parenthèse ici :
    const sessionId = Math.random().toString(36).substring(2);
    oauthSessions[sessionId] = { redirect_uri, state };

    res.send(`
        <html>
            <head><title>Connexion Melhome</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2>Associer Melhome à Google Home</h2>
                <form method="POST" action="/oauth/login">
                    <input type="hidden" name="session_id" value="${sessionId}" />
                    <div style="margin: 10px;">
                        <input type="email" name="email" placeholder="Email MELCloud Home" style="padding: 10px; width: 300px;" required />
                    </div>
                    <div style="margin: 10px;">
                        <input type="password" name="password" placeholder="Mot de passe" style="padding: 10px; width: 300px;" required />
                    </div>
                    <button type="submit" style="padding: 10px 20px; background: #2196F3; color: white; border: none; cursor: pointer;">Se connecter et autoriser</button>
                </form>
            </body>
        </html>
    `);
});

// 2. Validation et redirection propre vers Google
app.post('/oauth/login', (req, res) => {
    const { session_id, email, password } = req.body;
    const session = oauthSessions[session_id];

    if (!session || !session.redirect_uri) {
        return res.status(400).send("Erreur de session OAuth expirée ou invalide.");
    }

    const authCode = "melhome_auth_code_123";
    const targetUrl = `${session.redirect_uri}?code=${authCode}&state=${session.state || ''}`;
    
    // Nettoyage
    delete oauthSessions[session_id];

    console.log(`Redirection vers Google : ${targetUrl}`);
    res.redirect(targetUrl);
});

// 3. Échange du code contre un jeton (Token URL)
app.all('/oauth/token', (req, res) => {
    console.log("Requête reçue sur /oauth/token avec les données :", req.body);
    res.json({
        access_token: "melhome_access_token_xyz",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "melhome_refresh_token_xyz"
    });
});

// 4. Point de commande (Fulfillment)
app.post('/fulfillment', (req, res) => {
    const body = req.body;
    res.json({
        requestId: body?.requestId || "req_123",
        payload: { devices: [] }
    });
});

app.listen(PORT, () => {
    console.log(`Serveur OAuth sécurisé en ligne sur le port ${PORT}`);
});
