# Blindtest Imposteur — client

Frontend React (Vite + Tailwind CSS v4 + shadcn/ui), à côté du serveur Express/Socket.io
existant (`../server.js`). Ce dossier est indépendant : il a son propre `package.json`
et se build séparément.

## Stack installée

- **Vite + React** (JavaScript, pas TypeScript)
- **Tailwind CSS v4** (`@tailwindcss/vite`)
- **shadcn/ui** — config dans `components.json`, utilitaire `cn()` dans `src/lib/utils.js`,
  composants dans `src/components/ui/` (ex: `button.jsx`)
- **motion** (`motion/react`) — animations
- **three**, **@react-three/fiber**, **@react-three/drei** — scènes 3D

## Commandes

```bash
npm install
npm run dev      # serveur de dev Vite
npm run build    # build de prod -> dist/
```

## Ajouter des composants shadcn/ui, Aceternity UI ou React Bits

⚠️ Dans cet environnement, l'accès réseau sortant vers `ui.shadcn.com`,
`ui.aceternity.com` et `reactbits.dev` est bloqué par la politique réseau du
conteneur (403 sur le proxy). Les commandes CLI ci-dessous ne fonctionneront
qu'une fois ces domaines autorisés (menu de l'environnement cloud → Edit →
Network access), ou en local sur ta machine.

```bash
# shadcn/ui — ajoute un composant officiel
npx shadcn@latest add <component>

# Aceternity UI — chaque composant fournit une URL de registre compatible shadcn
npx shadcn@latest add "https://ui.aceternity.com/registry/<component>.json"

# React Bits — idem, registre compatible shadcn (voir la page du composant sur reactbits.dev)
npx shadcn@latest add "https://reactbits.dev/r/<Component>-JS-CSS"
```

Ces trois écosystèmes reposent sur les mêmes briques (déjà installées ici) :
Tailwind CSS + variables CSS, `class-variance-authority`, `clsx`, `tailwind-merge`,
`motion`. Un composant copié depuis Aceternity UI ou React Bits devrait donc
s'intégrer sans dépendance supplémentaire, sauf mention contraire dans sa doc
(par ex. `lucide-react`, déjà installé aussi).

## Intégration avec le serveur Express

Pas encore branché : `npm run build` génère `client/dist/`, mais `../server.js`
ne le sert pas encore. À faire quand la migration des pages (`index.html`,
`host.html`, `play.html`) vers des composants React sera lancée.
