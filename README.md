# Azure Doc Assistant

A small LLM-backed service, deployed to Azure with Terraform end to end — no manual
console clicking. Built as a focused, hands-on demonstration of deploying secure AI
solutions on a cloud platform using Infrastructure as Code.

## What it does

A TypeScript/Express service that answers questions via the Anthropic Claude API,
containerized and running on Azure Container Apps.

```
client → Azure Container Apps → (secrets from Azure Key Vault) → Claude API → answer
```

## Stack

- **App:** Node.js / TypeScript, Express, `@anthropic-ai/sdk`
- **Container:** Docker (multi-stage build), image published to GitHub Container Registry
- **Infrastructure:** Terraform (`hashicorp/azurerm`) — resource group, Key Vault,
  Log Analytics workspace, Container Apps environment, Container App
- **Secrets:** Azure Key Vault, least-privilege access policy, never committed to
  version control

## Why

Built to close a specific, honest gap between existing experience and a job posting
that named Terraform and Azure explicitly — rather than claiming skills not yet
demonstrated, this repository is the actual proof.

## Layout

- `app/` — the service (`src/server.ts`) and its `Dockerfile`
- `infra/` — Terraform configuration for the Azure deployment
- `TILANNE.md` — running status notes (Finnish)

## Running locally

```bash
cd app
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

## Deploying

```bash
cd infra
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Requires `~/.anthropic_key` and `~/.ghcr_token` (read locally by Terraform via
`file()`, never stored in this repository) and `az login` completed beforehand.
