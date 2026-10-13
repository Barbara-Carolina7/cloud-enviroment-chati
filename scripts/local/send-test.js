// npm run local:send-test — publica una solicitud en el SNS local y muestra qué hizo cada Lambda.
// Escribe una fila en report_requests con type LOCAL_TEST; bórrala con:
//   DELETE FROM report_requests WHERE type = 'LOCAL_TEST';
import { PublishCommand } from '@aws-sdk/client-sns'
import { FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { MESSAGE_TYPE, TOPIC_ARN } from '../lib/config.js'
import { logs, sns, waitForLocalStack } from '../lib/aws.js'

await waitForLocalStack().catch((e) => {
  console.error(e.message)
  process.exit(1)
})

const requestId = `local-${Date.now()}`
const message = {
  type: MESSAGE_TYPE,
  body: {
    requestId,
    requester: 'local@example.com',
    requesterId: 'sub-local',
    reportType: 'LOCAL_TEST',
    params: { origin: 'local' },
    requestedAt: new Date().toISOString(),
  },
}

const { MessageId } = await sns.send(new PublishCommand({ TopicArn: TOPIC_ARN, Message: JSON.stringify(message) }))
console.log(`Publicado ${MessageId}\nrequestId: ${requestId}`)
console.log('Esperando (la primera vez LocalStack descarga la imagen de Lambda y puede tardar ~1 min)...')

async function waitForLogs(fn, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = await logs.send(
        new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${fn}`, filterPattern: `"${requestId}"` }),
      )
      if (out.events?.length) return out.events.map((e) => e.message.trim()).join('\n')
    } catch {
      // el log group aún no existe
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return '(sin logs con este requestId)'
}

for (const fn of ['report-generator', 'report-request-recorder']) {
  console.log(`\n=========== ${fn}`)
  console.log((await waitForLogs(fn)).replace(/postgresql:\/\/\S+/g, 'postgresql://***'))
}
