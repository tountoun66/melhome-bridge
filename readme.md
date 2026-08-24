# ☁️ Melhome Bridge - Node.js Server (v1.1)

This repository contains the source code for the backend server (the "bridge") of the **Melhome** project.

It acts as a smart and resilient intermediary between the official MELCloud Home API (for Mitsubishi Air Conditioners) and the Google Smart Home ecosystem.

## ⚙️ How it works (v1.1 Updates)

The official MELCloud Home integration with Google Home is often limited (basic commands) and prone to disconnections and timeouts. This Node.js bridge solves these issues by offering:

*   **Full Google Smart Home compatibility:** Supports power, temperature, modes (Auto, Cool, Heat, Dry, Fan), and fan speeds.
*   **[NEW] Smart Caching System:** The MELCloud API can sometimes be slow to respond. To strictly respect Google Home's 5-second response limit, the bridge caches your device states for 30 seconds. If the API lags, it instantly serves the cached data to Google, preventing the dreaded *"Melhome is unavailable"* error.
*   **[UPDATED] Anti-crash Shield (500 Error Handling):** MELCloud Home servers frequently return unexpected HTTP 500 internal errors. This code intercepts these errors, waits for 1.5 seconds, and automatically retries the request up to 5 times in the background instead of failing.
*   **[NEW] 100% Autonomous Session Management:** The bridge does not store passwords. It exposes a secure `/api/save-cookie` endpoint. The Melhome Android app's background worker silently pushes a fresh session token to this bridge **every 2 hours**. The server instantly updates its active "master cookie", ensuring 24/7 uptime without you ever needing to re-link Google Home or manually open the mobile app.

## 📁 Project Structure

This repository is intentionally minimalist to ensure maximum performance and ultra-fast deployment:

*   `index.js`: The core of the application. It contains the Express server, OAuth authentication routes for Google, the fulfillment webhook for voice commands, the robust MELCloud Home API logic, and the background sync route for the mobile app.
*   `package.json`: The configuration file listing the necessary dependencies (only `express` to keep the project lightweight) and startup commands.

## 🚀 Easy Deployment (Render)

This server is designed to be deployed for free in just a few clicks on [Render](https://render.com/).

1. On Render, create a new **Web Service**.
2. Connect this GitHub repository.
3. Use the following settings:
   * **Build Command:** `npm install`
   * **Start Command:** `npm start`
   * **Plan:** Free
4. Once deployed, use the URL provided by Render (e.g., `https://your-project.onrender.com`) to configure your Google Actions project and your Android app.

## ⚠️ Important: Prevent Server Sleep

If you use Render's free tier, the server will go to sleep after 15 minutes of inactivity, which will cause delays during your first voice commands ("Cold Start").

To prevent this and keep the RAM intact (essential for retaining Google access tokens and your active session cookie), it is highly recommended to use a free service like **UptimeRobot**. Set up an HTTP "ping" (GET) on the route `https://your-project.onrender.com/oauth/auth` every 10 minutes to keep the bridge awake 24/7.

## 📱 Companion App

This backend server is designed to work in tandem with the **Melhome Android app (v1.1+)**. The app handles the user interface, manual vane control, hardware-encrypted credential storage, and runs the background `WorkManager` that constantly feeds this bridge with fresh authentication tokens.
