// Ejecución de procesos que funciona igual en Mac, Linux y Windows.
import { spawn } from 'node:child_process'
import net from 'node:net'

const isWindows = process.platform === 'win32'

// En Windows, npm/gradlew/docker son .cmd/.bat y requieren shell.
export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: isWindows, ...options })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} terminó con código ${code}`)),
    )
  })
}

export function gradlew() {
  return isWindows ? 'gradlew.bat' : './gradlew'
}

export function waitForPort(port, host = '127.0.0.1', timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`Nada escucha en ${host}:${port}`))
        else setTimeout(attempt, 500)
      })
    }
    attempt()
  })
}
