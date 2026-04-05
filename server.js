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

const TOTAL_SHOTS_PER_TEAM = 5;
const TOTAL_ROUNDS = TOTAL_SHOTS_PER_TEAM * 2; // 10 manches au total

const rooms = new Map();   // roomCode -> room
const clients = new Map(); // ws -> { room, id }

const VIDEO_PATHS = {
  F_YES: "video/F_yes",
  F_NO: "video/F_no",
  B_YES: "video/B_yes",
  B_NO: "video/B_no",
  F_IDLE: "video/F_idle",
  B_IDLE: "video/B_idle"
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("getRandom a reçu un tableau vide ou invalide");
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomVideoPath(folder, maxIndex) {
  const n = Math.floor(Math.random() * maxIndex) + 1;
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

function getCurrentShooter(room) {
  // index 0 => France (A), index 1 => Brésil (B), etc.
  return room.index % 2 === 0 ? "A" : "B";
}

function getNextShooter(room) {
  const nextIndex = room.index + 1;
  if (nextIndex >= TOTAL_ROUNDS) {
    return null;
  }
  return nextIndex % 2 === 0 ? "A" : "B";
}

function getIdleVideoForShooter(shooter) {
  if (shooter === "A") {
    return getRandomVideoPath(VIDEO_PATHS.F_IDLE, 5);
  }
  if (shooter === "B") {
    return getRandomVideoPath(VIDEO_PATHS.B_IDLE, 5);
  }
  return null;
}

function getRoundVideos(room, roundWinner) {
  const shooter = room.currentShooter;
  const nextShooter = getNextShooter(room);

  let currentVideo = null;

  // Si la France tire
  if (shooter === "A") {
    if (roundWinner === "A") {
      currentVideo = getRandomVideoPath(VIDEO_PATHS.F_YES, 10);
    } else if (roundWinner === "B") {
      currentVideo = getRandomVideoPath(VIDEO_PATHS.F_NO, 10);
    }
  }

  // Si le Brésil tire
  if (shooter === "B") {
    if (roundWinner === "B") {
      currentVideo = getRandomVideoPath(VIDEO_PATHS.B_YES, 10);
    } else if (roundWinner === "A") {
      currentVideo = getRandomVideoPath(VIDEO_PATHS.B_NO, 10);
    }
  }

  const preloadVideo = nextShooter ? getIdleVideoForShooter(nextShooter) : null;

  return { currentVideo, preloadVideo };
}

function getRoundDisplayText(room, roundWinner) {
  const shooter = room.currentShooter;

  if (roundWinner === "draw") {
    return shooter === "A" ? "FRANCE RATE" : "BRESIL RATE";
  }

  if (shooter === "A") {
    return roundWinner === "A" ? "BUT FRANCE" : "FRANCE RATE";
  }

  return roundWinner === "B" ? "BUT BRESIL" : "BRESIL RATE";
}

function hasEarlyWinner(room) {
  const remainingA = TOTAL_SHOTS_PER_TEAM - room.shots.A;
  const remainingB = TOTAL_SHOTS_PER_TEAM - room.shots.B;

  if (room.score.A > room.score.B + remainingB) return true;
  if (room.score.B > room.score.A + remainingA) return true;

  return false;
}

function finishSession(room) {
  clearQuestionTimeout(room);

  let winner = "draw";
  let text = "SEANCE TERMINEE - EGALITE";

  if (room.score.A > room.score.B) {
    winner = "A";
    text = "FRANCE GAGNE LA SEANCE";
  } else if (room.score.B > room.score.A) {
    winner = "B";
    text = "BRESIL GAGNE LA SEANCE";
  }

  log("QUIZ_FINISHED room", room.code, "winner", winner, "score", room.score);

  broadcast(room, {
    type: "QUIZ_FINISHED",
    winner,
    displayText: text,
    score: room.score,
    shots: room.shots
  });
}

function resolveRoundTimeout(room) {
  if (!room || room.roundResolved) {
    return;
  }

  log("QUESTION_TIMEOUT room", room.code);

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

function startNextQuestion(room) {
  room.index += 1;

  if (room.index >= TOTAL_ROUNDS) {
    finishSession(room);
    return;
  }

  if (room.index >= room.questions.length) {
    log("Pas assez de questions pour terminer la séance", room.code);
    finishSession(room);
    return;
  }

  room.currentShooter = getCurrentShooter(room);

  const q = room.questions[room.index];
  if (!q) {
    throw new Error(`Question introuvable à l'index ${room.index}`);
  }

  room.correct = q.correctAnswer;
  room.answers = { A: null, B: null };
  room.roundResolved = false;

  clearQuestionTimeout(room);

  room.questionTimeout = setTimeout(() => {
    try {
      resolveRoundTimeout(room);
    } catch (err) {
      log("resolveRoundTimeout crash:", err);
    }
  }, ANSWER_TIME_LIMIT_MS);

  log(
    "QUESTION_STARTED room",
    room.code,
    "index",
    room.index,
    "shooter",
    room.currentShooter,
    "question",
    q.questionText
  );

  broadcast(room, {
    type: "QUESTION_STARTED",
    questionText: q.questionText,
    answers: q.answers,
    timeLimitMs: ANSWER_TIME_LIMIT_MS,
    round: room.index + 1,
    totalRounds: TOTAL_ROUNDS,
    shooter: room.currentShooter,
    score: room.score,
    shots: room.shots,
    preloadVideo: getIdleVideoForShooter(room.currentShooter)
  });
}

function computeRoundResult(room) {
  if (room.roundResolved) {
    return;
  }

  room.roundResolved = true;
  clearQuestionTimeout(room);

  log("computeRoundResult room", room.code, "answers =", room.answers);

  const A = room.answers.A;
  const B = room.answers.B;

  if (!A || !B) {
    throw new Error("computeRoundResult appelé sans deux réponses");
  }

  const correct = room.correct;

  const Aok = A.answer === correct;
  const Bok = B.answer === correct;

  let winner = "draw";

  if (Aok && !Bok) {
    winner = "A";
  } else if (Bok && !Aok) {
    winner = "B";
  } else if (Aok && Bok) {
    if (A.time < B.time) {
      winner = "A";
    } else if (B.time < A.time) {
      winner = "B";
    } else {
      winner = "draw";
    }
  } else {
    winner = "draw";
  }

  const shooter = room.currentShooter;

  // On compte le tir pour le tireur courant
  room.shots[shooter] += 1;

  // Le but est marqué uniquement si le tireur gagne la question
  if (winner === shooter) {
    room.score[shooter] += 1;
  }

  const text = getRoundDisplayText(room, winner);
  const { currentVideo, preloadVideo } = getRoundVideos(room, winner);

  log(
    "ROUND_RESULT room",
    room.code,
    "winner",
    winner,
    "shooter",
    shooter,
    "video",
    currentVideo,
    "preload",
    preloadVideo,
    "score",
    room.score
  );

  broadcast(room, {
    type: "ROUND_RESULT",
    displayText: text,
    roundWinner: winner,
    shooter,
    currentVideo,
    preloadVideo,
    score: room.score,
    shots: room.shots
  });

  setTimeout(() => {
    try {
      if (room.index + 1 >= TOTAL_ROUNDS || hasEarlyWinner(room)) {
        finishSession(room);
      } else {
        startNextQuestion(room);
      }
    } catch (err) {
      log("startNextQuestion after result crash:", err);
    }
  }, 2000);
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
    index: -1,
    currentShooter: "A",
    answers: { A: null, B: null },
    correct: 0,
    questionTimeout: null,
    roundResolved: false,
    score: { A: 0, B: 0 },
    shots: { A: 0, B: 0 }
  };

  rooms.set(code, room);
  clients.set(ws, { room: code, id: "A" });

  log("ROOM_CREATED", code);
  log("CLIENT A enregistré:", clients.get(ws));

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

      const noA = !room.players.A;
      const noB = !room.players.B;

      if (noA && noB) {
        clearQuestionTimeout(room);
        rooms.delete(room.code);
        log("ROOM_REMOVED", room.code);
      }
    }
  }

  clients.delete(ws);
}

wss.on("connection", (ws) => {
  log("client connected");
  clients.set(ws, {});

  send(ws, { type: "CONNECTED" });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      log("message received:", data);

      if (data.type === "CREATE_BATTLE") {
        createRoom(ws);
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

        log("ROOM_JOINED", code, "player B");
        log("CLIENT B enregistré:", clients.get(ws));

        send(ws, {
          type: "ROOM_JOINED",
          roomCode: code
        });

        broadcast(room, { type: "BATTLE_READY" });

        setTimeout(() => {
          try {
            startNextQuestion(room);
          } catch (err) {
            log("startNextQuestion duo crash:", err);
          }
        }, 1000);

        return;
      }

      if (data.type === "ANSWER") {
        const info = clients.get(ws);

        if (!info) {
          log("ERROR: client info introuvable");
          return;
        }

        if (!info.room) {
          log("ERROR: client sans room", info);
          return;
        }

        if (!info.id) {
          log("ERROR: client sans playerId", info);
          return;
        }

        const room = rooms.get(info.room);

        if (!room) {
          log("ERROR: room introuvable", info.room);
          return;
        }

        if (!room.answers) {
          log("ERROR: room.answers undefined", room);
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

        log("ANSWER reçu → room:", room.code, "player:", info.id);

        room.answers[info.id] = {
          answer: data.answer,
          time
        };

        log("ANSWER saved room", room.code, "player", info.id, room.answers[info.id]);

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
    log("client disconnected");
    cleanupClient(ws);
  });

  ws.on("error", (err) => {
    log("ws error:", err);
  });
});

server.listen(PORT, () => {
  log("Server running on port", PORT);
});