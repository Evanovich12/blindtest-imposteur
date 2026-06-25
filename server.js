/* ------------------------------------------------------------------ *
 *  Blindtest Imposteur — serveur central
 *  - Sert les pages (ecran PC + ecran telephone)
 *  - Gere les salons en temps reel (Socket.IO)
 *  - Importe une playlist Spotify et trouve les extraits 30s via iTunes
 * ------------------------------------------------------------------ */
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Sert le site, que les fichiers soient dans public/ OU directement a la racine
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public")
  : __dirname;
console.log("Fichiers du site servis depuis : " + PUBLIC_DIR);
app.use(express.static(PUBLIC_DIR));
app.get("/health", (_, res) => res.send("ok"));

/* ============================== SPOTIFY ============================== */
let tokenCache = { token: null, exp: 0 };

async function getSpotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret)
    throw new Error("Cles Spotify manquantes sur le serveur (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).");
  if (tokenCache.token && tokenCache.exp > Date.now()) return tokenCache.token;

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error("Authentification Spotify echouee (verifie tes cles).");
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

function parsePlaylistId(url) {
  const m = String(url).match(/playlist[/:]([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

async function fetchPlaylistTracks(id, token) {
  const out = [];
  let url =
    `https://api.spotify.com/v1/playlists/${id}/tracks` +
    `?fields=items(track(name,artists(name))),next&limit=50`;
  while (url && out.length < 50) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (r.status === 404)
      throw new Error("Playlist introuvable. Astuce : les playlists editoriales de Spotify (Top 50, Discover Weekly...) ne sont pas lisibles. Utilise une playlist perso, et mets-la en public.");
    if (!r.ok) throw new Error("Playlist illisible (privee ou supprimee ?). Mets-la en public.");
    const d = await r.json();
    for (const it of d.items || []) {
      const t = it.track;
      if (!t) continue;
      out.push({ name: t.name, artist: (t.artists || []).map((a) => a.name).join(", ") });
    }
    url = d.next;
  }
  return out;
}

const itunesCache = {};
async function itunesPreview(term) {
  if (term in itunesCache) return itunesCache[term];
  try {
    const r = await fetch(
      "https://itunes.apple.com/search?media=music&entity=song&limit=1&term=" + encodeURIComponent(term)
    );
    const d = await r.json();
    const x = (d.results || [])[0];
    const out =
      x && x.previewUrl
        ? {
            title: x.trackName,
            artist: x.artistName,
            previewUrl: x.previewUrl,
            artwork: (x.artworkUrl100 || "").replace("100x100", "300x300"),
          }
        : null;
    itunesCache[term] = out;
    return out;
  } catch (e) {
    return null;
  }
}

async function importPlaylist(url) {
  const id = parsePlaylistId(url);
  if (!id) throw new Error("Lien Spotify non reconnu. Colle un lien du type open.spotify.com/playlist/...");
  const token = await getSpotifyToken();
  const raw = await fetchPlaylistTracks(id, token);
  if (!raw.length) throw new Error("Playlist vide.");
  // melange puis cherche jusqu'a 10 extraits jouables
  raw.sort(() => Math.random() - 0.5);
  const tracks = [];
  for (const t of raw) {
    if (tracks.length >= 10) break;
    const p = await itunesPreview(`${t.name} ${t.artist}`);
    if (p) tracks.push(p);
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!tracks.length) throw new Error("Aucun extrait audio trouve pour cette playlist via iTunes.");
  return tracks;
}

/* ============================== SALONS ============================== */
const rooms = {};
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms[s] ? makeCode() : s;
}
const roster = (room) =>
  Object.values(room.players).map((p) => ({
    id: p.id, name: p.name, connected: p.connected, hasPlaylist: p.hasPlaylist, score: p.score,
  }));
const scoreboard = (room) =>
  Object.values(room.players)
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

function startRound(room) {
  room.currentOwner = room.order[room.roundIndex];
  room.phase = "round";
  room.votes = {};
  const tracks = room.playlists[room.currentOwner].tracks;
  io.to(room.hostId).emit("round:tracks", {
    tracks, roundIndex: room.roundIndex, total: room.order.length,
  });
  io.to(room.code).emit("phase", {
    phase: "round", roundIndex: room.roundIndex, total: room.order.length,
  });
}

io.on("connection", (socket) => {
  let role = null, roomCode = null, pid = null;

  /* ---------- HOTE (ecran PC) ---------- */
  socket.on("host:create", (ack) => {
    const code = makeCode();
    rooms[code] = {
      code, hostId: socket.id, players: {}, playlists: {},
      order: [], roundIndex: 0, currentOwner: null, votes: {}, phase: "lobby",
    };
    roomCode = code; role = "host"; socket.join(code);
    ack && ack({ code });
  });

  socket.on("host:startGame", (_, ack) => {
    const room = rooms[roomCode];
    if (!room) return ack && ack({ ok: false, error: "Salon introuvable." });
    const owners = Object.keys(room.playlists);
    if (owners.length < 2)
      return ack && ack({ ok: false, error: "Il faut au moins 2 playlists soumises." });
    room.order = owners.sort(() => Math.random() - 0.5);
    room.roundIndex = 0;
    startRound(room);
    ack && ack({ ok: true });
  });

  socket.on("host:award", ({ pid: target }) => {
    const room = rooms[roomCode];
    if (!room || !room.players[target]) return;
    room.players[target].score += 1;
    io.to(roomCode).emit("scoreboard", scoreboard(room));
  });

  socket.on("host:startVote", () => {
    const room = rooms[roomCode];
    if (!room) return;
    room.phase = "vote"; room.votes = {};
    io.to(roomCode).emit("vote:start", {
      suspects: Object.values(room.players).map((p) => ({ id: p.id, name: p.name })),
    });
    io.to(room.hostId).emit("vote:progress", { voted: 0, total: Object.keys(room.players).length });
  });

  socket.on("host:reveal", () => {
    const room = rooms[roomCode];
    if (!room) return;
    const owner = room.currentOwner;
    let survived = 0;
    for (const [voter, suspect] of Object.entries(room.votes)) {
      if (suspect === owner) { if (room.players[voter]) room.players[voter].score += 2; }
      else survived++;
    }
    if (room.players[owner]) room.players[owner].score += survived;
    room.phase = "reveal";
    const ownerName = room.players[owner] ? room.players[owner].name : "???";
    io.to(room.hostId).emit("reveal:data", {
      ownerId: owner, ownerName,
      votes: Object.entries(room.votes).map(([v, s]) => ({
        voter: room.players[v] && room.players[v].name,
        suspect: room.players[s] && room.players[s].name,
        correct: s === owner,
      })),
    });
    io.to(roomCode).emit("reveal", { ownerName });
    io.to(roomCode).emit("scoreboard", scoreboard(room));
  });

  socket.on("host:nextRound", () => {
    const room = rooms[roomCode];
    if (!room) return;
    room.roundIndex++;
    if (room.roundIndex < room.order.length) startRound(room);
    else {
      room.phase = "done";
      io.to(roomCode).emit("done", scoreboard(room));
      io.to(room.hostId).emit("host:done", scoreboard(room));
    }
  });

  /* ---------- JOUEUR (telephone) ---------- */
  socket.on("player:join", ({ code, name }, ack) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return ack && ack({ ok: false, error: "Code de salon introuvable." });
    pid = "p" + Math.random().toString(36).slice(2, 8);
    room.players[pid] = {
      id: pid, name: String(name || "Joueur").slice(0, 20) || "Joueur",
      socketId: socket.id, score: 0, connected: true, hasPlaylist: false,
    };
    roomCode = code; role = "player"; socket.join(code);
    ack && ack({ ok: true, pid, phase: room.phase });
    io.to(room.hostId).emit("lobby", roster(room));
  });

  socket.on("player:submitPlaylist", async ({ url }, ack) => {
    const room = rooms[roomCode];
    if (!room || !pid) return ack && ack({ ok: false, error: "Salon ferme." });
    try {
      const tracks = await importPlaylist(url);
      room.playlists[pid] = { tracks };
      room.players[pid].hasPlaylist = true;
      ack && ack({ ok: true, count: tracks.length });
      io.to(room.hostId).emit("submission", { name: room.players[pid].name, count: tracks.length });
      io.to(room.hostId).emit("lobby", roster(room));
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on("player:guess", ({ text }) => {
    const room = rooms[roomCode];
    if (!room || !pid) return;
    io.to(room.hostId).emit("guess", {
      pid, name: room.players[pid] && room.players[pid].name, text: String(text || "").slice(0, 60),
    });
  });

  socket.on("player:vote", ({ suspectId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote" || !pid) return;
    room.votes[pid] = suspectId;
    io.to(room.hostId).emit("vote:progress", {
      voted: Object.keys(room.votes).length, total: Object.keys(room.players).length,
    });
  });

  /* ---------- DECONNEXION ---------- */
  socket.on("disconnect", () => {
    const room = rooms[roomCode];
    if (!room) return;
    if (role === "host") {
      io.to(roomCode).emit("roomClosed");
      delete rooms[roomCode];
    } else if (pid && room.players[pid]) {
      room.players[pid].connected = false;
      io.to(room.hostId).emit("lobby", roster(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Blindtest Imposteur en ecoute sur le port " + PORT));
