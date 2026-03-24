const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Server OK");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// roomCode -> room
const rooms = new Map();

// ws -> { roomCode, playerId }
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
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(data));
    }
  }
}

function generateRoomCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
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

function computeResult(room) {
  const A = room.answers.A;
  const B = room.answers.B;
  const correct = room.correctAnswer;

  const Aok = A && A.answer === correct;
  const Bok = B && B.answer === correct;

  let result = "draw";

  if (Aok && !Bok) result = "A";
  else if (Bok && !Aok) result = "B";
  else if (Aok && Bok) {
    if (A.time < B.time) result = "A";
    else if (B.time < A.time) result = "B";
    else result = "draw";
  }

  let nextVideo = "draw.mp4";
  if (result === "A") nextVideo = "win_A.mp4";
  if (result === "B") nextVideo = "win_B.mp4";

  room.lastResult = result;
  room.nextVideo = nextVideo;

  broadcastToRoom(room.code, {
    type: "RESULT",
    roomCode: room.code,
    roundId: room.roundId,
    result,
    nextVideo
  });

  room.answers.A = null;
  room.answers.B = null;
}

wss.on("connection", (ws) => {
  console.log("Client connected");
  clients.set(ws, { roomCode: null, playerId: null });

  send(ws, { type: "CONNECTED" });

  ws.on("message", (raw) => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      send(ws, { type: "ERROR", message: "Invalid JSON" });
      return;
    }

    // 1) CREATE_BATTLE
    if (data.type === "CREATE_BATTLE") {
      const roomCode = createUniqueRoomCode();
      const hostToken = generateHostToken();

      const room = {
        code: roomCode,
        hostToken: hostToken,
        players: {
          A: { ws },
          B: null
        },
        answers: {
          A: null,
          B: null
        },
        roundId: 0,
        correctAnswer: 0,
        lastResult: null,
        nextVideo: "idle.mp4"
      };

      rooms.set(roomCode, room);
      clients.set(ws, { roomCode, playerId: "A" });

      console.log(`Room created: ${roomCode}`);

      send(ws, {
        type: "ROOM_CREATED",
        roomCode,
        playerId: "A",
        hostToken
      });

      return;
    }

    // 2) JOIN_BATTLE
    if (data.type === "JOIN_BATTLE") {
      const roomCode = sanitizeRoomCode(data.roomCode);
      const room = rooms.get(roomCode);

      if (!room) {
        send(ws, {
          type: "ERROR",
          message: "Room introuvable"
        });
        return;
      }

      if (room.players.B) {
        send(ws, {
          type: "ERROR",
          message: "Room complète"
        });
        return;
      }

      room.players.B = { ws };
      clients.set(ws, { roomCode, playerId: "B" });

      console.log(`Player B joined room: ${roomCode}`);

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

    // 3) SET_QUESTION (host only)
    if (data.type === "SET_QUESTION") {
      const roomCode = sanitizeRoomCode(data.roomCode);
      const room = rooms.get(roomCode);

      if (!room) {
        send(ws, {
          type: "ERROR",
          message: "Room introuvable"
        });
        return;
      }

      if (!data.hostToken || data.hostToken !== room.hostToken) {
        send(ws, {
          type: "ERROR",
          message: "Unauthorized"
        });
        return;
      }

      if (!Array.isArray(data.answers) || data.answers.length !== 4) {
        send(ws, {
          type: "ERROR",
          message: "Il faut 4 réponses"
        });
        return;
      }

      if (!Number.isInteger(data.correctAnswer) || data.correctAnswer < 0 || data.correctAnswer > 3) {
        send(ws, {
          type: "ERROR",
          message: "correctAnswer invalide"
        });
        return;
      }

      room.roundId += 1;
      room.correctAnswer = data.correctAnswer;
      room.answers.A = null;
      room.answers.B = null;

      broadcastToRoom(roomCode, {
        type: "QUESTION_STARTED",
        roomCode,
        roundId: room.roundId,
        questionText: String(data.questionText || ""),
        answers: data.answers,
        startTime: Date.now()
      });

      return;
    }

    // 4) ANSWER
    if (data.type === "ANSWER") {
      const info = clients.get(ws);

      if (!info || !info.roomCode || !info.playerId) {
        send(ws, {
          type: "ERROR",
          message: "Pas dans une room"
        });
        return;
      }

      const room = rooms.get(info.roomCode);
      if (!room) {
        send(ws, {
          type: "ERROR",
          message: "Room introuvable"
        });
        return;
      }

      if (!Number.isInteger(data.answer) || data.answer < 0 || data.answer > 3) {
        send(ws, {
          type: "ERROR",
          message: "Réponse invalide"
        });
        return;
      }

      const time = Number(data.time);
      if (!Number.isFinite(time) || time < 0) {
        send(ws, {
          type: "ERROR",
          message: "Temps invalide"
        });
        return;
      }

      room.answers[info.playerId] = {
        answer: data.answer,
        time: time
      };

      broadcastToRoom(room.code, {
        type: "ANSWER_RECEIVED",
        roomCode: room.code,
        roundId: room.roundId,
        playerId: info.playerId
      });

      if (room.answers.A && room.answers.B) {
        computeResult(room);
      }

      return;
    }

    // 5) CLOSE_ROOM (host only)
    if (data.type === "CLOSE_ROOM") {
      const roomCode = sanitizeRoomCode(data.roomCode);
      const room = rooms.get(roomCode);

      if (!room) {
        send(ws, {
          type: "ERROR",
          message: "Room introuvable"
        });
        return;
      }

      if (!data.hostToken || data.hostToken !== room.hostToken) {
        send(ws, {
          type: "ERROR",
          message: "Unauthorized"
        });
        return;
      }

      broadcastToRoom(roomCode, {
        type: "ROOM_CLOSED",
        roomCode
      });

      rooms.delete(roomCode);
      console.log(`Room closed: ${roomCode}`);
      return;
    }

    send(ws, {
      type: "ERROR",
      message: "Unknown message type"
    });
  });

  ws.on("close", () => {
    const info = clients.get(ws);

    if (info && info.roomCode) {
      const room = rooms.get(info.roomCode);

      if (room && info.playerId && room.players[info.playerId] && room.players[info.playerId].ws === ws) {
        room.players[info.playerId] = null;

        broadcastToRoom(room.code, {
          type: "PLAYER_LEFT",
          roomCode: room.code,
          playerId: info.playerId
        });

        console.log(`Player left room ${room.code}: ${info.playerId}`);
      }

      if (room && !room.players.A && !room.players.B) {
        rooms.delete(room.code);
        console.log(`Room deleted: ${room.code}`);
      }
    }

    clients.delete(ws);
    console.log("Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});