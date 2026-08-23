const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware pour analyser les données de formulaires et de requêtes JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Mémoire temporaire pour stocker les sessions OAuth en cours
const oauthSessions = {};

// Middleware de journalisation (logs) pour suivre chaque action dans Render
app.use((req, res, next) => {
    console.log(`[${req.method}] ${req.url}`, {
        body: req.body,
        query: req.query
    });
    next();
});

// 0. Page d'accueil pour réveiller Render facilement via un navigateur
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Melhome Bridge</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #2196F3;">🟢 Serveur Melhome Bridge Actif</h1>
                <p>Le serveur est éveillé et prêt pour Google Home.</p>
            </body>
        </html>
    `);
});

// 1. Page de connexion (Google arrive ici lors de l'association)
app.get('/oauth/auth', (req, res) => {
    const { client_id, redirect_uri, state, response_type } = req.query;
    
    // Génération d'un identifiant de session unique
    const sessionId = Math.random().toString(36).substring(2);
    oauthSessions[sessionId] = { redirect_uri, state };

    res.send(`
        <html>
            <head><title>Connexion Melhome</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2>Associer Melhome à Google Home</h2>
                <form method="POST" action="/oauth/login">
                    <input type="hidden" name="session_id" value="${sessionId}" />
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

// 2. Traitement de la connexion et redirection vers Google
app.post('/oauth/login', (req, res) => {
    const { session_id, email, password } = req.body;
    const session = oauthSessions[session_id];

    if (!session || !session.redirect_uri) {
        return res.status(400).send("Erreur : Session OAuth expirée ou invalide. Recommencez depuis l'application Google Home.");
    }

    const authCode = "melhome_auth_code_123";
    const targetUrl = `${session.redirect_uri}?code=${authCode}&state=${session.state || ''}`;
    
    // Nettoyage de la session temporaire
    delete oauthSessions[session_id];

    console.log(`Redirection validée vers Google : ${targetUrl}`);
    res.redirect(targetUrl);
});

// 3. Échange du code contre un jeton (Token URL exigé par Google)
app.all('/oauth/token', (req, res) => {
    console.log("=== REQUÊTE TOKEN REÇUE ===");
    console.log("Paramètres reçus (Body) :", req.body);
    console.log("Paramètres reçus (Query) :", req.query);

    // Réponse au format OAuth2 standard attendu par Google Home
    res.status(200).json({
        access_token: "melhome_access_token_xyz",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "melhome_refresh_token_xyz"
    });
});

// 4. Point de commande (Fulfillment pour Google Smart Home)
app.post('/fulfillment', (req, res) => {
    const body = req.body;
    console.log("Requête fulfillment reçue :", JSON.stringify(body, null, 2));
    
    res.json({
        requestId: body?.requestId || "req_123",
        payload: {
            devices: []
        }
    });
});

app.listen(PORT, () => {
    console.log(`Serveur Melhome Bridge en ligne sur le port ${PORT}`);
});
