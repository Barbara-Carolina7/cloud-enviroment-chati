// Empaquetado de las Lambdas en memoria (sin el comando `zip`).
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { run } from './proc.js'

// Copia la carpeta a un directorio temporal, instala solo dependencias de producción y la comprime.
export async function buildLambdaZip(sourceDir, { install }) {
  const work = mkdtempSync(path.join(tmpdir(), 'lambda-'))
  try {
    cpSync(sourceDir, work, {
      recursive: true,
      filter: (src) =>
        !src.split(path.sep).some((p) => ['node_modules', '.git', '.claude', '.DS_Store'].includes(p)),
    })
    if (install) {
      await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: work })
    }
    const zip = new AdmZip()
    zip.addLocalFolder(work)
    return zip.toBuffer()
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
