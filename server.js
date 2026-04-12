// ⚠️ VERSION CORRIGÉE (logique penalty fixée)

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

const rooms = new Map();
const clients = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ==========================
// 🔥 NOUVELLE LOGIQUE GAGNANT
// ==========================
function getSessionWinner(room) {
  const scoreA = room.score.A;
  const scoreB = room.score.B;
  const shotsA = room.shots.A;
  const shotsB = room.shots.B;

  if (!room.isSuddenDeath) {
    const remainingA = REGULAR_SHOTS_PER_TEAM - shotsA;
    const remainingB = REGULAR_SHOTS_PER_TEAM - shotsB;

    if (scoreA > scoreB + remainingB) return "A";
    if (scoreB > scoreA + remainingA) return "B";

    if (shotsA >= 5 && shotsB >= 5) {
      if (scoreA > scoreB) return "A";
      if (scoreB > scoreA) return "B";
      return "sudden_death";
    }

    return null;
  }

  if (room.suddenDeathPairShots.A === 1 && room.suddenDeathPairShots.B === 1) {
    if (room.suddenDeathPairGoals.A > room.suddenDeathPairGoals.B) return "A";
    if (room.suddenDeathPairGoals.B > room.suddenDeathPairGoals.A) return "B";
    return "next_pair";
  }

  return null;
}

// ==========================
// 🎯 FIN DE MATCH
// ==========================
function finishSession(room) {
  let winner = "draw";

  if (room.score.A > room.score.B) winner = "A";
  if (room.score.B > room.score.A) winner = "B";

  log("🏁 MATCH FINI", room.score);

  broadcast(room, {
    type: "QUIZ_FINISHED",
    winner,
    score: room.score
  });
}

// ==========================
// 🔁 CORRECTION ICI
// ==========================
function scheduleNextQuestionAfterPenalty(room) {
  clearTimeout(room.transitionTimeout);

  room.transitionTimeout = setTimeout(() => {
    const state = getSessionWinner(room);

    if (state === "A" || state === "B") {
      finishSession(room);
      return;
    }

    if (state === "sudden_death") {
      room.isSuddenDeath = true;
      room.suddenDeathPairShots = { A: 0, B: 0 };
      room.suddenDeathPairGoals = { A: 0, B: 0 };
      startQuestion(room);
      return;
    }

    if (state === "next_pair") {
      room.suddenDeathPairShots = { A: 0, B: 0 };
      room.suddenDeathPairGoals = { A: 0, B: 0 };
      startQuestion(room);
      return;
    }

    startQuestion(room);
  }, PENALTY_RESULT_VIDEO_MS);
}

// ==========================
// 🔽 TON CODE EXISTANT
// ==========================

function broadcast(room, data) {
  ["A", "B"].forEach((id) => {
    const player = room.players[id];
    if (player && player.ws) {
      player.ws.send(JSON.stringify(data));
    }
  });
}

function startQuestion(room) {
  log("➡️ Nouvelle question");
}

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "TEST_SCORE") {
      const room = {
        score: { A: data.A, B: data.B },
        shots: { A: data.shotsA, B: data.shotsB },
        isSuddenDeath: data.sd || false,
        suddenDeathPairShots: { A: 1, B: 1 },
        suddenDeathPairGoals: { A: data.goalA, B: data.goalB },
        players: { A: { ws }, B: { ws } }
      };

      scheduleNextQuestionAfterPenalty(room);
    }
  });
});

server.listen(PORT, () => {
  log("Server running on port", PORT);
});