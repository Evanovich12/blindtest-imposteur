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
app.get("/api/spotify-client-id", (_, res) => {
  const id = process.env.SPOTIFY_CLIENT_ID;
  res.json(id ? { clientId: id } : { error: "not_configured" });
});
app.get("/api/test-spotify", async (req, res) => {
  try {
    const playlistId = req.query.id || "1wgDRqCdpmAfjrYPJGEvhH";
    const tracks = await fetchPlaylistTracks(playlistId);
    res.json({ ok: true, count: tracks.length, sample: tracks.slice(0, 3) });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/api/debug-spotify", async (req, res) => {
  try {
    const playlistId = req.query.id || "1wgDRqCdpmAfjrYPJGEvhH";
    const pageUrl = `https://open.spotify.com/playlist/${playlistId}`;
    const r = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
    });
    const html = await r.text();
    const hasNextData = html.includes("__NEXT_DATA__");
    const hasSpotify = html.includes("spotify");
    const snippet = html.substring(0, 500);
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{.{0,2000})/s);
    res.json({
      status: r.status,
      hasNextData,
      hasSpotify,
      htmlLength: html.length,
      htmlStart: snippet,
      nextDataStart: nextDataMatch ? nextDataMatch[1].substring(0, 500) : null,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

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

// Scrape the Spotify playlist page (no API key required)
async function fetchPlaylistTracks(id) {
  const pageUrl = `https://open.spotify.com/playlist/${id}`;
  const r = await fetch(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
  });
  if (r.status === 404) throw new Error("Playlist Spotify introuvable. Vérifie le lien.");
  if (!r.ok) throw new Error(`Impossible d'accéder à la playlist Spotify (${r.status}). Assure-toi qu'elle est publique.`);
  const html = await r.text();

  // Extract __NEXT_DATA__ JSON embedded by Next.js
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{.*?\})<\/script>/s);
  if (!m) throw new Error("Impossible de lire la playlist Spotify. Assure-toi qu'elle est publique et réessaie.");
  let data;
  try { data = JSON.parse(m[1]); } catch (_) {
    throw new Error("Erreur lors de l'analyse de la playlist Spotify.");
  }

  // Navigate the Next.js hydration structure
  const out = [];
  try {
    const apolloState = data?.props?.pageProps?.apolloState || data?.props?.pageProps?.state;
    if (apolloState) {
      for (const [key, val] of Object.entries(apolloState)) {
        if (key.startsWith("Track:") && val.name && val.artists) {
          const artists = (val.artists?.items || []).map(a => a?.profile?.name || a?.name || "").filter(Boolean).join(", ");
          if (artists) out.push({ name: val.name, artist: artists });
        }
      }
    }
    // Alternative: look for tracks inside playlist entity
    if (!out.length) {
      const str = JSON.stringify(data);
      const trackMatches = str.matchAll(/"name":"([^"]+)","uri":"spotify:track:[^"]+","artists":\{"items":\[(\{[^}]+\})/g);
      for (const tm of trackMatches) {
        const artistMatch = tm[2].match(/"name":"([^"]+)"/);
        if (artistMatch) out.push({ name: tm[1], artist: artistMatch[1] });
      }
    }
  } catch (_) {}

  if (!out.length) throw new Error("Aucune piste trouvée dans cette playlist Spotify. Assure-toi qu'elle est publique.");
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
  if (String(url).includes("deezer.com")) return importDeezerPlaylist(url);
  const id = parsePlaylistId(url);
  if (!id) throw new Error("Lien non reconnu. Colle un lien open.spotify.com/playlist/... ou deezer.com/playlist/...");
  const raw = await fetchPlaylistTracks(id);
  if (!raw.length) throw new Error("Playlist vide.");
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

/* ============================== DEEZER ============================== */
function parseDeezerPlaylistId(url) {
  const m = String(url).match(/playlist[/:](\d+)/);
  return m ? m[1] : null;
}

async function importDeezerPlaylist(url) {
  const id = parseDeezerPlaylistId(url);
  if (!id) throw new Error("Lien Deezer non reconnu. Colle un lien du type deezer.com/playlist/...");
  const r = await fetch(`https://api.deezer.com/playlist/${id}/tracks?limit=50`);
  if (!r.ok) throw new Error("Playlist Deezer introuvable ou inaccessible.");
  const d = await r.json();
  if (d.error) throw new Error("Erreur Deezer : " + (d.error.message || JSON.stringify(d.error)));
  const items = (d.data || []).filter(t => t.preview);
  if (!items.length) throw new Error("Aucun extrait audio disponible dans cette playlist Deezer.");
  items.sort(() => Math.random() - 0.5);
  return items.slice(0, 10).map(t => ({
    title: t.title,
    artist: t.artist?.name || "",
    previewUrl: t.preview,
    artwork: t.album?.cover_medium || t.album?.cover || "",
  }));
}

/* ============================== BOT ============================== */
const BOT_SONGS = [
  "Bohemian Rhapsody Queen", "Blinding Lights The Weeknd", "Shape of You Ed Sheeran",
  "Despacito Luis Fonsi", "Happy Pharrell Williams", "Uptown Funk Mark Ronson Bruno Mars",
  "Rolling in the Deep Adele", "Mr Brightside The Killers", "Somebody That I Used To Know Gotye",
  "Take On Me A-ha", "Africa Toto", "Sweet Child O Mine Guns N Roses",
  "Pumped Up Kicks Foster the People", "Moves Like Jagger Maroon 5", "Call Me Maybe Carly Rae Jepsen",
  "Girls Just Want to Have Fun Cyndi Lauper", "Wake Me Up Avicii", "Titanium David Guetta",
  "Lean On Major Lazer", "Cheap Thrills Sia",
];

async function buildBotPlaylist() {
  const shuffled = [...BOT_SONGS].sort(() => Math.random() - 0.5);
  const tracks = [];
  for (const term of shuffled) {
    if (tracks.length >= 10) break;
    const p = await itunesPreview(term);
    if (p) tracks.push(p);
    await new Promise((r) => setTimeout(r, 120));
  }
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

  socket.on("host:addBot", async (_, ack) => {
    const room = rooms[roomCode];
    if (!room) return ack && ack({ ok: false, error: "Salon introuvable." });
    if (room.phase !== "lobby") return ack && ack({ ok: false, error: "La partie a deja commence." });
    try {
      const tracks = await buildBotPlaylist();
      if (!tracks.length) return ack && ack({ ok: false, error: "Impossible de charger la playlist du bot (iTunes indisponible ?)." });
      const botId = "bot" + Math.random().toString(36).slice(2, 6);
      const botNames = ["🤖 Groover", "🤖 Deezer Bot", "🤖 RoboDJ", "🤖 MusiBot"];
      const botName = botNames[Math.floor(Math.random() * botNames.length)];
      room.players[botId] = { id: botId, name: botName, socketId: null, score: 0, connected: true, hasPlaylist: true };
      room.playlists[botId] = { tracks };
      ack && ack({ ok: true, name: botName, count: tracks.length });
      io.to(room.hostId).emit("lobby", roster(room));
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
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
