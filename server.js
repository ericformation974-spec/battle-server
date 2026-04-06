const express = require("express");
const http = require("http");
const WebSocket = require("ws");
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

const ANSWER_TIME_LIMIT_MS = 5000;
const PENALTY_RESULT_VIDEO_MS = 8000;
const QUESTION_AFTER_IDLE_DELAY_MS = 80;

const REGULAR_SHOTS_PER_TEAM = 5;
const REGULAR_TOTAL_SHOTS = REGULAR_SHOTS_PER_TEAM * 2;

const rooms = new Map();
const clients = new Map();

const VIDEO_PATHS = {
  F_YES: "VIDEO/F_yes",
  F_NO: "VIDEO/F_no",
  B_YES: "VIDEO/B_yes",
  B_NO: "VIDEO/B_no",
  F_IDLE: "VIDEO/F_idle",
  B_IDLE: "VIDEO/B_idle",
  FINAL_F_WIN: "VIDEO/FINAL/F_win",
  FINAL_B_WIN: "VIDEO/FINAL/B_win",
  FINAL_DRAW: "VIDEO/FINAL/draw"
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getOppositeTeam(team) {
  return team === "Brazil" ? "France" : "Brazil";
}

function getRandomVideoPath(folder, max) {
  const n = Math.floor(Math.random() * max) + 1;
  return `${folder}/${n}.mp4`;
}

function loadQuestions() {
  const filePath = path.join(__dirname, "questions.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return parsed.questions;
}

const masterQuestions = loadQuestions();

function cloneQuestions() {
  return JSON.parse(JSON.stringify(masterQuestions));
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  ["A", "B"].forEach((id) => {
    if (room.players[id]) send(room.players[id].ws, data);
  });
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createUniqueRoomCode() {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));
  return code;
}

function sanitizeRoomCode(value) {
  return String(value || "").trim().toUpperCase();
}

function clearTimeoutSafe(ref) {
  if (ref) clearTimeout(ref);
}

function getShooterByShotIndex(i) {
  return i % 2 === 0 ? "A" : "B";
}

function getPenaltyVideoForShooter(shooter, goal) {
  if (shooter === "A") {
    return goal
      ? getRandomVideoPath(VIDEO_PATHS.F_YES, 5)
      : getRandomVideoPath(VIDEO_PATHS.F_NO, 5);
  }
  return goal
    ? getRandomVideoPath(VIDEO_PATHS.B_YES, 5)
    : getRandomVideoPath(VIDEO_PATHS.B_NO, 5);
}

function getPenaltyDisplayText(shooter, goal) {
  if (shooter === "A") return goal ? "BUT FRANCE" : "FRANCE RATE";
  return goal ? "BUT BRESIL" : "BRESIL RATE";
}

function createRoom(ws, team) {
  const code = createUniqueRoomCode();
  const safeTeam = team === "Brazil" ? "Brazil" : "France";

  const room = {
    code,
    players: {
      A: { ws, team: safeTeam },
      B: null
    },
    questions: cloneQuestions(),
    questionCursor: 0,
    shotIndex: 0,
    currentShooter: "A",
    answers: { A: null, B: null },
    correct: 0,
    roundResolved: false,
    score: { A: 0, B: 0 },
    shots: { A: 0, B: 0 },
    history: [],
    isSuddenDeath: false
  };

  rooms.set(code, room);
  clients.set(ws, { room: code, id: "A" });

  send(ws, {
    type: "ROOM_CREATED",
    roomCode: code,
    team: safeTeam
  });
}

function startQuestion(room) {
  const q = room.questions[room.questionCursor++ % room.questions.length];

  room.currentShooter = getShooterByShotIndex(room.shotIndex);
  room.correct = q.correctAnswer;
  room.answers = { A: null, B: null };
  room.roundResolved = false;

  broadcast(room, {
    type: "QUESTION_STARTED",
    questionText: q.questionText,
    answers: q.answers,
    timeLimitMs: ANSWER_TIME_LIMIT_MS
  });
}

function computeRoundResult(room) {
  if (room.roundResolved) return;

  room.roundResolved = true;

  const A = room.answers.A;
  const B = room.answers.B;

  const correct = room.correct;

  const Aok = A.answer === correct;
  const Bok = B.answer === correct;

  let winner = null;

  if (Aok && !Bok) winner = "A";
  else if (Bok && !Aok) winner = "B";
  else if (Aok && Bok) {
    winner = A.time < B.time ? "A" : "B";
  }

  const shooter = room.currentShooter;

  if (winner === null) {
    startQuestion(room);
    return;
  }

  room.shots[shooter]++;

  const goal = winner === shooter;

  if (goal) room.score[shooter]++;

  room.history.push({
    team: shooter,
    success: goal
  });

  const video = getPenaltyVideoForShooter(shooter, goal);
  const text = getPenaltyDisplayText(shooter, goal);

  broadcast(room, {
    type: "ROUND_RESULT",
    displayText: text,
    currentVideo: video,
    score: room.score,
    shots: room.shots,
    history: room.history
  });

  room.shotIndex++;

  setTimeout(() => startQuestion(room), PENALTY_RESULT_VIDEO_MS);
}

wss.on("connection", (ws) => {
  clients.set(ws, {});
  send(ws, { type: "CONNECTED" });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === "CREATE_BATTLE") {
      createRoom(ws, data.team);
      return;
    }

    if (data.type === "JOIN_BATTLE") {
      const room = rooms.get(sanitizeRoomCode(data.roomCode));

      const teamB = getOppositeTeam(room.players.A.team);

      room.players.B = { ws, team: teamB };
      clients.set(ws, { room: room.code, id: "B" });

      send(ws, {
        type: "ROOM_JOINED",
        roomCode: room.code,
        team: teamB
      });

      broadcast(room, {
        type: "BATTLE_READY",
        yourTeam: room.players.A.team,
        opponentTeam: room.players.B.team
      });

      setTimeout(() => startQuestion(room), 1000);
      return;
    }

    if (data.type === "ANSWER") {
      const info = clients.get(ws);
      const room = rooms.get(info.room);

      if (room.roundResolved) return;

      room.answers[info.id] = {
        answer: data.answer,
        time: data.time
      };

      if (room.answers.A && room.answers.B) {
        computeRoundResult(room);
      }
    }
  });
});

server.listen(PORT, () => {
  log("Server running on port", PORT);
});