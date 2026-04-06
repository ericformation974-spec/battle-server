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

function getRandomVideoPath(folder, max) {
  const n = Math.floor(Math.random() * max) + 1;
  return `${folder}/${n}.mp4`;
}

function loadQuestions() {
  const filePath = path.join(__dirname, "questions.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed.questions || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error("questions.json invalide ou vide");
  }

  for (const q of parsed.questions) {
    if (
      typeof q.questionText !== "string" ||
      !Array.isArray(q.answers) ||
      q.answers.length !== 4 ||
      !Number.isInteger(q.correctAnswer) ||
      q.correctAnswer < 0 ||
      q.correctAnswer > 3
    ) {
      throw new Error("Question invalide dans questions.json");
    }
  }

  return parsed.questions;
}

const masterQuestions = loadQuestions();

function cloneQuestions() {
  return JSON.parse(JSON.stringify(masterQuestions));
}

function send(ws, data) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch (err) {
    log("send error:", err);
  }
}

function broadcast(room, data) {
  ["A", "B"].forEach((id) => {
    const player = room.players[id];
    if (!player) return;
    send(player.ws, data);
  });
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

function sanitizeRoomCode(value) {
  return String(value || "").trim().toUpperCase();
}

function clearQuestionTimeout(room) {
  if (room.questionTimeout) {
    clearTimeout(room.questionTimeout);
    room.questionTimeout = null;
  }
}

function clearTransitionTimeout(room) {
  if (room.transitionTimeout) {
    clearTimeout(room.transitionTimeout);
    room.transitionTimeout = null;
  }
}

function clearQuestionDisplayTimeout(room) {
  if (room.questionDisplayTimeout) {
    clearTimeout(room.questionDisplayTimeout);
    room.questionDisplayTimeout = null;
  }
}

function getShooterByShotIndex(shotIndex) {
  return shotIndex % 2 === 0 ? "A" : "B";
}

function getIdleVideoForShooter(shooter) {
  if (shooter === "A") {
    return getRandomVideoPath(VIDEO_PATHS.F_IDLE, 5);
  }
  return getRandomVideoPath(VIDEO_PATHS.B_IDLE, 5);
}

function getPenaltyVideoForShooter(shooter, goalScored) {
  if (shooter === "A") {
    return goalScored
      ? getRandomVideoPath(VIDEO_PATHS.F_YES, 10)
      : getRandomVideoPath(VIDEO_PATHS.F_NO, 10);
  }

  return goalScored
    ? getRandomVideoPath(VIDEO_PATHS.B_YES, 10)
    : getRandomVideoPath(VIDEO_PATHS.B_NO, 10);
}

function getPenaltyDisplayText(shooter, goalScored) {
  if (shooter === "A") {
    return goalScored ? "BUT FRANCE" : "FRANCE RATE";
  }
  return goalScored ? "BUT BRESIL" : "BRESIL RATE";
}

function getFinalVideo(finalWinner) {
  if (finalWinner === "A") {
    return getRandomVideoPath(VIDEO_PATHS.FINAL_F_WIN, 5);
  }
  if (finalWinner === "B") {
    return getRandomVideoPath(VIDEO_PATHS.FINAL_B_WIN, 5);
  }
  return getRandomVideoPath(VIDEO_PATHS.FINAL_DRAW, 3);
}

function canEndEarlyDuringRegular(room) {
  if (room.isSuddenDeath) return false;

  const remainingA = REGULAR_SHOTS_PER_TEAM - room.shots.A;
  const remainingB = REGULAR_SHOTS_PER_TEAM - room.shots.B;

  if (room.score.A > room.score.B + remainingB) return true;
  if (room.score.B > room.score.A + remainingA) return true;

  return false;
}

function resetSuddenDeathPair(room) {
  room.suddenDeathPairShots = { A: 0, B: 0 };
  room.suddenDeathPairGoals = { A: 0, B: 0 };
}

function getSuddenDeathWinner(room) {
  if (!room.isSuddenDeath) return null;

  if (room.suddenDeathPairShots.A === 1 && room.suddenDeathPairShots.B === 1) {
    if (room.suddenDeathPairGoals.A > room.suddenDeathPairGoals.B) return "A";
    if (room.suddenDeathPairGoals.B > room.suddenDeathPairGoals.A) return "B";
  }

  return null;
}

function finishSession(room) {
  clearQuestionTimeout(room);
  clearTransitionTimeout(room);
  clearQuestionDisplayTimeout(room);

  let finalWinner = "draw";
  let finalText = "SEANCE TERMINEE - EGALITE";

  if (room.score.A > room.score.B) {
    finalWinner = "A";
    finalText = "FRANCE GAGNE LA SEANCE";
  } else if (room.score.B > room.score.A) {
    finalWinner = "B";
    finalText = "BRESIL GAGNE LA SEANCE";
  }

  const finalVideo = getFinalVideo(finalWinner);

  broadcast(room, {
    type: "QUIZ_FINISHED",
    winner: finalWinner,
    displayText: finalText,
    score: room.score,
    shots: room.shots,
    history: room.history,
    finalVideo
  });
}

function resolveRoundTimeout(room) {
  if (!room || room.roundResolved) return;

  if (room.answers.A === null) {
    room.answers.A = {
      answer: -1,
      time: ANSWER_TIME_LIMIT_MS
    };
  }

  if (room.answers.B === null) {
    room.answers.B = {
      answer: -1,
      time: ANSWER_TIME_LIMIT_MS
    };
  }

  computeRoundResult(room);
}

function getNextQuestion(room) {
  const questionIndex = room.questionCursor % room.questions.length;
  room.questionCursor += 1;
  return room.questions[questionIndex];
}

function startQuestion(room) {
  clearQuestionTimeout(room);
  clearTransitionTimeout(room);
  clearQuestionDisplayTimeout(room);

  const q = getNextQuestion(room);
  if (!q) {
    throw new Error("Question introuvable");
  }

  room.currentShooter = getShooterByShotIndex(room.shotIndex);
  room.correct = q.correctAnswer;
  room.answers = { A: null, B: null };
  room.roundResolved = false;

  const idleVideo = getIdleVideoForShooter(room.currentShooter);

  broadcast(room, {
    type: "IDLE_VIDEO",
    currentVideo: idleVideo,
    preloadVideo: idleVideo,
    shooter: room.currentShooter,
    score: room.score,
    shots: room.shots,
    history: room.history,
    isSuddenDeath: room.isSuddenDeath
  });

  room.questionDisplayTimeout = setTimeout(() => {
    try {
      broadcast(room, {
        type: "QUESTION_STARTED",
        questionText: q.questionText,
        answers: q.answers,
        timeLimitMs: ANSWER_TIME_LIMIT_MS,
        shooter: room.currentShooter,
        score: room.score,
        shots: room.shots,
        history: room.history,
        isSuddenDeath: room.isSuddenDeath
      });

      room.questionTimeout = setTimeout(() => {
        try {
          resolveRoundTimeout(room);
        } catch (err) {
          log("resolveRoundTimeout crash:", err);
        }
      }, ANSWER_TIME_LIMIT_MS);
    } catch (err) {
      log("QUESTION_STARTED crash:", err);
    }
  }, QUESTION_AFTER_IDLE_DELAY_MS);
}

function scheduleNextQuestionAfterPenalty(room) {
  clearTransitionTimeout(room);

  room.transitionTimeout = setTimeout(() => {
    try {
      if (canEndEarlyDuringRegular(room)) {
        finishSession(room);
        return;
      }

      const suddenDeathWinner = getSuddenDeathWinner(room);
      if (suddenDeathWinner) {
        finishSession(room);
        return;
      }

      if (!room.isSuddenDeath && room.shotIndex >= REGULAR_TOTAL_SHOTS) {
        if (room.score.A === room.score.B) {
          room.isSuddenDeath = true;
          resetSuddenDeathPair(room);
        } else {
          finishSession(room);
          return;
        }
      }

      if (
        room.isSuddenDeath &&
        room.suddenDeathPairShots.A === 1 &&
        room.suddenDeathPairShots.B === 1 &&
        room.suddenDeathPairGoals.A === room.suddenDeathPairGoals.B
      ) {
        resetSuddenDeathPair(room);
      }

      startQuestion(room);
    } catch (err) {
      log("scheduleNextQuestionAfterPenalty crash:", err);
    }
  }, PENALTY_RESULT_VIDEO_MS);
}

function scheduleSameShooterNewQuestion(room) {
  clearTransitionTimeout(room);

  room.transitionTimeout = setTimeout(() => {
    try {
      startQuestion(room);
    } catch (err) {
      log("scheduleSameShooterNewQuestion crash:", err);
    }
  }, 0);
}

function computeRoundResult(room) {
  if (room.roundResolved) return;

  room.roundResolved = true;
  clearQuestionTimeout(room);
  clearQuestionDisplayTimeout(room);

  const A = room.answers.A;
  const B = room.answers.B;

  if (!A || !B) {
    throw new Error("computeRoundResult appelé sans deux réponses");
  }

  const correct = room.correct;
  const Aok = A.answer === correct;
  const Bok = B.answer === correct;

  let roundWinner = null;

  if (Aok && !Bok) {
    roundWinner = "A";
  } else if (Bok && !Aok) {
    roundWinner = "B";
  } else if (Aok && Bok) {
    if (A.time < B.time) roundWinner = "A";
    else if (B.time < A.time) roundWinner = "B";
    else roundWinner = null;
  } else {
    roundWinner = null;
  }

  const shooter = room.currentShooter;

  if (roundWinner === null) {
    broadcast(room, {
      type: "NO_WINNER",
      displayText: "AUCUN GAGNANT - NOUVELLE QUESTION",
      shooter,
      score: room.score,
      shots: room.shots,
      history: room.history,
      isSuddenDeath: room.isSuddenDeath
    });

    scheduleSameShooterNewQuestion(room);
    return;
  }

  room.shots[shooter] += 1;

  const goalScored = roundWinner === shooter;
  if (goalScored) {
    room.score[shooter] += 1;
  }

  if (!room.history) {
    room.history = [];
  }

  room.history.push({
    team: shooter,
    success: goalScored
  });

  if (room.isSuddenDeath) {
    room.suddenDeathPairShots[shooter] += 1;
    if (goalScored) {
      room.suddenDeathPairGoals[shooter] += 1;
    }
  }

  const currentVideo = getPenaltyVideoForShooter(shooter, goalScored);
  const text = getPenaltyDisplayText(shooter, goalScored);

  broadcast(room, {
    type: "ROUND_RESULT",
    displayText: text,
    shooter,
    roundWinner,
    goalScored,
    currentVideo,
    preloadVideo: "",
    score: room.score,
    shots: room.shots,
    history: room.history,
    isSuddenDeath: room.isSuddenDeath
  });

  room.shotIndex += 1;
  scheduleNextQuestionAfterPenalty(room);
}

  if (room.isSuddenDeath) {
    room.suddenDeathPairShots[shooter] += 1;
    if (goalScored) {
      room.suddenDeathPairGoals[shooter] += 1;
    }
  }

  const currentVideo = getPenaltyVideoForShooter(shooter, goalScored);
  const text = getPenaltyDisplayText(shooter, goalScored);

  broadcast(room, {
    type: "ROUND_RESULT",
    displayText: text,
    shooter,
    roundWinner,
    goalScored,
    currentVideo,
    preloadVideo: "",
    score: room.score,
    shots: room.shots,
    history: room.history,
    isSuddenDeath: room.isSuddenDeath
  });

  room.shotIndex += 1;
  scheduleNextQuestionAfterPenalty(room);
}

function createRoom(ws) {
  const code = createUniqueRoomCode();

  const room = {
    code,
    players: {
      A: { ws },
      B: null
    },
    questions: cloneQuestions(),
    questionCursor: 0,
    shotIndex: 0,
    currentShooter: "A",
    answers: { A: null, B: null },
    correct: 0,
    questionTimeout: null,
    transitionTimeout: null,
    questionDisplayTimeout: null,
    roundResolved: false,
    score: { A: 0, B: 0 },
    shots: { A: 0, B: 0 },
    history: [],
    isSuddenDeath: false,
    suddenDeathPairShots: { A: 0, B: 0 },
    suddenDeathPairGoals: { A: 0, B: 0 }
  };

  rooms.set(code, room);
  clients.set(ws, { room: code, id: "A" });

  send(ws, {
    type: "ROOM_CREATED",
    roomCode: code
  });
}

function cleanupClient(ws) {
  const info = clients.get(ws);

  if (info && info.room) {
    const room = rooms.get(info.room);

    if (room) {
      if (info.id === "A" && room.players.A && room.players.A.ws === ws) {
        room.players.A = null;
      }

      if (info.id === "B" && room.players.B && room.players.B.ws === ws) {
        room.players.B = null;
      }

      if (!room.players.A && !room.players.B) {
        clearQuestionTimeout(room);
        clearTransitionTimeout(room);
        clearQuestionDisplayTimeout(room);
        rooms.delete(room.code);
      }
    }
  }

  clients.delete(ws);
}

wss.on("connection", (ws) => {
  clients.set(ws, {});
  send(ws, { type: "CONNECTED" });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "CREATE_BATTLE") {
        createRoom(ws);
        return;
      }

      if (data.type === "CREATE_SOLO_BATTLE") {
        createRoom(ws);

        const info = clients.get(ws);
        const room = info && info.room ? rooms.get(info.room) : null;

        if (!room) {
          send(ws, { type: "ERROR", message: "Impossible de créer la room solo" });
          return;
        }

        room.players.B = { ws };
        broadcast(room, { type: "BATTLE_READY" });

        setTimeout(() => {
          try {
            startQuestion(room);
          } catch (err) {
            log("startQuestion solo crash:", err);
          }
        }, 1000);

        return;
      }

      if (data.type === "JOIN_BATTLE") {
        const code = sanitizeRoomCode(data.roomCode);
        const room = rooms.get(code);

        if (!room) {
          send(ws, { type: "ERROR", message: "Room introuvable" });
          return;
        }

        if (room.players.B) {
          send(ws, { type: "ERROR", message: "Room complète" });
          return;
        }

        room.players.B = { ws };
        clients.set(ws, { room: code, id: "B" });

        send(ws, {
          type: "ROOM_JOINED",
          roomCode: code
        });

        broadcast(room, { type: "BATTLE_READY" });

        setTimeout(() => {
          try {
            startQuestion(room);
          } catch (err) {
            log("startQuestion duo crash:", err);
          }
        }, 1000);

        return;
      }

      if (data.type === "ANSWER") {
        const info = clients.get(ws);

        if (!info || !info.room || !info.id) {
          send(ws, { type: "ERROR", message: "Client non associé à une room" });
          return;
        }

        const room = rooms.get(info.room);

        if (!room) {
          send(ws, { type: "ERROR", message: "Room introuvable" });
          return;
        }

        if (room.roundResolved) {
          send(ws, { type: "ERROR", message: "Round déjà terminé" });
          return;
        }

        if (!Number.isInteger(data.answer) || data.answer < 0 || data.answer > 3) {
          send(ws, { type: "ERROR", message: "Réponse invalide" });
          return;
        }

        const time = Number(data.time);
        if (!Number.isFinite(time) || time < 0 || time > ANSWER_TIME_LIMIT_MS) {
          send(ws, { type: "ERROR", message: "Temps invalide" });
          return;
        }

        if (room.answers[info.id] !== null) {
          send(ws, { type: "ERROR", message: "Réponse déjà envoyée" });
          return;
        }

        room.answers[info.id] = {
          answer: data.answer,
          time
        };

        broadcast(room, {
          type: "ANSWER_RECEIVED",
          roomCode: room.code,
          playerId: info.id
        });

        if (room.answers.A && room.answers.B) {
          computeRoundResult(room);
        }

        return;
      }

      send(ws, { type: "ERROR", message: "Unknown message type" });
    } catch (err) {
      log("message handler crash:", err);
      send(ws, { type: "ERROR", message: "Server crash in message handler" });
    }
  });

  ws.on("close", () => {
    cleanupClient(ws);
  });

  ws.on("error", (err) => {
    log("ws error:", err);
  });
});

server.listen(PORT, () => {
  log("Server running on port", PORT);
});