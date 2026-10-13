// npm run local:down — apaga LocalStack (los recursos locales se pierden; local:init los recrea).
import { paths } from '../lib/config.js'
import { run } from '../lib/proc.js'

await run('docker', ['compose', '-f', paths.compose, 'down']).catch((e) => {
  console.error(e.message)
  process.exit(1)
})
