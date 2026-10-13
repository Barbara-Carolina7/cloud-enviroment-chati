// Clientes del SDK de AWS apuntando a LocalStack (no se necesita el CLI de AWS).
import { SNSClient } from '@aws-sdk/client-sns'
import { SQSClient } from '@aws-sdk/client-sqs'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs'
import { LOCALSTACK_URL, REGION } from './config.js'

const base = {
  region: REGION,
  endpoint: LOCALSTACK_URL,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
}

export const sns = new SNSClient(base)
export const sqs = new SQSClient(base)
export const lambda = new LambdaClient(base)
export const logs = new CloudWatchLogsClient(base)

export async function waitForLocalStack(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${LOCALSTACK_URL}/_localstack/health`)
      if (res.ok) return
    } catch {
      // aún no responde
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('LocalStack no responde en http://localhost:4566. Ejecuta primero: npm run local:up')
}
