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

const VIDEO_CONFIG = {
  playerAWin: [
    "win_A_1.mp4","win_A_2.mp4","win_A_3.mp4","win_A_4.mp4","win_A_5.mp4",
    "win_A_6.mp4","win_A_7.mp4","win_A_8.mp4","win_A_9.mp4","win_A_10.mp4"
  ],
  playerBWin: [
    "win_B_1.mp4","win_B_2.mp4","win_B_3.mp4","win_B_4.mp4","win_B_5.mp4",
    "win_B_6.mp4","win_B_7.mp4","win_B_8.mp4","win_B_9.mp4","win_B_10.mp4"
  ],
  draw: [
    "draw_1.mp4","draw_2.mp4","draw_3.mp4","draw_4.mp4","draw_5.mp4",
    "draw_6.mp4","draw_7.mp4","draw_8.mp4","draw_9.mp4","draw_10.mp4"
  ],
  idle: [
    "idle_1.mp4","idle_2.mp4","idle_3.mp4","idle_4.mp4","idle_5.mp4",
    "idle_6.mp4","idle_7.mp4","idle_8.mp4","idle_9.mp4","idle_10.mp4"
  ]
};

function getRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function loadQuestions() {
  const filePath = path.join(__dirname, "questions.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8")).questions;
}

const masterQuestions = loadQuestions();

function cloneQuestions() {
  return JSON.parse(JSON.stringify(masterQuestions));
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(data));
}

function broadcast(room, data) {
  ["A", "B"].forEach(p => {
    const player = room.players[p];
    if (player && !player.isBot)
      send(player.ws, data);
  });
}

function computeRoundResult(room) {
  const A = room.answers.A;
  const B = room.answers.B;
  const correct = room.correct;

  const Aok = A.answer === correct;
  const Bok = B.answer === correct;

  let winner = "draw";
  let text = "MATCH NUL";

  if (Aok && !Bok) {
    winner = "A";
    text = "JOUEUR A GAGNE";
  } else if (Bok && !Aok) {
    winner = "B";
    text = "JOUEUR B GAGNE";
  } else if (Aok && Bok) {
    if (A.time < B.time) {
      winner = "A";
      text = "JOUEUR A GAGNE";
    } else if (B.time < A.time) {
      winner = "B";
      text = "JOUEUR B GAGNE";
    }
  }

  let currentVideo;
  if (winner === "A") currentVideo = getRandom(VIDEO_CONFIG.playerAWin);
  else if (winner === "B") currentVideo = getRandom(VIDEO_CONFIG.playerBWin);
  else currentVideo = getRandom(VIDEO_CONFIG.draw);

  const preloadVideo = getRandom(VIDEO_CONFIG.idle);

  broadcast(room, {
    type: "ROUND_RESULT",
    displayText: text,
    currentVideo,
    preloadVideo
  });

  setTimeout(() => startQuestion(room), 2000);
}

function startQuestion(room) {
  room.index++;

  if (room.index >= room.questions.length) {
    broadcast(room, { type: "QUIZ_FINISHED" });
    return;
  }

  const q = room.questions[room.index];

  room.correct = q.correctAnswer;
  room.answers = { A: null, B: null };

  broadcast(room, {
    type: "QUESTION_STARTED",
    questionText: q.questionText,
    answers: q.answers
  });

  if (room.isSolo) {
    const delay = Math.random() * 2 + 1;
    setTimeout(() => {
      room.answers.B = {
        answer: Math.floor(Math.random() * 4),
        time: delay
      };

      if (room.answers.A) computeRoundResult(room);
    }, delay * 1000);
  }
}

function createRoom(ws, solo) {
  const code = crypto.randomBytes(2).toString("hex").toUpperCase();

  const room = {
    code,
    isSolo: solo,
    players: {
      A: { ws },
      B: solo ? { isBot: true } : null
    },
    questions: cloneQuestions(),
    index: -1,
    answers: {}
  };

  rooms.set(code, room);
  clients.set(ws, { room: code, id: "A" });

  send(ws, { type: "ROOM_CREATED", roomCode: code });

  if (solo) {
    broadcast(room, { type: "BATTLE_READY" });
    setTimeout(() => startQuestion(room), 1000);
  }
}

wss.on("connection", (ws) => {
  clients.set(ws, {});

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "CREATE_SOLO_BATTLE")
      return createRoom(ws, true);

    if (data.type === "CREATE_BATTLE")
      return createRoom(ws, false);

    if (data.type === "JOIN_BATTLE") {
      const room = rooms.get(data.roomCode);
      if (!room || room.players.B) return;

      room.players.B = { ws };
      clients.set(ws, { room: data.roomCode, id: "B" });

      broadcast(room, { type: "BATTLE_READY" });
      setTimeout(() => startQuestion(room), 1000);
    }

    if (data.type === "ANSWER") {
      const info = clients.get(ws);
      const room = rooms.get(info.room);

      room.answers[info.id] = {
        answer: data.answer,
        time: data.time
      };

      if (room.answers.A && room.answers.B)
        computeRoundResult(room);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});