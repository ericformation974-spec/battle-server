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

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("getRandom reçu un tableau vide ou invalide");
  }
  return arr[Math.floor(Math.random() * arr.length)];
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
    if (player.isBot) return;
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

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInt(min, maxInclusive) {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

function getRoundVideos(roundWinner) {
  let currentVideo;

  if (roundWinner === "A") currentVideo = getRandom(VIDEO_CONFIG.playerAWin);
  else if (roundWinner === "B") currentVideo = getRandom(VIDEO_CONFIG.playerBWin);
  else currentVideo = getRandom(VIDEO_CONFIG.draw);

  const preloadVideo = getRandom(VIDEO_CONFIG.idle);

  return { currentVideo, preloadVideo };
}

function maybeScheduleBotAnswer(room) {
  if (!room.isSolo) return;
  if (!room.players.B || !room.players.B.isBot) return;
  if (room.answers.B !== null) return;

  const delaySec = randomFloat(1, 3);
  const answerIndex = randomInt(0, 3);

  if (room.botTimeout) {
    clearTimeout(room.botTimeout);
    room.botTimeout = null;
  }

  room.botTimeout = setTimeout(() => {
    try {
      const currentRoom = rooms.get(room.code);
      if (!currentRoom) return;
      if (currentRoom.answers.B !== null) return;

      currentRoom.answers.B = {
        answer: answerIndex,
        time: Number(delaySec.toFixed(3))
      };

      broadcast(currentRoom, {
        type: "ANSWER_RECEIVED",
        roomCode: currentRoom.code,
        playerId: "B"
      });

      if (currentRoom.answers.A && currentRoom.answers.B) {
        computeRoundResult(currentRoom);
      }
    } catch (err) {
      log("bot answer crash:", err);
    }
  }, delaySec * 1000);
}

function startNextQuestion(room) {
  room.index += 1;

  if (room.index >= room.questions.length) {
    if (room.botTimeout) {
      clearTimeout(room.botTimeout);
      room.botTimeout = null;
    }

    log("QUIZ_FINISHED room", room.code);

    broadcast(room, {
      type: "QUIZ_FINISHED"
    });
    return;
  }

  const q = room.questions[room.index];
  if (!q) {
    throw new Error(`Question introuvable à l'index ${room.index}`);
  }

  room.correct = q.correctAnswer;
  room.answers = { A: null, B: null };

  log("QUESTION_STARTED room", room.code, "index", room.index, "question", q.questionText);

  broadcast(room, {
    type: "QUESTION_STARTED",
    questionText: q.questionText,
    answers: q.answers
  });

  maybeScheduleBotAnswer(room);
}

function computeRoundResult(room) {
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
    } else {
      winner = "draw";
      text = "MATCH NUL";
    }
  } else {
    winner = "draw";
    text = "MATCH NUL";
  }

  const { currentVideo, preloadVideo } = getRoundVideos(winner);

  log("ROUND_RESULT room", room.code, "winner", winner, "video", currentVideo, "preload", preloadVideo);

  broadcast(room, {
    type: "ROUND_RESULT",
    displayText: text,
    currentVideo,
    preloadVideo
  });

  setTimeout(() => {
    try {
      startNextQuestion(room);
    } catch (err) {
      log("startNextQuestion after result crash:", err);
    }
  }, 2000);
}

function createRoom(ws, isSolo) {
  const code = createUniqueRoomCode();

  const room = {
    code,
    isSolo,
    players: {
      A: { ws, isBot: false },
      B: isSolo ? { isBot: true } : null
    },
    questions: cloneQuestions(),
    index: -1,
    answers: { A: null, B: null },
    correct: 0,
    botTimeout: null
  };

  rooms.set(code, room);
  clients.set(ws, { room: code, id: "A" });

  log("ROOM_CREATED", code, "solo =", isSolo);

  send(ws, {
    type: "ROOM_CREATED",
    roomCode: code
  });

  if (isSolo) {
    send(ws, {
      type: "ROOM_JOINED",
      roomCode: code
    });

    broadcast(room, {
      type: "BATTLE_READY"
    });

    setTimeout(() => {
      try {
        startNextQuestion(room);
      } catch (err) {
        log("startNextQuestion solo crash:", err);
      }
    }, 1000);
  }
}

wss.on("connection", (ws) => {
  log("client connected");
  clients.set(ws, {});

  send(ws, { type: "CONNECTED" });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      log("message received:", data);

      if (data.type === "CREATE_SOLO_BATTLE") {
        createRoom(ws, true);
        return;
      }

      if (data.type === "CREATE_BATTLE") {
        createRoom(ws, false);
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

        room.players.B = { ws, isBot: false };
        clients.set(ws, { room: code, id: "B" });

        log("ROOM_JOINED", code, "player B");

        send(ws, {
          type: "ROOM_JOINED",
          roomCode: code
        });

        broadcast(room, {
          type: "BATTLE_READY"
        });

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

  log("ANSWER reçu → room:", room.code, "player:", info.id);

  room.answers[info.id] = {
    answer: data.answer,
    time: data.time
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
    log("client disconnected");
    clients.delete(ws);
  });

  ws.on("error", (err) => {
    log("ws error:", err);
  });
});

server.listen(PORT, () => {
  log("Server running on port", PORT);
});