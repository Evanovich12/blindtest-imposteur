# 👻🎵 Blindtest Imposteur

Un blindtest entre amis : un **PC central** diffuse la musique, les invités jouent **depuis leur téléphone** (QR code). Chacun soumet **en secret** une de ses playlists Spotify. À chaque manche, on devine les morceaux, puis on **vote pour démasquer** le propriétaire de la playlist. Lui, il doit rester introuvable.

- Le PC garde l'écran principal ouvert (le code + le QR + la musique).
- Les téléphones scannent le QR → rejoignent → soumettent leur playlist → devinent → votent.
- La musique vient des extraits 30 s d'**iTunes** (gratuit), retrouvés à partir de ta **playlist Spotify**.

---

## Ce qu'il te faut (gratuit)

1. Un compte **Spotify** (pour créer une clé d'accès — gratuit, même sans Premium).
2. Un compte **GitHub** (pour stocker le code — gratuit).
3. Un compte **Render** (pour héberger — gratuit, ou ~7 €/mois pour que ce soit toujours allumé).

Aucune compétence en code requise : tout se fait dans le navigateur, en glissant des fichiers et en cliquant.

---

## Étape 1 — Récupérer tes clés Spotify (2 min)

1. Va sur **https://developer.spotify.com/dashboard** et connecte-toi.
2. Clique **Create app**.
3. Remplis :
   - **App name** : `Blindtest` (ce que tu veux)
   - **Redirect URI** : `http://127.0.0.1:3000` (obligatoire à remplir, mais on ne s'en sert pas)
   - Coche **Web API**.
4. Crée l'app, puis ouvre **Settings**. Tu y trouves :
   - **Client ID** → copie-le
   - **Client secret** (clique « View client secret ») → copie-le
5. Garde ces deux valeurs sous la main pour l'étape 3.

---

## Étape 2 — Mettre le code sur GitHub (sans rien installer)

1. Va sur **https://github.com/new**.
2. Donne un nom au dépôt (ex. `blindtest-imposteur`), laisse **Public**, clique **Create repository**.
3. Sur la page du dépôt vide, clique **uploading an existing file** (le lien dans la phrase « …or upload an existing file »).
4. Glisse-dépose **tout le contenu de ce dossier** (le fichier `server.js`, `package.json`, le dossier `public`, etc.). 
   > Important : envoie les fichiers eux-mêmes, pas le dossier `blindtest-imposteur` autour. À la racine du dépôt tu dois voir `server.js` et `package.json` directement.
5. Clique **Commit changes**.

---

## Étape 3 — Déployer sur Render (5 min)

1. Va sur **https://render.com**, crée un compte (tu peux te connecter avec GitHub).
2. Clique **New +** → **Web Service**.
3. Connecte ton compte GitHub et choisis le dépôt `blindtest-imposteur`.
4. Render détecte Node tout seul. Vérifie / renseigne :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** :
     - **Free** → gratuit, mais le serveur s'endort après 15 min (≈1 min de réveil au 1er accès).
     - **Starter (~7 $/mois)** → toujours allumé, instantané. ✅ recommandé si tu veux que ce soit fluide en soirée.
5. Ouvre la section **Environment Variables** et ajoute **deux variables** (celles de l'étape 1) :
   - `SPOTIFY_CLIENT_ID` = ton Client ID
   - `SPOTIFY_CLIENT_SECRET` = ton Client secret
6. Clique **Create Web Service**. Render installe et démarre (1-2 min).
7. En haut, tu obtiens une URL du type **`https://blindtest-imposteur.onrender.com`**. C'est ton jeu.

> Astuce plan gratuit : ouvre l'écran principal ~1 min avant de commencer, le temps que le serveur se réveille.

---

## Étape 4 — Jouer

1. Sur le **PC** (branché à l'enceinte / la TV), ouvre ton URL Render. Tu arrives sur l'accueil → clique **Ouvrir l'écran principal**.
2. Un **code à 4 lettres** et un **QR code** s'affichent.
3. Chaque invité scanne le QR (ou va sur `…onrender.com/play.html` et tape le code), met son prénom.
4. Chacun **colle le lien d'une de ses playlists Spotify** (playlist **perso** et **publique**). Personne ne voit la playlist des autres.
5. Quand au moins 2 playlists sont prêtes, clique **Lancer la partie** sur le PC.
6. À chaque morceau : tu écoutes sur le PC, les gens devinent (à l'oral ou en tapant sur leur tél). Tu cliques **+1** sur ceux qui ont trouvé, puis **Révéler**.
7. Après les morceaux d'une playlist : **vote secret** depuis les téléphones → **Révéler l'imposteur** → débat → manche suivante.
8. À la fin : podium 👑.

---

## Comment marquer des points

- **+1** par morceau correctement deviné (attribué à la main par l'hôte).
- **+2** pour qui démasque correctement le propriétaire de la playlist.
- Le **propriétaire** gagne **+1 par vote trompé** (récompense ceux qui se planquent bien).

Tu peux changer ces valeurs dans `server.js` (cherche `score += 2` et `score += survived`).

---

## Bon à savoir

- **Playlists lisibles** : les playlists **perso publiques** fonctionnent. Les playlists **éditoriales de Spotify** (Top 50, Discover Weekly, « This Is… ») ne sont **pas** lisibles par les nouvelles apps depuis fin 2024 — le jeu te le dira si tu en colles une.
- **Extraits manquants** : certains morceaux n'ont pas d'extrait sur iTunes ; ils sont simplement ignorés. Le jeu garde jusqu'à 10 morceaux jouables par playlist.
- **Limite iTunes** (~20 recherches/min) : si tout le monde soumet sa playlist exactement en même temps, laisse passer quelques secondes entre deux envois.
- **Confidentialité** : les playlists ne sont jamais affichées sur l'écran principal ni envoyées aux autres téléphones — elles restent côté serveur le temps de la partie, puis disparaissent.

---

## (Optionnel) Tester sur ton PC d'abord

Si tu veux essayer en local avant de déployer :

```bash
npm install
# Mets tes clés Spotify dans l'environnement, puis :
SPOTIFY_CLIENT_ID=xxxx SPOTIFY_CLIENT_SECRET=yyyy npm start
```

Puis ouvre `http://localhost:3000`. (Sur Windows, utilise deux commandes `set` pour les variables, ou installe le projet directement sur Render — c'est plus simple.)
