const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 1. Page de connexion (Authorization URL demandée par Google)
app.get('/oauth/auth', (req, res) => {
    const { client_id, redirect_uri, state, response_type } = req.query;
    // Affiche une simple page pour que l'utilisateur saisie ses identifiants
    res.send(`
        <html>
            <head><title>Connexion Melhome</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2>Associer Melhome à Google Home</h2>
                <form method="POST" action="/oauth/login">
                    <input type="hidden" name="client_id" value="${client_id}" />
                    <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
                    <input type="hidden" name="state" value="${state}" />
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

// 2. Traitement de la connexion et redirection vers Google
app.post('/oauth/login', (req, res) => {
    const { redirect_uri, state, email, password } = req.body;
    // TODO: Ici, valider l'email/mot de passe auprès de MELCloud Home si besoin
    
    // On génère un code d'autorisation temporaire
    const authCode = "melhome_auth_code_123";
    res.redirect(`${redirect_uri}?code=${authCode}&state=${state}`);
});

// 3. Échange du code contre un jeton (Token URL demandée par Google)
app.post('/oauth/token', (req, res) => {
    res.json({
        access_token: "melhome_access_token_xyz",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "melhome_refresh_token_xyz"
    });
});

// 4. Point de commande (Fulfillment pour Google Home)
app.post('/fulfillment', (req, res) => {
    const body = req.body;
    res.json({
        requestId: body.requestId,
        payload: { devices: [] }
    });
});

app.listen(PORT, () => {
    console.log(`Serveur OAuth & Fulfillment en ligne sur le port ${PORT}`);
});
