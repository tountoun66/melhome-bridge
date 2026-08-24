# ☁️ Melhome Bridge - Node.js Server

This repository contains the source code for the backend server (the "bridge") of the **Melhome** project.

It acts as a smart and resilient intermediary between the official MELCloud API (for Mitsubishi Air Conditioners) and the Google Smart Home ecosystem.

## ⚙️ How it works

The official MELCloud integration with Google Home is often limited (basic commands) and prone to disconnections. This Node.js bridge solves these issues by offering:

*   **Full Google Smart Home compatibility:** Supports power, temperature, modes (Auto, Cool, Heat, Dry, Fan), and fan speeds.
*   **Anti-crash Shield (500 Error Handling):** MELCloud servers sometimes return unexpected 500 errors. This code intercepts these errors, pauses, and automatically retries the request instead of crashing the server.
*   **Smart Session Management:** The bridge does not store your passwords. It receives a secure session token (cookie) from the Android companion app. If the token expires, the server automatically prioritizes the new token sent by the app, eliminating the need to re-link Google Home.

## 📁 Project Structure

This repository is intentionally minimalist to ensure maximum performance and ultra-fast deployment:

*   `index.js`: The core of the application. It contains the Express server, OAuth authentication routes for Google, the fulfillment webhook for voice commands, and the communication logic with the MELCloud API.
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

If you use Render's free tier, the server will go to sleep after 15 minutes of inactivity, which will cause delays during your voice commands ("Cold Start").

To prevent this and keep the RAM intact (essential for retaining Google access tokens), it is highly recommended to use a free service like **UptimeRobot**. Set up an HTTP "ping" (GET) on the route `https://your-project.onrender.com/oauth/auth` every 10 minutes to keep the bridge awake 24/7.

## 📱 Companion App

This backend server is designed to work in tandem with the **Melhome** Android app, which handles the user interface, manual vane control, and sending the authentication token to this bridge.
