locals {
  project  = "docassist"
  location = "northeurope"
}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "random_password" "service_api_key" {
  length  = 32
  special = false
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.project}"
  location = local.location
}

# --- Secrets: Key Vault is the source of truth ---

resource "azurerm_key_vault" "main" {
  name                       = "kv-${local.project}-${random_string.suffix.result}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  soft_delete_retention_days = 7
  purge_protection_enabled   = false
}

resource "azurerm_key_vault_access_policy" "deployer" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = data.azurerm_client_config.current.object_id

  secret_permissions = ["Get", "List", "Set", "Delete", "Purge"]
}

resource "azurerm_key_vault_secret" "anthropic_api_key" {
  name         = "anthropic-api-key"
  value        = trimspace(file(pathexpand("~/.anthropic_key")))
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_key_vault_access_policy.deployer]
}

resource "azurerm_key_vault_secret" "ghcr_token" {
  name         = "ghcr-token"
  value        = trimspace(file(pathexpand("~/.ghcr_token")))
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_key_vault_access_policy.deployer]
}

resource "azurerm_key_vault_secret" "service_api_key" {
  name         = "service-api-key"
  value        = random_password.service_api_key.result
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_key_vault_access_policy.deployer]
}

# --- Container Apps ---

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.project}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "main" {
  name                       = "env-${local.project}"
  resource_group_name       = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
}

resource "azurerm_container_app" "main" {
  name                         = "app-${local.project}"
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"

  registry {
    server               = "ghcr.io"
    username              = "RJKA99"
    password_secret_name = "ghcr-token"
  }

  secret {
    name  = "ghcr-token"
    value = azurerm_key_vault_secret.ghcr_token.value
  }

  secret {
    name  = "anthropic-api-key"
    value = azurerm_key_vault_secret.anthropic_api_key.value
  }

  secret {
    name  = "service-api-key"
    value = azurerm_key_vault_secret.service_api_key.value
  }

  secret {
    name  = "search-api-key"
    value = azurerm_key_vault_secret.search_api_key.value
  }

  template {
    min_replicas = 0
    max_replicas = 1

    container {
      name   = "app"
      image  = "ghcr.io/rjka99/azure-doc-assistant:latest"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name        = "ANTHROPIC_API_KEY"
        secret_name = "anthropic-api-key"
      }

      env {
        name        = "SERVICE_API_KEY"
        secret_name = "service-api-key"
      }

      env {
        name  = "AZURE_SEARCH_ENDPOINT"
        value = "https://${azurerm_search_service.main.name}.search.windows.net"
      }

      env {
        name        = "AZURE_SEARCH_API_KEY"
        secret_name = "search-api-key"
      }
    }
  }

  ingress {
    external_enabled = true
    target_port       = 3000
    transport          = "auto"

    traffic_weight {
      latest_revision = true
      percentage       = 100
    }
  }
}

output "app_url" {
  value = "https://${azurerm_container_app.main.ingress[0].fqdn}"
}

output "service_api_key" {
  value     = random_password.service_api_key.result
  sensitive = true
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}
