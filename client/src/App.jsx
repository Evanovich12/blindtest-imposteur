import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { motion } from 'motion/react'

import { Button } from '@/components/ui/button'

function Scene() {
  return (
    <Canvas camera={{ position: [0, 0, 4] }}>
      <ambientLight intensity={0.6} />
      <pointLight position={[5, 5, 5]} />
      <mesh rotation={[0.4, 0.4, 0]}>
        <icosahedronGeometry args={[1.2, 0]} />
        <meshStandardMaterial color="#aa3bff" wireframe />
      </mesh>
      <OrbitControls enableZoom={false} autoRotate />
    </Canvas>
  )
}

function App() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex min-h-svh flex-col items-center justify-center gap-6 p-6 text-center"
    >
      <div className="h-64 w-64">
        <Scene />
      </div>
      <h1 className="text-2xl font-semibold">Blindtest Imposteur</h1>
      <p className="max-w-md text-muted-foreground">
        Nouveau frontend React (Vite + Tailwind + shadcn/ui + Motion +
        react-three-fiber/drei) en construction.
      </p>
      <Button>Ça marche</Button>
    </motion.div>
  )
}

export default App
