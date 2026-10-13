# Bitácora de comandos (solo lectura)

Usar siempre `--region` explícito; los recursos de backend están en `us-east-2`.

```bash
# Identidad y perfiles
aws sts get-caller-identity
aws configure list-profiles

# Frontend (us-east-1)
aws s3 ls s3://cloud-s3-chati --recursive --summarize
aws cloudfront get-distribution --id E14JJ18WEECQCL

# Backend (us-east-2)
aws ec2 describe-instances --region us-east-2
aws lambda list-functions --region us-east-2
aws lambda list-event-source-mappings --region us-east-2
aws apigatewayv2 get-routes --api-id yxpnxitdnh --region us-east-2
aws apigatewayv2 get-integrations --api-id yxpnxitdnh --region us-east-2
aws dynamodb describe-table --table-name Products --region us-east-2
aws sns list-subscriptions --region us-east-2
aws sqs get-queue-attributes --region us-east-2 \
  --queue-url https://sqs.us-east-2.amazonaws.com/258344940817/miCola --attribute-names All

# IAM
aws iam list-users
aws iam list-roles
aws iam get-account-summary

# Costos
aws ce get-cost-and-usage --time-period Start=2026-10-01,End=2026-10-13 \
  --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
```

## Nota zsh
No guardar `--region X --output json` en una variable y expandirla sin comillas: zsh no divide palabras y el CLI falla con `Unknown options`. Usar una función o repetir el flag.
