const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Server OK");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const rooms = new Map();
const clients = new Map();

function loadQuestions() {
  const filePath = path.join(__dirname, "questions.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  if (!data.questions || !Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error("questions.json invalide ou vide");
  }

  for (const q of data.questions) {
    if (
      typeof q.questionText !== "string" ||
      !Array.isArray(q.answers) ||
      q.answers.length !== 4 ||
      !Number.isInteger(q.correctAnswer) ||
      q.correctAnswer < 0 ||
      q.correctAnswer > 3
    ) {
      throw new Error("Une question dans questions.json est invalide");
    }
  }

  return data.questions;
}

const masterQuestions = loadQuestions();

function cloneQuestions() {
  return JSON.parse(JSON.stringify(masterQuestions));
}

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

function startNextQuestion(room) {
  room.currentQuestionIndex += 1;

  if (room.currentQuestionIndex >= room.questions.length) {
    broadcastToRoom(room.code, {
      type: "QUIZ_FINISHED",
      roomCode: room.code,
      totalQuestions: room.questions.length
    });
    return;
  }

  const q = room.questions[room.currentQuestionIndex];

  room.answers.A = null;
  room.answers.B = null;
  room.roundId += 1;
  room.currentCorrectAnswer = q.correctAnswer;

  broadcastToRoom(room.code, {
    type: "QUESTION_STARTED",
    roomCode: room.code,
    roundId: room.roundId,
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    questionText: q.questionText,
    answers: q.answers,
    startTime: Date.now()
  });
}

function computeRoundResult(room) {
  const A = room.answers.A;
  const B = room.answers.B;
  const correct = room.currentCorrectAnswer;

  const Aok = A && A.answer === correct;
  const Bok = B && B.answer === correct;

  let roundWinner = "draw";
  let displayText = "MATCH NUL";

  if (Aok && !Bok) {
    roundWinner = "A";
    displayText = "JOUEUR A GAGNE";
  } else if (Bok && !Aok) {
    roundWinner = "B";
    displayText = "JOUEUR B GAGNE";
  } else if (Aok && Bok) {
    if (A.time < B.time) {
      roundWinner = "A";
      displayText = "JOUEUR A GAGNE";
    } else if (B.time < A.time) {
      roundWinner = "B";
      displayText = "JOUEUR B GAGNE";
    } else {
      roundWinner = "draw";
      displayText = "MATCH NUL";
    }
  }

  broadcastToRoom(room.code, {
    type: "ROUND_RESULT",
    roomCode: room.code,
    roundId: room.roundId,
    questionIndex: room.currentQuestionIndex,
    roundWinner: roundWinner,
    displayText: displayText,
    playerA: {
      answer: A.answer,
      time: A.time,
      correct: Aok
    },
    playerB: {
      answer: B.answer,
      time: B.time,
      correct: Bok
    }
  });

  setTimeout(() => {
    startNextQuestion(room);
  }, 2000);
}

wss.on("connection", (ws) => {
  console.log("Client connected");
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

      const room = {
        code: roomCode,
        hostToken: hostToken,
        players: {
          A: { ws },
          B: null
        },
        questions: cloneQuestions(),
        currentQuestionIndex: -1,
        currentCorrectAnswer: 0,
        roundId: 0,
        answers: {
          A: null,
          B: null
        }
      };

      rooms.set(roomCode, room);
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

      setTimeout(() => {
        startNextQuestion(room);
      }, 1000);

      return;
    }

    if (data.type === "ANSWER") {
      const info = clients.get(ws);

      if (!info || !info.roomCode || !info.playerId) {
        send(ws, { type: "ERROR", message: "Pas dans une room" });
        return;
      }

      const room = rooms.get(info.roomCode);

      if (!room) {
        send(ws, { type: "ERROR", message: "Room introuvable" });
        return;
      }

      if (!Number.isInteger(data.answer) || data.answer < 0 || data.answer > 3) {
        send(ws, { type: "ERROR", message: "Réponse invalide" });
        return;
      }

      const time = Number(data.time);
      if (!Number.isFinite(time) || time < 0) {
        send(ws, { type: "ERROR", message: "Temps invalide" });
        return;
      }

      if (room.answers[info.playerId] !== null) {
        send(ws, { type: "ERROR", message: "Réponse déjà envoyée" });
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
        computeRoundResult(room);
      }

      return;
    }

    send(ws, { type: "ERROR", message: "Unknown message type" });
  });

  ws.on("close", () => {
    const info = clients.get(ws);

    if (info && info.roomCode) {
      const room = rooms.get(info.roomCode);

      if (room && info.playerId && room.players[info.playerId]?.ws === ws) {
        room.players[info.playerId] = null;

        broadcastToRoom(room.code, {
          type: "PLAYER_LEFT",
          roomCode: room.code,
          playerId: info.playerId
        });
      }

      if (room && !room.players.A && !room.players.B) {
        rooms.delete(room.code);
      }
    }

    clients.delete(ws);
    console.log("Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});