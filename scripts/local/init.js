// npm run local:init — crea en LocalStack los mismos recursos que en AWS y los conecta:
//   SNS report-events ─┬─► SQS report-requests   (+DLQ) ─► Lambda report-request-recorder
//                      └─► SQS report-generation (+DLQ) ─► Lambda report-generator
// Se puede ejecutar varias veces: reutiliza topic y colas, y recrea las Lambdas.
import { CreateTopicCommand, SubscribeCommand } from '@aws-sdk/client-sns'
import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs'
import {
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  DeleteEventSourceMappingCommand,
  DeleteFunctionCommand,
  ListEventSourceMappingsCommand,
  waitUntilFunctionActiveV2,
} from '@aws-sdk/client-lambda'
import { ACCOUNT_ID, MESSAGE_TYPE, REGION, dbConfig, paths } from '../lib/config.js'
import { lambda, sns, sqs, waitForLocalStack } from '../lib/aws.js'
import { buildLambdaZip } from '../lib/zip.js'

const ROLE = `arn:aws:iam::${ACCOUNT_ID}:role/lambda-role`
const RUNTIME = 'nodejs20.x'

const db = dbConfig()
console.log('Esperando a LocalStack...')
await waitForLocalStack().catch((e) => {
  console.error(e.message)
  process.exit(1)
})

console.log('== SNS')
const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: 'report-events' }))
console.log(TopicArn)

async function queueArn(url) {
  const out = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }))
  return out.Attributes.QueueArn
}

async function createQueueWithDlq(name) {
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${name}-dlq` }))
  const dlqArn = await queueArn(dlq.QueueUrl)
  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        VisibilityTimeout: '90',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '3' }),
      },
    }),
  )
  const arn = await queueArn(queue.QueueUrl)
  await sns.send(
    new SubscribeCommand({
      TopicArn,
      Protocol: 'sqs',
      Endpoint: arn,
      Attributes: {
        FilterPolicy: JSON.stringify({ type: [MESSAGE_TYPE] }),
        FilterPolicyScope: 'MessageBody',
        RawMessageDelivery: 'false',
      },
    }),
  )
  console.log(`${name} -> ${arn}`)
  return arn
}

console.log('== SQS + DLQ + suscripciones')
const requestsArn = await createQueueWithDlq('report-requests')
const generationArn = await createQueueWithDlq('report-generation')

console.log('== Empaquetando Lambdas')
const recorderZip = await buildLambdaZip(paths.recorder, { install: true })
const generatorZip = await buildLambdaZip(paths.generator, { install: true })

async function deployLambda({ name, zip, queueArn: sourceArn, env }) {
  // LocalStack no borra los mapeos al borrar la función: se eliminan primero.
  const { EventSourceMappings = [] } = await lambda.send(
    new ListEventSourceMappingsCommand({ EventSourceArn: sourceArn }),
  )
  for (const m of EventSourceMappings) {
    await lambda.send(new DeleteEventSourceMappingCommand({ UUID: m.UUID })).catch(() => {})
  }
  await lambda.send(new DeleteFunctionCommand({ FunctionName: name })).catch(() => {})
  await lambda.send(
    new CreateFunctionCommand({
      FunctionName: name,
      Runtime: RUNTIME,
      Handler: 'index.handler',
      Timeout: 15,
      Role: ROLE,
      Code: { ZipFile: zip },
      ...(env ? { Environment: { Variables: env } } : {}),
    }),
  )
  await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: name })
  await lambda.send(
    new CreateEventSourceMappingCommand({ FunctionName: name, EventSourceArn: sourceArn, BatchSize: 5 }),
  )
  console.log(`${name} <- ${sourceArn.split(':').pop()}`)
}

console.log('== Lambdas')
await deployLambda({
  name: 'report-request-recorder',
  zip: recorderZip,
  queueArn: requestsArn,
  env: { DATABASE_URL: db.lambdaUrl, DATABASE_SSL: String(db.ssl) },
})
// Por defecto el aviso se imprime en el log (NOTIFY_MODE=log). Para publicarlo de verdad en la API de avisos,
// define API_NOTIFICATION y API_TOKEN_INTEGRATION en local/.env.
const publishForReal = process.env.API_NOTIFICATION && process.env.API_TOKEN_INTEGRATION
await deployLambda({
  name: 'report-generator',
  zip: generatorZip,
  queueArn: generationArn,
  env: {
    DATABASE_URL: db.lambdaUrl,
    DATABASE_SSL: String(db.ssl),
    ...(publishForReal
      ? { API_NOTIFICATION: process.env.API_NOTIFICATION, API_TOKEN_INTEGRATION: process.env.API_TOKEN_INTEGRATION }
      : { NOTIFY_MODE: 'log' }),
  },
})
console.log(publishForReal ? 'report-generator publicará avisos en la API real.' : 'report-generator imprimirá el aviso en su log (NOTIFY_MODE=log).')

console.log(`\nListo (${REGION}, cuenta ${ACCOUNT_ID}). Base: ${db.label}`)
console.log('Siguiente: npm run local:send-test   (prueba sin BFF)   |   npm run local:dev   (OIDC + BFF + front)')
