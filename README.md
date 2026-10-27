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

## Ingesting a document corpus

By default the service answers questions over the job-hunt-data corpus (index
`documents`). To point it at any other folder of `.md`/`.pdf` files, ingest it
into its own named index:

```bash
cd app
AZURE_SEARCH_ENDPOINT=... AZURE_SEARCH_API_KEY=... \
  npm run ingest -- --index <name> --dir <folder> [--dir <folder2> ...]
```

Each index is a separate, independent corpus — ingesting into a new `--index`
name never mixes with existing ones. Get the env var values from
`terraform output -raw search_endpoint` / `search_api_key` in `infra/`.

## Querying a specific corpus

- `GET /indexes` — lists every ingested index name
- `POST /ask` — body `{ "question": "...", "index": "<name>" }` (`index` is
  optional, defaults to `documents`)
- The `ask_documents` MCP tool takes the same optional `index` argument
