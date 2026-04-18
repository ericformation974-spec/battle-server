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
  FINAL_F_WIN: "VIDEO/Final/F_win",
  FINAL_B_WIN: "VIDEO/Final/B_win",
  FINAL_DRAW: "VIDEO/Final/draw"
};

const BOT_PROFILES = {
  easy: {
    correctChance: 0.45,
    minTimeMs: 2600,
    maxTimeMs: 4200
  },
  medium: {
    correctChance: 0.65,
    minTimeMs: 1700,
    maxTimeMs: 3000
  },
  expert: {
    correctChance: 0.85,
    minTimeMs: 900,
    maxTimeMs: 1800
  }
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

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function safeSchoolLevel(value) {
  return ["primary", "middle_school", "high_school"].includes(value)
    ? value
    : "middle_school";
}

function safeQuestionDifficulty(value) {
  return ["easy", "medium", "expert"].includes(value)
    ? value
    : "medium";
}

function safeBotDifficulty(value) {
  return ["easy", "medium", "expert"].includes(value)
    ? value
    : "medium";
}

function safeSubject(value) {
  return ["math", "science", "languages", "geography", "history", "french"].includes(value)
    ? value
    : "math";
}

function safeSubtopic(subject, value) {
  const subjectSafe = safeSubject(subject);

  const allowed = {
    math: ["calcul", "geometry", "probability"],
    science: ["physics", "chemistry", "biology"],
    languages: ["english", "french", "spanish"],
    geography: ["country", "sea", "land"],
    history: ["conflicts", "civilisations", "politics"],
    french: ["grammar", "vocabulary", "reading"]
  };

  const list = allowed[subjectSafe] || [];
  return list.includes(value) ? value : list[0] || "calcul";
}

function getBotProfile(botDifficulty) {
  return BOT_PROFILES[safeBotDifficulty(botDifficulty)];
}

// CORRIGÉ : questionDifficulty ne sert plus au chemin des fichiers
function loadQuestionsByPath(schoolLevel, _questionDifficulty, subject, subtopic) {
  const level = safeSchoolLevel(schoolLevel);
  const safeSubj = safeSubject(subject);
  const safeSub = safeSubtopic(safeSubj, subtopic);

  const filePath = path.join(
    __dirname,
    "questions",
    level,
    safeSubj,
    `${safeSub}.json`
  );

  log("Chargement questions:", filePath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Fichier de questions introuvable: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed.questions || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error(`questions invalide ou vide: ${filePath}`);
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
      throw new Error(`Question invalide dans ${filePath}`);
    }
  }

  return parsed.questions;
}

function cloneQuestions(questions) {
  return JSON.parse(JSON.stringify(questions));
}

function shuffleArray(input) {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function shuffleQuestionAnswers(question) {
  const indexedAnswers = question.answers.map((answer, index) => ({
    answer,
    wasCorrect: index === question.correctAnswer
  }));

  const shuffled = shuffleArray(indexedAnswers);

  return {
    questionText: question.questionText,
    answers: shuffled.map((item) => item.answer),
    correctAnswer: shuffled.findIndex((item) => item.wasCorrect)
  };
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

function clearBotAnswerTimeout(room) {
  if (room.botAnswerTimeout) {
    clearTimeout(room.botAnswerTimeout);
    room.botAnswerTimeout = null;
  }
}

function getShooterByShotIndex(shotIndex) {
  return shotIndex % 2 === 0 ? "A" : "B";
}

function getShooterTeam(room, shooterId) {
  return room.players[shooterId]?.team || "France";
}

function getIdleVideoForShooter(room, shooterId) {
  const shooterTeam = getShooterTeam(room, shooterId);

  if (shooterTeam === "France") {
    return getRandomVideoPath(VIDEO_PATHS.F_IDLE, 5);
  }

  return getRandomVideoPath(VIDEO_PATHS.B_IDLE, 5);
}

function getPenaltyVideoForShooter(room, shooterId, goalScored) {
  const shooterTeam = getShooterTeam(room, shooterId);

  if (shooterTeam === "France") {
    return goalScored
      ? getRandomVideoPath(VIDEO_PATHS.F_YES, 10)
      : getRandomVideoPath(VIDEO_PATHS.F_NO, 10);
  }

  return goalScored
    ? getRandomVideoPath(VIDEO_PATHS.B_YES, 10)
    : getRandomVideoPath(VIDEO_PATHS.B_NO, 10);
}

function getPenaltyDisplayText(room, shooterId, goalScored) {
  const shooterTeam = getShooterTeam(room, shooterId);

  if (shooterTeam === "France") {
    return goalScored ? "BUT FRANCE" : "FRANCE RATE";
  }

  return goalScored ? "BUT BRESIL" : "BRESIL RATE";
}

function getFinalVideoByTeam(team) {
  if (team === "France") {
    return getRandomVideoPath(VIDEO_PATHS.FINAL_F_WIN, 5);
  }
  if (team === "Brazil") {
    return getRandomVideoPath(VIDEO_PATHS.FINAL_B_WIN, 5);
  }
  return getRandomVideoPath(VIDEO_PATHS.FINAL_DRAW, 3);
}

function resetSuddenDeathPair(room) {
  room.suddenDeathPairShots = { A: 0, B: 0 };
  room.suddenDeathPairGoals = { A: 0, B: 0 };
}

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

    if (shotsA >= REGULAR_SHOTS_PER_TEAM && shotsB >= REGULAR_SHOTS_PER_TEAM) {
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

function logPenaltyRecap(room) {
  if (!room.penaltyRecap || room.penaltyRecap.length === 0) {
    log("⚠️ Aucun recap de penalties.");
    return;
  }

  const scoreA = room.score?.A ?? 0;
  const scoreB = room.score?.B ?? 0;
  const teamA = room.players?.A?.team ?? "A";
  const teamB = room.players?.B?.team ?? "B";

  log("🏟️ ===== RECAP MATCH =====");
  log(`📊 Score final: ${teamA} ${scoreA} - ${scoreB} ${teamB}`);

  room.penaltyRecap.forEach((p) => {
    const emojiResult = p.goalScored ? "⚽" : "❌";
    const emojiWinner =
      p.roundWinner === "A" ? "🟦" :
      p.roundWinner === "B" ? "🟨" :
      "🤝";

    const timeA = (p.playerATime / 1000).toFixed(2);
    const timeB = (p.playerBTime / 1000).toFixed(2);

    const Astatus = p.playerAIsCorrect ? "✅" : "❌";
    const Bstatus = p.playerBIsCorrect ? "✅" : "❌";

    log(
      `${emojiResult} #${p.penaltyNumber} | ${p.shooterTeam} (${p.shooterId})\n` +
      `   A: ${timeA}s ${Astatus} | B: ${timeB}s ${Bstatus}\n` +
      `   Winner: ${emojiWinner} ${p.roundWinner} | ${p.goalScored ? "GOAL" : "MISS"}`
    );
  });

  log("🏁 =======================");
}

function finishSession(room) {
  clearQuestionTimeout(room);
  clearTransitionTimeout(room);
  clearQuestionDisplayTimeout(room);
  clearBotAnswerTimeout(room);

  let finalWinner = "draw";
  let finalText = "SEANCE TERMINEE - EGALITE";
  let winnerTeam = null;

  if (room.score.A > room.score.B) {
    finalWinner = "A";
    winnerTeam = room.players.A.team;
    finalText = `${winnerTeam.toUpperCase()} GAGNE LA SEANCE`;
  } else if (room.score.B > room.score.A) {
    finalWinner = "B";
    winnerTeam = room.players.B.team;
    finalText = `${winnerTeam.toUpperCase()} GAGNE LA SEANCE`;
  }

  logPenaltyRecap(room);

  const finalVideo = winnerTeam
    ? getFinalVideoByTeam(winnerTeam)
    : getRandomVideoPath(VIDEO_PATHS.FINAL_DRAW, 3);

  broadcast(room, {
    type: "QUIZ_FINISHED",
    winner: finalWinner,
    winnerTeam,
    displayText: finalText,
    score: room.score,
    shots: room.shots,
    history: room.history,
    penaltyRecap: room.penaltyRecap,
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
  if (!room.questions || room.questions.length === 0) {
    throw new Error("Aucune question disponible");
  }

  if (!room.questionOrder || room.questionOrder.length === 0) {
    room.questionOrder = shuffleArray([...Array(room.questions.length).keys()]);
    room.questionOrderCursor = 0;
  }

  if (room.questionOrderCursor >= room.questionOrder.length) {
    room.questionOrder = shuffleArray([...Array(room.questions.length).keys()]);
    room.questionOrderCursor = 0;
  }

  const questionIndex = room.questionOrder[room.questionOrderCursor];
  room.questionOrderCursor += 1;

  return shuffleQuestionAnswers(room.questions[questionIndex]);
}

function pickWrongAnswer(correctAnswer) {
  const choices = [0, 1, 2, 3].filter((n) => n !== correctAnswer);
  return choices[Math.floor(Math.random() * choices.length)];
}

function scheduleSoloBotAnswer(room) {
  if (!room.isSolo) return;

  clearBotAnswerTimeout(room);

  const botId = room.botPlayerId || "B";
  const profile = getBotProfile(room.botDifficulty);

  const willBeCorrect = Math.random() < profile.correctChance;
  const responseTime = randomInt(profile.minTimeMs, profile.maxTimeMs);

  const botAnswer = willBeCorrect
    ? room.correct
    : pickWrongAnswer(room.correct);

  room.botAnswerTimeout = setTimeout(() => {
    try {
      if (!room || room.roundResolved) return;
      if (room.answers[botId] !== null) return;

      room.answers[botId] = {
        answer: botAnswer,
        time: responseTime
      };

      broadcast(room, {
        type: "ANSWER_RECEIVED",
        roomCode: room.code,
        playerId: botId
      });

      log(`BOT ANSWER [${room.botDifficulty}] -> ${botId} | answer=${botAnswer} | time=${responseTime}ms`);

      if (room.answers.A && room.answers.B) {
        computeRoundResult(room);
      }
    } catch (err) {
      log("scheduleSoloBotAnswer crash:", err);
    }
  }, responseTime);
}

function startQuestion(room) {
  clearQuestionTimeout(room);
  clearTransitionTimeout(room);
  clearQuestionDisplayTimeout(room);
  clearBotAnswerTimeout(room);

  const q = getNextQuestion(room);
  if (!q) {
    throw new Error("Question introuvable");
  }

  room.currentShooter = getShooterByShotIndex(room.shotIndex);
  room.correct = q.correctAnswer;
  room.answers = { A: null, B: null };
  room.roundResolved = false;

  const idleVideo = getIdleVideoForShooter(room, room.currentShooter);

  broadcast(room, {
    type: "IDLE_VIDEO",
    currentVideo: idleVideo,
    preloadVideo: idleVideo,
    shooter: room.currentShooter,
    shooterTeam: getShooterTeam(room, room.currentShooter),
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
        shooterTeam: getShooterTeam(room, room.currentShooter),
        score: room.score,
        shots: room.shots,
        history: room.history,
        isSuddenDeath: room.isSuddenDeath
      });

      if (room.isSolo) {
        scheduleSoloBotAnswer(room);
      }

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
      const state = getSessionWinner(room);

      if (state === "A" || state === "B") {
        finishSession(room);
        return;
      }

      if (state === "sudden_death") {
        room.isSuddenDeath = true;
        resetSuddenDeathPair(room);
        startQuestion(room);
        return;
      }

      if (state === "next_pair") {
        resetSuddenDeathPair(room);
        startQuestion(room);
        return;
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
  clearBotAnswerTimeout(room);

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
      shooterTeam: getShooterTeam(room, shooter),
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

  room.history.push({
    shooterId: shooter,
    shooterTeam: getShooterTeam(room, shooter),
    success: goalScored
  });

  room.penaltyRecap.push({
    penaltyNumber: room.penaltyRecap.length + 1,
    shooterId: shooter,
    shooterTeam: getShooterTeam(room, shooter),
    playerATime: A.time,
    playerBTime: B.time,
    playerAIsCorrect: Aok,
    playerBIsCorrect: Bok,
    roundWinner: roundWinner || "DRAW",
    goalScored
  });

  if (room.isSuddenDeath) {
    room.suddenDeathPairShots[shooter] += 1;
    if (goalScored) {
      room.suddenDeathPairGoals[shooter] += 1;
    }
  }

  const currentVideo = getPenaltyVideoForShooter(room, shooter, goalScored);
  const text = getPenaltyDisplayText(room, shooter, goalScored);

  broadcast(room, {
    type: "ROUND_RESULT",
    displayText: text,
    shooter,
    shooterTeam: getShooterTeam(room, shooter),
    roundWinner,
    goalScored,
    currentVideo,
    preloadVideo: "",
    score: room.score,
    shots: room.shots,
    history: room.history,
    penaltyRecap: room.penaltyRecap,
    isSuddenDeath: room.isSuddenDeath
  });

  room.shotIndex += 1;
  scheduleNextQuestionAfterPenalty(room);
}

function createRoom(ws, selectedTeam, options = {}) {
  const code = createUniqueRoomCode();
  const safeTeam = selectedTeam === "Brazil" ? "Brazil" : "France";

  const room = {
    code,
    mode: options.mode || "duo",

    players: {
      A: { ws, team: safeTeam },
      B: null
    },

    questions: options.questions || [],
    schoolLevel: options.schoolLevel || null,
    questionDifficulty: options.questionDifficulty || null,
    subject: options.subject || null,
    subtopic: options.subtopic || null,

    questionOrder: [],
    questionOrderCursor: 0,

    shotIndex: 0,
    currentShooter: "A",
    answers: { A: null, B: null },
    correct: 0,

    questionTimeout: null,
    transitionTimeout: null,
    questionDisplayTimeout: null,
    botAnswerTimeout: null,

    roundResolved: false,

    score: { A: 0, B: 0 },
    shots: { A: 0, B: 0 },
    history: [],
    penaltyRecap: [],

    isSuddenDeath: false,
    suddenDeathPairShots: { A: 0, B: 0 },
    suddenDeathPairGoals: { A: 0, B: 0 },

    isSolo: options.isSolo || false,
    botDifficulty: options.botDifficulty || "medium",
    botPlayerId: options.botPlayerId || "B"
  };

  rooms.set(code, room);
  clients.set(ws, { room: code, id: "A" });

  send(ws, {
    type: "ROOM_CREATED",
    roomCode: code,
    playerId: "A",
    team: safeTeam
  });

  return room;
}

function cleanupExistingClientRoom(ws) {
  const info = clients.get(ws);

  if (!info || !info.room) {
    clients.set(ws, {});
    return;
  }

  const room = rooms.get(info.room);
  if (!room) {
    clients.set(ws, {});
    return;
  }

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
    clearBotAnswerTimeout(room);
    rooms.delete(room.code);
  }

  clients.set(ws, {});
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
        clearBotAnswerTimeout(room);
        rooms.delete(room.code);
      }
    }
  }

  clients.delete(ws);
}

function findOpenWorldRoom() {
  for (const room of rooms.values()) {
    if (
      room &&
      room.mode === "world" &&
      !room.isSolo &&
      room.players &&
      room.players.A &&
      !room.players.B
    ) {
      return room;
    }
  }

  return null;
}

wss.on("connection", (ws) => {
  clients.set(ws, {});
  send(ws, { type: "CONNECTED" });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "CREATE_BATTLE") {
        cleanupExistingClientRoom(ws);

        const team = data.team === "Brazil" ? "Brazil" : "France";
        const schoolLevel = safeSchoolLevel(data.schoolLevel);
        const questionDifficulty = safeQuestionDifficulty(data.questionDifficulty);
        const subject = safeSubject(data.subject);
        const subtopic = safeSubtopic(subject, data.subtopic);

        let selectedQuestions;
        try {
          selectedQuestions = loadQuestionsByPath(
            schoolLevel,
            questionDifficulty,
            subject,
            subtopic
          );
        } catch (err) {
          log("Erreur chargement questions duo:", err);
          send(ws, {
            type: "ERROR",
            message: "Impossible de charger les questions pour ce niveau / cette matière"
          });
          return;
        }

        createRoom(ws, team, {
          mode: "duo",
          questions: cloneQuestions(selectedQuestions),
          schoolLevel,
          questionDifficulty,
          subject,
          subtopic
        });

        return;
      }

      if (data.type === "CREATE_SOLO_BATTLE") {
        cleanupExistingClientRoom(ws);

        const team = data.team === "Brazil" ? "Brazil" : "France";
        const schoolLevel = safeSchoolLevel(data.schoolLevel);
        const questionDifficulty = safeQuestionDifficulty(data.questionDifficulty);
        const subject = safeSubject(data.subject);
        const subtopic = safeSubtopic(subject, data.subtopic);
        const botDifficulty = safeBotDifficulty(data.botDifficulty);

        let selectedQuestions;
        try {
          selectedQuestions = loadQuestionsByPath(
            schoolLevel,
            questionDifficulty,
            subject,
            subtopic
          );
        } catch (err) {
          log("Erreur chargement questions solo:", err);
          send(ws, {
            type: "ERROR",
            message: "Impossible de charger les questions pour ce niveau / cette matière"
          });
          return;
        }

        createRoom(ws, team, {
          mode: "solo",
          isSolo: true,
          botDifficulty,
          botPlayerId: "B",
          schoolLevel,
          questionDifficulty,
          subject,
          subtopic,
          questions: cloneQuestions(selectedQuestions)
        });

        const info = clients.get(ws);
        const room = info && info.room ? rooms.get(info.room) : null;

        if (!room) {
          send(ws, { type: "ERROR", message: "Impossible de créer la room solo" });
          return;
        }

        room.players.B = {
          ws: null,
          team: getOppositeTeam(room.players.A.team),
          isBot: true
        };

        send(ws, {
          type: "SOLO_TEAMS_ASSIGNED",
          yourTeam: room.players.A.team,
          opponentTeam: room.players.B.team,
          schoolLevel,
          questionDifficulty,
          subject,
          subtopic,
          botDifficulty
        });

        send(room.players.A.ws, {
          type: "BATTLE_READY",
          yourTeam: room.players.A.team,
          opponentTeam: room.players.B.team,
          schoolLevel,
          questionDifficulty,
          subject,
          subtopic
        });

        setTimeout(() => {
          try {
            startQuestion(room);
          } catch (err) {
            log("startQuestion solo crash:", err);
          }
        }, 1000);

        return;
      }

      if (data.type === "FIND_WORLD_BATTLE") {
        cleanupExistingClientRoom(ws);

        const existingRoom = findOpenWorldRoom();

        if (existingRoom) {
          existingRoom.players.B = {
            ws,
            team: "Brazil"
          };

          clients.set(ws, { room: existingRoom.code, id: "B" });

          send(ws, {
            type: "ROOM_JOINED",
            roomCode: existingRoom.code,
            playerId: "B",
            team: "Brazil"
          });

          send(existingRoom.players.A.ws, {
            type: "OPPONENT_JOINED",
            opponentTeam: "Brazil"
          });

          send(existingRoom.players.A.ws, {
            type: "BATTLE_READY",
            yourTeam: "France",
            opponentTeam: "Brazil",
            schoolLevel: existingRoom.schoolLevel,
            questionDifficulty: existingRoom.questionDifficulty,
            subject: existingRoom.subject,
            subtopic: existingRoom.subtopic
          });

          send(existingRoom.players.B.ws, {
            type: "BATTLE_READY",
            yourTeam: "Brazil",
            opponentTeam: "France",
            schoolLevel: existingRoom.schoolLevel,
            questionDifficulty: existingRoom.questionDifficulty,
            subject: existingRoom.subject,
            subtopic: existingRoom.subtopic
          });

          setTimeout(() => {
            try {
              startQuestion(existingRoom);
            } catch (err) {
              log("startQuestion world crash:", err);
            }
          }, 1000);

          return;
        }

        let selectedQuestions;
        try {
          selectedQuestions = loadQuestionsByPath(
            "middle_school",
            "medium",
            "math",
            "calcul"
          );
        } catch (err) {
          log("Erreur chargement questions world:", err);
          send(ws, {
            type: "ERROR",
            message: "Impossible de charger les questions world"
          });
          return;
        }

        createRoom(ws, "France", {
          mode: "world",
          questions: cloneQuestions(selectedQuestions),
          schoolLevel: "middle_school",
          questionDifficulty: "medium",
          subject: "math",
          subtopic: "calcul"
        });

        send(ws, {
          type: "WORLD_WAITING",
          message: "En attente d'un adversaire..."
        });

        return;
      }

      if (data.type === "JOIN_BATTLE") {
        const code = sanitizeRoomCode(data.roomCode);
        const room = rooms.get(code);

        if (!room) {
          send(ws, { type: "ERROR", message: "Room introuvable" });
          return;
        }

        if (room.mode !== "duo") {
          send(ws, { type: "ERROR", message: "Cette room n'accepte pas de rejoindre via code" });
          return;
        }

        if (room.players.B) {
          send(ws, { type: "ERROR", message: "Room complète" });
          return;
        }

        cleanupExistingClientRoom(ws);

        const teamForB = getOppositeTeam(room.players.A.team);

        room.players.B = { ws, team: teamForB };
        clients.set(ws, { room: code, id: "B" });

        send(ws, {
          type: "ROOM_JOINED",
          roomCode: code,
          playerId: "B",
          team: teamForB
        });

        send(room.players.A.ws, {
          type: "OPPONENT_JOINED",
          opponentTeam: teamForB
        });

        send(room.players.A.ws, {
          type: "BATTLE_READY",
          yourTeam: room.players.A.team,
          opponentTeam: room.players.B.team,
          schoolLevel: room.schoolLevel,
          questionDifficulty: room.questionDifficulty,
          subject: room.subject,
          subtopic: room.subtopic
        });

        send(room.players.B.ws, {
          type: "BATTLE_READY",
          yourTeam: room.players.B.team,
          opponentTeam: room.players.A.team,
          schoolLevel: room.schoolLevel,
          questionDifficulty: room.questionDifficulty,
          subject: room.subject,
          subtopic: room.subtopic
        });

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
          log("ANSWER ignorée: round déjà terminé", {
            room: room.code,
            playerId: info.id
          });
          return;
        }

        if (!Number.isInteger(data.answer) || data.answer < 0 || data.answer > 3) {
          send(ws, { type: "ERROR", message: "Réponse invalide" });
          return;
        }

        const time = Number(data.time);

        // Le client doit envoyer en millisecondes
        if (!Number.isFinite(time) || time < 0 || time > ANSWER_TIME_LIMIT_MS) {
          send(ws, { type: "ERROR", message: "Temps invalide" });
          return;
        }

        if (room.answers[info.id] !== null) {
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