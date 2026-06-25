/* ------------------------------------------------------------------ *
 *  Blindtest Imposteur — serveur central
 * ------------------------------------------------------------------ */
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

// Empêche le crash du processus sur erreur non gérée
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));

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

app.get("/debug/playlist", async (req, res) => {
  const url = req.query.url || "";
  if (!url) return res.send("<p>Ajoute <code>?url=https://open.spotify.com/playlist/...</code></p>");
  try {
    const tracks = await importPlaylist(url);
    const rows = tracks.map((t, i) =>
      `<tr style="background:${i%2?"#1a1a2e":"#16213e"}">
        <td style="padding:4px 8px;color:#aaa">${i+1}</td>
        <td style="padding:4px 8px">${t.title}</td>
        <td style="padding:4px 8px;color:#aaa">${t.artist}</td>
        <td style="padding:4px 8px;text-align:center">${t.previewUrl ? '<span style="color:#4ecca3">✓</span>' : '<span style="color:#e94560">✗</span>'}</td>
        <td style="padding:4px 8px;text-align:center">${t.artwork ? '<img src="'+t.artwork+'" style="height:32px;border-radius:4px">' : '—'}</td>
      </tr>`
    ).join("");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Debug playlist</title></head>
      <body style="background:#0f0f23;color:white;font-family:monospace;padding:20px">
        <h2>✅ ${tracks.length} tracks importées</h2>
        <table style="border-collapse:collapse;width:100%">
          <thead><tr style="background:#e94560">
            <th style="padding:6px 8px">#</th><th style="padding:6px 8px">Titre</th>
            <th style="padding:6px 8px">Artiste</th><th style="padding:6px 8px">Preview</th><th style="padding:6px 8px">Art</th>
          </tr></thead><tbody>${rows}</tbody>
        </table>
      </body></html>`);
  } catch (e) {
    res.send(`<body style="background:#0f0f23;color:#e94560;font-family:monospace;padding:20px"><h2>Erreur</h2><p>${e.message}</p></body>`);
  }
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

async function deezerPreview(title, artist) {
  try {
    const q = encodeURIComponent(`track:"${title}" artist:"${artist}"`);
    const r = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`);
    if (!r.ok) return null;
    const d = await r.json();
    const hit = (d.data || [])[0];
    if (!hit?.preview) return null;
    return { previewUrl: hit.preview, artwork: hit.album?.cover_medium || hit.album?.cover || "" };
  } catch (_) { return null; }
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
  const entity = data?.props?.pageProps?.state?.data?.entity;
  const accessToken = data?.props?.pageProps?.state?.settings?.session?.accessToken;
  const trackList = entity?.trackList;
  if (!trackList?.length) throw new Error("Playlist vide ou introuvable. Assure-toi qu'elle est publique.");

  // Collect all track metadata (with or without Spotify preview)
  let allItems = trackList.map(t => ({
    title: t.title || "", artist: t.subtitle || "",
    previewUrl: t.audioPreview?.url || "",
    artwork: t.imageUrl || t.image?.sources?.[0]?.url || "",
  }));

  // Paginate via Spotify API to get tracks beyond the first 100
  if (accessToken && trackList.length >= 100) {
    const limit = 50;
    for (let offset = 100; offset < 800; offset += limit) {
      try {
        const apiR = await fetch(
          `https://api.spotify.com/v1/playlists/${id}/tracks?limit=${limit}&offset=${offset}&fields=items(track(name,artists,preview_url,album(images)))`,
          { headers: { "Authorization": `Bearer ${accessToken}` } }
        );
        if (!apiR.ok) break;
        const apiData = await apiR.json();
        const items = apiData.items || [];
        for (const item of items) {
          const t = item?.track;
          if (t?.name) {
            allItems.push({
              title: t.name,
              artist: t.artists?.map(a => a.name).join(", ") || "",
              previewUrl: t.preview_url || "",
              artwork: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || "",
            });
          }
        }
        if (items.length < limit) break;
      } catch (_) { break; }
      await new Promise(res => setTimeout(res, 150));
    }
  }

  // Deduplicate by title+artist, keep spotify preview if available
  const seen = new Map();
  for (const t of allItems) {
    if (!t.title) continue;
    const key = `${t.title}|||${t.artist}`.toLowerCase();
    if (!seen.has(key) || (!seen.get(key).previewUrl && t.previewUrl)) seen.set(key, t);
  }
  const deduped = [...seen.values()];

  // For tracks without Spotify preview, try Deezer fallback (batches of 8)
  const noPreview = deduped.filter(t => !t.previewUrl);
  console.log(`[Spotify] ${deduped.length} tracks total, ${deduped.length - noPreview.length} avec preview Spotify, ${noPreview.length} à chercher sur Deezer`);
  for (let b = 0; b < noPreview.length; b += 8) {
    const batch = noPreview.slice(b, b + 8);
    const results = await Promise.allSettled(batch.map(t => deezerPreview(t.title, t.artist)));
    results.forEach((res, j) => {
      if (res.status === "fulfilled" && res.value) {
        batch[j].previewUrl = res.value.previewUrl;
        if (!batch[j].artwork && res.value.artwork) batch[j].artwork = res.value.artwork;
      }
    });
    await new Promise(res => setTimeout(res, 100));
  }

  const tracks = deduped.filter(t => t.previewUrl);
  if (!tracks.length) throw new Error("Aucun extrait audio disponible dans cette playlist Spotify.");
  console.log(`[Spotify] ${tracks.length} tracks avec preview après fallback Deezer`);

  // iTunes artwork fallback for remaining tracks without artwork
  const missingArt = tracks.map((t, i) => ({ i, t })).filter(({ t }) => !t.artwork);
  for (let b = 0; b < missingArt.length; b += 5) {
    const batch = missingArt.slice(b, b + 5);
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
  return items.map(t => ({
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
  return all; // On garde tout — la sélection de 10 se fait à chaque manche
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

// Fisher-Yates — shuffle sans biais
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startRound(room) {
  // Choisit un owner aléatoire parmi ceux qui ont une playlist
  const owners = Object.keys(room.playlists);
  room.currentOwner = owners[Math.floor(Math.random() * owners.length)];
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
  // Pioche 10 morceaux aléatoires depuis le pool complet
  const tracks = shuffle(room.playlists[room.currentOwner].tracks).slice(0, 10);
  io.to(room.hostId).emit("round:tracks", { tracks });
  io.to(room.code).emit("phase", { phase: "round" });
}

// Wrap handlers pour éviter les crashs sur erreur synchrone non prévue
function safe(fn) {
  return (...args) => { try { fn(...args); } catch (e) { console.error("[socket handler]", e); } };
}

io.on("connection", (socket) => {
  let role = null, roomCode = null, pid = null;

  socket.on("host:create", safe((ack) => {
    const code = makeCode();
    rooms[code] = {
      code, hostId: socket.id, players: {}, playlists: {},
      currentOwner: null, votes: {}, phase: "lobby",
      currentTrack: null, trackFound: {}, trackStartTime: 0,
      titleSpeedCount: 0, artistSpeedCount: 0,
    };
    roomCode = code; role = "host"; socket.join(code);
    ack && ack({ code });
  }));

  socket.on("host:startGame", safe((_, ack) => {
    const room = rooms[roomCode];
    if (!room) return ack && ack({ ok: false, error: "Salon introuvable." });
    if (Object.keys(room.playlists).length < 2) return ack && ack({ ok: false, error: "Il faut au moins 2 playlists soumises." });
    startRound(room);
    ack && ack({ ok: true });
  }));

  socket.on("host:playTrack", safe(({ track }) => {
    const room = rooms[roomCode];
    if (!room || !track) return;
    room.currentTrack = track;
    room.trackFound = {};
    room.trackStartTime = Date.now();
    room.titleSpeedCount = 0;
    room.artistSpeedCount = 0;
    io.to(room.code).emit("track:start");
    io.to(room.hostId).emit("roundStatus", roundStatus(room));
  }));

  socket.on("host:trackReveal", safe(({ track }) => {
    const room = rooms[roomCode];
    if (!room || !track) return;
    io.to(room.code).emit("track:reveal", { title: track.title, artist: track.artist, artwork: track.artwork || "" });
    io.to(room.hostId).emit("roundStatus", roundStatus(room));
  }));

  socket.on("host:startVote", safe(() => {
    const room = rooms[roomCode];
    if (!room) return;
    room.phase = "vote"; room.votes = {};
    io.to(roomCode).emit("vote:start", {
      suspects: Object.values(room.players).map(p => ({ id: p.id, name: p.name })),
    });
    io.to(room.hostId).emit("vote:progress", { voted: 0, total: Object.keys(room.players).length });
  }));

  socket.on("host:reveal", safe(() => {
    const room = rooms[roomCode];
    if (!room) return;
    const owner = room.currentOwner;
    if (!owner) return;
    let votesAgainst = 0, survived = 0;
    const totalVotes = Object.keys(room.votes).length;
    for (const [voter, suspect] of Object.entries(room.votes)) {
      if (suspect === owner) {
        votesAgainst++;
        if (room.players[voter]) room.players[voter].score += 2;
      } else {
        survived++;
      }
    }
    if (room.players[owner]) room.players[owner].score += survived;
    room.phase = "reveal";
    // L'imposteur gagne si moins de la moitié des votes vont contre lui
    const impostorWon = totalVotes === 0 || votesAgainst * 2 < totalVotes;
    const ownerName = room.players[owner]?.name || "???";
    io.to(room.hostId).emit("reveal:data", {
      ownerId: owner, ownerName, impostorWon,
      votes: Object.entries(room.votes).map(([v, s]) => ({
        voter: room.players[v]?.name, suspect: room.players[s]?.name, correct: s === owner,
      })),
    });
    io.to(roomCode).emit("reveal", { ownerName, impostorWon });
    io.to(roomCode).emit("scoreboard", scoreboard(room));
  }));

  // host:nextRound gardé pour compatibilité (redirige vers replay)
  socket.on("host:nextRound", safe(() => {
    const room = rooms[roomCode];
    if (!room) return;
    startRound(room);
  }));

  socket.on("host:replay", safe(() => {
    const room = rooms[roomCode];
    if (!room) return;
    startRound(room); // scores conservés, nouvel owner aléatoire
  }));

  socket.on("host:addBot", async (_, ack) => {
    try {
      const room = rooms[roomCode];
      if (!room) return ack && ack({ ok: false, error: "Salon introuvable." });
      if (room.phase !== "lobby") return ack && ack({ ok: false, error: "La partie a déjà commencé." });
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
  socket.on("player:join", safe(({ code, name }, ack) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return ack && ack({ ok: false, error: "Code de salon introuvable." });
    pid = "p" + Math.random().toString(36).slice(2, 8);
    room.players[pid] = { id: pid, name: String(name || "Joueur").slice(0, 20) || "Joueur", socketId: socket.id, score: 0, connected: true, hasPlaylist: false };
    roomCode = code; role = "player"; socket.join(code);
    ack && ack({ ok: true, pid, phase: room.phase });
    io.to(room.hostId).emit("lobby", roster(room));
  }));

  socket.on("player:submitPlaylist", async ({ url }, ack) => {
    try {
      const room = rooms[roomCode];
      if (!room || !pid) return ack && ack({ ok: false, error: "Salon fermé." });
      const tracks = await importPlaylist(url);
      room.playlists[pid] = { tracks };
      room.players[pid].hasPlaylist = true;
      ack && ack({ ok: true, count: tracks.length });
      io.to(room.hostId).emit("submission", { name: room.players[pid].name, count: tracks.length });
      io.to(room.hostId).emit("lobby", roster(room));
    } catch (e) { ack && ack({ ok: false, error: e.message }); }
  });

  socket.on("player:guess", safe(({ text }) => {
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
      const near = (!found.title && isNearMiss(text, track.title)) || (!found.artist && isNearMiss(text, track.artist));
      socket.emit("guess:miss", { near });
    }
  }));

  socket.on("player:vote", safe(({ suspectId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote" || !pid) return;
    room.votes[pid] = suspectId;
    io.to(room.hostId).emit("vote:progress", { voted: Object.keys(room.votes).length, total: Object.keys(room.players).length });
  }));

  socket.on("disconnect", () => {
    try {
      const room = rooms[roomCode];
      if (!room) return;
      if (role === "host") { io.to(roomCode).emit("roomClosed"); delete rooms[roomCode]; }
      else if (pid && room.players[pid]) { room.players[pid].connected = false; io.to(room.hostId).emit("lobby", roster(room)); }
    } catch (e) { console.error("[disconnect]", e); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Blindtest Imposteur sur le port " + PORT));
