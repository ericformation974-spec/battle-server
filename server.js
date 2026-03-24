const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.get("/", (req, res) => res.send("Server OK"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let clients = [];

wss.on("connection", (ws) => {
    console.log("Client connecté");
    clients.push(ws);

    ws.on("message", (message) => {
        console.log("Message:", message.toString());

        // renvoie à tous
        clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN) {
                c.send(message.toString());
            }
        });
    });

    ws.on("close", () => {
        clients = clients.filter(c => c !== ws);
        console.log("Client déconnecté");
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("Server running on port", PORT);
});