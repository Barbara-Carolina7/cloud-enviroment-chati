// npm run local:up — levanta LocalStack (SNS, SQS, Lambda). Requiere Docker en ejecución.
import { paths } from '../lib/config.js'
import { run } from '../lib/proc.js'

await run('docker', ['compose', '-f', paths.compose, 'up', '-d']).catch((e) => {
  console.error(`${e.message}\n¿Docker está instalado y en ejecución?`)
  process.exit(1)
})
console.log('\nLocalStack arriba. Siguiente paso: npm run local:init')
