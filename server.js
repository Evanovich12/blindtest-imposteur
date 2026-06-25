/* ------------------------------------------------------------------ *
 *  Blindtest Imposteur — serveur central
 * ------------------------------------------------------------------ */
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public") : __dirname;
console.log("Fichiers servis depuis : " + PUBLIC_DIR);
app.use(express.static(PUBLIC_DIR));
app.get("/health", (_, res) => res.send("ok"));

app.get("/api/test-spotify", async (req, res) => {
  try {
    const tracks = await fetchPlaylistTracks(req.query.id || "1wgDRqCdpmAfjrYPJGEvhH");
    res.json({ ok: true, count: tracks.length, sample: tracks.slice(0, 2) });
  } catch (e) { res.json({ error: e.message }); }
});

/* ============================== FUZZY MATCH ============================== */
function normalize(s) {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[''`]/g, "").replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ").trim();
}
function levenshtein(a, b) {
  if (a === b) return 0;
  const row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i-1] === b[j-1] ? row[j-1] : 1 + Math.min(row[j-1], row[j], prev);
      row[j-1] = prev; prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}
function isMatch(guess, target) {
  const g = normalize(guess), t = normalize(target);
  if (!g || g.length < 2 || !t) return false;
  if (g === t) return true;
  if (g.length >= 4 && t.includes(g)) return true;
  if (t.length >= 4 && g.includes(t)) return true;
  if (t.length >= 4 && levenshtein(g, t) <= Math.max(1, Math.floor(t.length * 0.28))) return true;
  return false;
}
function isNearMiss(guess, target) {
  const g = normalize(guess), t = normalize(target);
  if (!g || g.length < 2 || !t || t.length < 3) return false;
  if (isMatch(guess, target)) return false;
  // Levenshtein légèrement plus large que isMatch
  if (levenshtein(g, t) <= Math.max(2, Math.floor(t.length * 0.45))) return true;
  // Un mot du titre correspond presque
  for (const word of t.split(" ")) {
    if (word.length >= 4 && levenshtein(g, word) <= Math.max(1, Math.floor(word.length * 0.35))) return true;
  }
  return false;
}

/* ============================== SPOTIFY ============================== */
function parsePlaylistId(url) {
  const m = String(url).match(/playlist[/:]([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

async function itunesArtwork(title, artist) {
  try {
    const r = await fetch("https://itunes.apple.com/search?media=music&entity=song&limit=1&term=" + encodeURIComponent(`${title} ${artist}`));
    const d = await r.json();
    const x = (d.results || [])[0];
    return x?.artworkUrl100?.replace("100x100", "300x300") || "";
  } catch (_) { return ""; }
}

async function fetchPlaylistTracks(id) {
  const embedUrl = `https://open.spotify.com/embed/playlist/${id}?utm_source=generator`;
  const r = await fetch(embedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (r.status === 404) throw new Error("Playlist Spotify introuvable. Vérifie le lien.");
  if (!r.ok) throw new Error(`Impossible d'accéder à la playlist Spotify (${r.status}).`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{.*?\})<\/script>/s);
  if (!m) throw new Error("Impossible de lire la playlist Spotify. Assure-toi qu'elle est publique.");
  let data;
  try { data = JSON.parse(m[1]); } catch (_) { throw new Error("Erreur lors de l'analyse de la playlist Spotify."); }
  const trackList = data?.props?.pageProps?.state?.data?.entity?.trackList;
  if (!trackList?.length) throw new Error("Playlist vide ou introuvable. Assure-toi qu'elle est publique.");
  const tracks = trackList
    .filter(t => t.title && t.audioPreview?.url)
    .map(t => ({
      title: t.title, artist: t.subtitle || "", previewUrl: t.audioPreview.url,
      // Spotify embed provides per-track image directly
      artwork: t.imageUrl || t.image?.sources?.[0]?.url || "",
    }));
  if (!tracks.length) throw new Error("Aucun extrait audio disponible dans cette playlist Spotify.");
  // Fallback to iTunes only for tracks missing artwork
  const missing = tracks.map((t, i) => ({ i, t })).filter(({ t }) => !t.artwork);
  for (let b = 0; b < missing.length; b += 5) {
    const batch = missing.slice(b, b + 5);
    const arts = await Promise.allSettled(batch.map(({ t }) => itunesArtwork(t.title, t.artist)));
    arts.forEach((res, j) => { if (res.status === "fulfilled" && res.value) tracks[batch[j].i].artwork = res.value; });
  }
  return tracks;
}

/* ============================== DEEZER ============================== */
function parseDeezerPlaylistId(url) {
  const m = String(url).match(/playlist[/:](\d+)/);
  return m ? m[1] : null;
}
async function importDeezerPlaylist(url) {
  const id = parseDeezerPlaylistId(url);
  if (!id) throw new Error("Lien Deezer non reconnu.");
  const r = await fetch(`https://api.deezer.com/playlist/${id}/tracks?limit=50`);
  if (!r.ok) throw new Error("Playlist Deezer introuvable ou inaccessible.");
  const d = await r.json();
  if (d.error) throw new Error("Erreur Deezer : " + (d.error.message || JSON.stringify(d.error)));
  const items = (d.data || []).filter(t => t.preview);
  if (!items.length) throw new Error("Aucun extrait audio disponible dans cette playlist Deezer.");
  items.sort(() => Math.random() - 0.5);
  return items.slice(0, 10).map(t => ({
    title: t.title, artist: t.artist?.name || "",
    previewUrl: t.preview,
    artwork: t.album?.cover_medium || t.album?.cover || "",
  }));
}

async function importPlaylist(url) {
  if (String(url).includes("deezer.com")) return importDeezerPlaylist(url);
  const id = parsePlaylistId(url);
  if (!id) throw new Error("Lien non reconnu. Colle un lien open.spotify.com/playlist/... ou deezer.com/playlist/...");
  const all = await fetchPlaylistTracks(id);
  if (!all.length) throw new Error("Aucun extrait disponible dans cette playlist.");
  all.sort(() => Math.random() - 0.5);
  return all.slice(0, 10);
}

/* ============================== BOT ============================== */
const BOT_SONGS = [
  "Bohemian Rhapsody Queen","Blinding Lights The Weeknd","Shape of You Ed Sheeran",
  "Despacito Luis Fonsi","Happy Pharrell Williams","Uptown Funk Mark Ronson Bruno Mars",
  "Rolling in the Deep Adele","Mr Brightside The Killers","Somebody That I Used To Know Gotye",
  "Take On Me A-ha","Africa Toto","Sweet Child O Mine Guns N Roses",
  "Pumped Up Kicks Foster the People","Moves Like Jagger Maroon 5","Call Me Maybe Carly Rae Jepsen",
  "Girls Just Want to Have Fun Cyndi Lauper","Wake Me Up Avicii","Titanium David Guetta",
  "Lean On Major Lazer","Cheap Thrills Sia",
];
async function buildBotPlaylist() {
  const shuffled = [...BOT_SONGS].sort(() => Math.random() - 0.5);
  const tracks = [];
  for (const term of shuffled) {
    if (tracks.length >= 10) break;
    try {
      const r = await fetch("https://itunes.apple.com/search?media=music&entity=song&limit=1&term=" + encodeURIComponent(term));
      const d = await r.json();
      const x = (d.results || [])[0];
      if (x?.previewUrl) tracks.push({ title: x.trackName, artist: x.artistName, previewUrl: x.previewUrl, artwork: (x.artworkUrl100||"").replace("100x100","300x300") });
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
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
const roster = (room) => Object.values(room.players).map(p => ({ id: p.id, name: p.name, connected: p.connected, hasPlaylist: p.hasPlaylist, score: p.score }));
const scoreboard = (room) => Object.values(room.players).map(p => ({ id: p.id, name: p.name, score: p.score })).sort((a,b) => b.score - a.score);
function roundStatus(room) {
  return Object.values(room.players).map(p => ({
    id: p.id, name: p.name, score: p.score,
    titleFound: room.trackFound[p.id]?.title || false,
    artistFound: room.trackFound[p.id]?.artist || false,
  }));
}

function startRound(room) {
  room.currentOwner = room.order[room.roundIndex];
  if (!room.currentOwner || !room.playlists[room.currentOwner]) {
    console.error("startRound: owner invalide", room.currentOwner);
    return;
  }
  room.phase = "round";
  room.votes = {};
  room.currentTrack = null;
  room.trackFound = {};
  room.trackStartTime = 0;
  room.titleSpeedCount = 0;
  room.artistSpeedCount = 0;
  const tracks = room.playlists[room.currentOwner].tracks;
  io.to(room.hostId).emit("round:tracks", { tracks, roundIndex: room.roundIndex, total: room.order.length });
  io.to(room.code).emit("phase", { phase: "round" });
}

io.on("connection", (socket) => {
  let role = null, roomCode = null, pid = null;

  socket.on("host:create", (ack) => {
    const code = makeCode();
    rooms[code] = {
      code, hostId: socket.id, players: {}, playlists: {},
      order: [], roundIndex: 0, currentOwner: null, votes: {}, phase: "lobby",
      currentTrack: null, trackFound: {}, trackStartTime: 0,
      titleSpeedCount: 0, artistSpeedCount: 0,
    };
    roomCode = code; role = "host"; socket.join(code);
    ack && ack({ code });
  });

  socket.on("host:startGame", (_, ack) => {
    const room = rooms[roomCode];
    if (!room) return ack && ack({ ok: false, error: "Salon introuvable." });
    const owners = Object.keys(room.playlists);
    if (owners.length < 2) return ack && ack({ ok: false, error: "Il faut au moins 2 playlists soumises." });
    room.order = owners.sort(() => Math.random() - 0.5);
    room.roundIndex = 0;
    startRound(room);
    ack && ack({ ok: true });
  });

  socket.on("host:playTrack", ({ track }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.currentTrack = track;
    room.trackFound = {};
    room.trackStartTime = Date.now();
    room.titleSpeedCount = 0;
    room.artistSpeedCount = 0;
    io.to(room.code).emit("track:start");
    io.to(room.hostId).emit("roundStatus", roundStatus(room));
  });

  socket.on("host:trackReveal", ({ track }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(room.code).emit("track:reveal", { title: track.title, artist: track.artist, artwork: track.artwork || "" });
    io.to(room.hostId).emit("roundStatus", roundStatus(room));
  });

  socket.on("host:startVote", () => {
    const room = rooms[roomCode];
    if (!room) return;
    room.phase = "vote"; room.votes = {};
    io.to(roomCode).emit("vote:start", {
      suspects: Object.values(room.players).map(p => ({ id: p.id, name: p.name })),
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
    const ownerName = room.players[owner]?.name || "???";
    io.to(room.hostId).emit("reveal:data", {
      ownerId: owner, ownerName,
      votes: Object.entries(room.votes).map(([v, s]) => ({
        voter: room.players[v]?.name, suspect: room.players[s]?.name, correct: s === owner,
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

  socket.on("host:replay", () => {
    const room = rooms[roomCode];
    if (!room) return;
    // Réinitialise les scores mais garde les playlists
    Object.values(room.players).forEach(p => { p.score = 0; });
    room.order = Object.keys(room.playlists).sort(() => Math.random() - 0.5);
    room.roundIndex = 0;
    room.streaks = {};
    startRound(room);
  });

  socket.on("host:addBot", async (_, ack) => {
    const room = rooms[roomCode];
    if (!room) return ack && ack({ ok: false, error: "Salon introuvable." });
    if (room.phase !== "lobby") return ack && ack({ ok: false, error: "La partie a déjà commencé." });
    try {
      const tracks = await buildBotPlaylist();
      if (!tracks.length) return ack && ack({ ok: false, error: "Impossible de charger la playlist du bot." });
      const botId = "bot" + Math.random().toString(36).slice(2, 6);
      const botNames = ["🤖 Groover","🤖 RoboDJ","🤖 MusiBot","🤖 BeepBoop"];
      const botName = botNames[Math.floor(Math.random() * botNames.length)];
      room.players[botId] = { id: botId, name: botName, socketId: null, score: 0, connected: true, hasPlaylist: true };
      room.playlists[botId] = { tracks };
      ack && ack({ ok: true, name: botName, count: tracks.length });
      io.to(room.hostId).emit("lobby", roster(room));
    } catch (e) { ack && ack({ ok: false, error: e.message }); }
  });

  /* ---------- JOUEUR ---------- */
  socket.on("player:join", ({ code, name }, ack) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return ack && ack({ ok: false, error: "Code de salon introuvable." });
    pid = "p" + Math.random().toString(36).slice(2, 8);
    room.players[pid] = { id: pid, name: String(name || "Joueur").slice(0, 20) || "Joueur", socketId: socket.id, score: 0, connected: true, hasPlaylist: false };
    roomCode = code; role = "player"; socket.join(code);
    ack && ack({ ok: true, pid, phase: room.phase });
    io.to(room.hostId).emit("lobby", roster(room));
  });

  socket.on("player:submitPlaylist", async ({ url }, ack) => {
    const room = rooms[roomCode];
    if (!room || !pid) return ack && ack({ ok: false, error: "Salon fermé." });
    try {
      const tracks = await importPlaylist(url);
      room.playlists[pid] = { tracks };
      room.players[pid].hasPlaylist = true;
      ack && ack({ ok: true, count: tracks.length });
      io.to(room.hostId).emit("submission", { name: room.players[pid].name, count: tracks.length });
      io.to(room.hostId).emit("lobby", roster(room));
    } catch (e) { ack && ack({ ok: false, error: e.message }); }
  });

  socket.on("player:guess", ({ text }) => {
    const room = rooms[roomCode];
    if (!room || !pid || room.phase !== "round" || !room.currentTrack) return;
    const track = room.currentTrack;
    if (!room.trackFound[pid]) room.trackFound[pid] = { title: false, artist: false };
    const found = room.trackFound[pid];

    let titleHit = false, artistHit = false, pointsEarned = 0;

    if (!found.title && isMatch(text, track.title)) {
      found.title = true; titleHit = true;
      const speedBonus = [3, 2, 1][room.titleSpeedCount++] || 0;
      const pts = 5 + speedBonus;
      room.players[pid].score += pts; pointsEarned += pts;
    }
    if (!found.artist && isMatch(text, track.artist)) {
      found.artist = true; artistHit = true;
      const speedBonus = [3, 2, 1][room.artistSpeedCount++] || 0;
      const pts = 5 + speedBonus;
      room.players[pid].score += pts; pointsEarned += pts;
    }

    if (titleHit || artistHit) {
      socket.emit("guess:result", {
        titleHit, artistHit,
        titleFound: found.title, artistFound: found.artist,
        points: pointsEarned, score: room.players[pid].score,
      });
      io.to(roomCode).emit("scoreboard", scoreboard(room));
      io.to(room.hostId).emit("roundStatus", roundStatus(room));
      io.to(room.hostId).emit("guess", { pid, name: room.players[pid]?.name, titleHit, artistHit });
    } else {
      // Feedback raté ou presque
      const near = (!found.title && isNearMiss(text, track.title)) || (!found.artist && isNearMiss(text, track.artist));
      socket.emit("guess:miss", { near });
    }
  });

  socket.on("player:vote", ({ suspectId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote" || !pid) return;
    room.votes[pid] = suspectId;
    io.to(room.hostId).emit("vote:progress", { voted: Object.keys(room.votes).length, total: Object.keys(room.players).length });
  });

  socket.on("disconnect", () => {
    const room = rooms[roomCode];
    if (!room) return;
    if (role === "host") { io.to(roomCode).emit("roomClosed"); delete rooms[roomCode]; }
    else if (pid && room.players[pid]) { room.players[pid].connected = false; io.to(room.hostId).emit("lobby", roster(room)); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Blindtest Imposteur sur le port " + PORT));
