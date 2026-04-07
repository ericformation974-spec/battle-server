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

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getOppositeTeam(team) {
  return team === "Brazil" ? "France" : "Brazil";
}

function loadQuestions() {
  const raw = fs.readFileSync(path.join(__dirname, "questions.json"), "utf8");
  return JSON.parse(raw).questions;
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
  ["A", "B"].forEach(id => {
    if (room.players[id]) send(room.players[id].ws, data);
  });
}

function createRoom(ws, team) {
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();

  const room = {
    code,
    players: {
      A: { ws, team },
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
    penaltyRecap: [],
    isSuddenDeath: false
  };

  rooms.set(code, room);
  clients.set(ws, { room: code, id: "A" });

  send(ws, {
    type: "ROOM_CREATED",
    roomCode: code,
    playerId: "A",
    team
  });
}

function getShooterTeam(room, shooterId) {
  return room.players[shooterId]?.team;
}

function getShooterByShotIndex(i) {
  return i % 2 === 0 ? "A" : "B";
}

function startQuestion(room) {
  const q = room.questions[room.questionCursor % room.questions.length];
  room.questionCursor++;

  room.currentShooter = getShooterByShotIndex(room.shotIndex);
  room.correct = q.correctAnswer;
  room.answers = { A: null, B: null };
  room.roundResolved = false;

  broadcast(room, {
    type: "QUESTION_STARTED",
    questionText: q.questionText,
    answers: q.answers,
    timeLimitMs: ANSWER_TIME_LIMIT_MS,
    shooter: room.currentShooter,
    shooterTeam: getShooterTeam(room, room.currentShooter)
  });

  setTimeout(() => resolveRoundTimeout(room), ANSWER_TIME_LIMIT_MS);
}

function resolveRoundTimeout(room) {
  if (room.roundResolved) return;

  if (!room.answers.A) room.answers.A = { answer: -1, time: ANSWER_TIME_LIMIT_MS };
  if (!room.answers.B) room.answers.B = { answer: -1, time: ANSWER_TIME_LIMIT_MS };

  computeRoundResult(room);
}

function computeRoundResult(room) {
  if (room.roundResolved) return;

  room.roundResolved = true;

  const A = room.answers.A;
  const B = room.answers.B;

  const correct = room.correct;

  const Aok = A.answer === correct;
  const Bok = B.answer === correct;

  let roundWinner = null;

  if (Aok && !Bok) roundWinner = "A";
  else if (Bok && !Aok) roundWinner = "B";
  else if (Aok && Bok) {
    if (A.time < B.time) roundWinner = "A";
    else if (B.time < A.time) roundWinner = "B";
  }

  const shooter = room.currentShooter;

  if (roundWinner === null) {
    startQuestion(room);
    return;
  }

  room.shots[shooter]++;

  const goalScored = roundWinner === shooter;
  if (goalScored) room.score[shooter]++;

  // 🔥 HISTORY SIMPLE
  room.history.push({
    shooterId: shooter,
    shooterTeam: getShooterTeam(room, shooter),
    success: goalScored
  });

  // 🔥 RECAP DETAILLE
  room.penaltyRecap.push({
    penaltyNumber: room.penaltyRecap.length + 1,
    shooterId: shooter,
    shooterTeam: getShooterTeam(room, shooter),
    playerATime: A.time,
    playerBTime: B.time,
    roundWinner: roundWinner || "DRAW",
    goalScored
  });

  broadcast(room, {
    type: "ROUND_RESULT",
    displayText: goalScored ? "BUT" : "RATE",
    shooter,
    shooterTeam: getShooterTeam(room, shooter),
    roundWinner,
    goalScored,
    score: room.score,
    shots: room.shots,
    history: room.history
  });

  room.shotIndex++;

  setTimeout(() => {
    if (room.shotIndex >= REGULAR_TOTAL_SHOTS) {
      finishSession(room);
    } else {
      startQuestion(room);
    }
  }, PENALTY_RESULT_VIDEO_MS);
}

function finishSession(room) {
  let winner = "draw";
  let winnerTeam = null;

  if (room.score.A > room.score.B) {
    winner = "A";
    winnerTeam = room.players.A.team;
  } else if (room.score.B > room.score.A) {
    winner = "B";
    winnerTeam = room.players.B.team;
  }

  broadcast(room, {
    type: "QUIZ_FINISHED",
    winner,
    winnerTeam,
    score: room.score,
    shots: room.shots,
    history: room.history,
    penaltyRecap: room.penaltyRecap
  });
}

wss.on("connection", ws => {
  clients.set(ws, {});
  send(ws, { type: "CONNECTED" });

  ws.on("message", msg => {
    const data = JSON.parse(msg);

    if (data.type === "CREATE_BATTLE") {
      createRoom(ws, data.team);
      return;
    }

    if (data.type === "JOIN_BATTLE") {
      const room = rooms.get(data.roomCode);
      room.players.B = { ws, team: getOppositeTeam(room.players.A.team) };
      clients.set(ws, { room: data.roomCode, id: "B" });

      send(ws, {
        type: "ROOM_JOINED",
        roomCode: data.roomCode,
        playerId: "B",
        team: room.players.B.team
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