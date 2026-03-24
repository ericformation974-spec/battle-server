const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_req, res) => res.send("Server OK"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const rooms = new Map();
const clients = new Map();

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToRoom(roomCode, data) {
  const room = rooms.get(roomCode);
  if (!room) return;

  for (const slot of ["A", "B"]) {
    const player = room.players[slot];
    if (player?.ws?.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(data));
    }
  }
}

function generateRoomCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createUniqueRoomCode() {
  let code;
  do {
    code = generateRoomCode(4);
  } while (rooms.has(code));
  return code;
}

function generateHostToken() {
  return crypto.randomBytes(24).toString("hex");
}

function sanitizeRoomCode(value) {
  return String(value || "").trim().toUpperCase();
}

wss.on("connection", (ws) => {
  clients.set(ws, { roomCode: null, playerId: null });
  send(ws, { type: "CONNECTED" });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "ERROR", message: "Invalid JSON" });
      return;
    }

    if (data.type === "CREATE_BATTLE") {
      const roomCode = createUniqueRoomCode();
      const hostToken = generateHostToken();

      rooms.set(roomCode, {
        code: roomCode,
        hostToken,
        players: {
          A: { ws },
          B: null
        }
      });

      clients.set(ws, { roomCode, playerId: "A" });

      send(ws, {
        type: "ROOM_CREATED",
        roomCode,
        playerId: "A",
        hostToken
      });
      return;
    }

    if (data.type === "JOIN_BATTLE") {
      const roomCode = sanitizeRoomCode(data.roomCode);
      const room = rooms.get(roomCode);

      if (!room) {
        send(ws, { type: "ERROR", message: "Room introuvable" });
        return;
      }

      if (room.players.B) {
        send(ws, { type: "ERROR", message: "Room complète" });
        return;
      }

      room.players.B = { ws };
      clients.set(ws, { roomCode, playerId: "B" });

      send(ws, {
        type: "ROOM_JOINED",
        roomCode,
        playerId: "B"
      });

      broadcastToRoom(roomCode, {
        type: "BATTLE_READY",
        roomCode
      });
      return;
    }

    send(ws, { type: "ERROR", message: "Unknown message type" });
  });

  ws.on("close", () => {
    const info = clients.get(ws);
    if (info?.roomCode) {
      const room = rooms.get(info.roomCode);
      if (room && info.playerId && room.players[info.playerId]?.ws === ws) {
        room.players[info.playerId] = null;
      }

      if (room && !room.players.A && !room.players.B) {
        rooms.delete(info.roomCode);
      }
    }

    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});