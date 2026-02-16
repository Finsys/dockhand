# Vault Integration Tutorial

This step-by-step tutorial guides you through setting up HashiCorp Vault integration with Dockhand. By the end, you will have a running stack that fetches secrets directly from Vault.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Setting Up HashiCorp Vault](#setting-up-hashicorp-vault)
   - [Option A: Docker (Development)](#option-a-docker-development)
   - [Option B: Existing Vault Server](#option-b-existing-vault-server)
3. [Configuring Vault](#configuring-vault)
   - [Enable KV Secrets Engine](#enable-kv-secrets-engine)
   - [Create Secrets](#create-secrets)
   - [Authentication Setup](#authentication-setup)
4. [Configuring Dockhand](#configuring-dockhand)
5. [Creating a Test Stack](#creating-a-test-stack)
6. [Deploying and Verifying](#deploying-and-verifying)
7. [Testing Sync Modes](#testing-sync-modes)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Dockhand running (Docker or local development)
- Docker and Docker Compose installed
- Git installed
- (Optional) Vault CLI for advanced configuration

### Installing Vault CLI (Optional)

The Vault CLI is optional but recommended for advanced configuration.

**Linux (Debian/Ubuntu):**
```bash
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install vault
```

**Arch/CachyOS:**
```bash
sudo pacman -S vault
```

**macOS:**
```bash
brew install vault
```

---

## Setting Up HashiCorp Vault

### Option A: Docker (Development)

Start a development Vault server with Docker:

```bash
docker run -d \
  --name vault-dev \
  --cap-add=IPC_LOCK \
  -p 8200:8200 \
  -e 'VAULT_DEV_ROOT_TOKEN_ID=myroot' \
  -e 'VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200' \
  hashicorp/vault:latest
```

Your Vault is now available at `http://localhost:8200` with the root token `myroot`.

**Verify it's running:**

```bash
# Using curl
curl http://localhost:8200/v1/sys/health

# Using Vault CLI
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='myroot'
vault status
```

### Option B: Existing Vault Server

If you have an existing Vault server, note the following:

- **Vault URL**: e.g., `https://vault.example.com:8200`
- **Root Token or AppRole credentials**
- **TLS**: If using self-signed certificates, you'll need to enable "Skip TLS Verify" in Dockhand

---

## Configuring Vault

### Enable KV Secrets Engine

The KV (Key-Value) secrets engine stores your secrets. Dockhand supports KV version 2.

#### Method 1: Vault CLI

```bash
# Set environment variables
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='myroot'

# Enable KV v2 at path "secret"
vault secrets enable -path=secret kv-v2

# Verify
vault secrets list
```

#### Method 2: curl/HTTP API

```bash
# Enable KV v2 secrets engine
curl --request POST \
  --header "X-Vault-Token: myroot" \
  --data '{"type": "kv-v2"}' \
  http://localhost:8200/v1/sys/mounts/secret

# Verify
curl --header "X-Vault-Token: myroot" \
  http://localhost:8200/v1/sys/mounts | jq '.data.secret'
```

#### Method 3: Vault UI

1. Open `http://localhost:8200` in your browser
2. Log in with token `myroot`
3. Click **Secrets Engines** in the sidebar
4. Click **Enable new engine**
5. Select **KV** and click **Next**
6. Set **Path** to `secret`
7. Select **Version 2**
8. Click **Enable Engine**

---

### Create Secrets

Now create the secrets that Dockhand will fetch.

#### Method 1: Vault CLI

```bash
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='myroot'

# Create secrets at path "secret/dockhand-test"
vault kv put secret/dockhand-test \
  DATABASE_PASSWORD="super-secret-db-password" \
  api_key="ak_1234567890abcdef" \
  admin_token="admin_xyz_token_123"

# Verify the secrets
vault kv get secret/dockhand-test

# Read a specific field
vault kv get -field=DATABASE_PASSWORD secret/dockhand-test
```

#### Method 2: curl/HTTP API

```bash
# Create secrets (note: KV v2 uses /data/ in the path)
curl --request POST \
  --header "X-Vault-Token: myroot" \
  --header "Content-Type: application/json" \
  --data '{
    "data": {
      "DATABASE_PASSWORD": "super-secret-db-password",
      "api_key": "ak_1234567890abcdef",
      "admin_token": "admin_xyz_token_123"
    }
  }' \
  http://localhost:8200/v1/secret/data/dockhand-test

# Verify - read all secrets
curl --header "X-Vault-Token: myroot" \
  http://localhost:8200/v1/secret/data/dockhand-test | jq '.data.data'

# Read a specific secret
curl --header "X-Vault-Token: myroot" \
  http://localhost:8200/v1/secret/data/dockhand-test | jq -r '.data.data.DATABASE_PASSWORD'
```

#### Method 3: Vault UI

1. Go to **Secrets Engines** > **secret**
2. Click **Create secret**
3. Set **Path for this secret**: `dockhand-test`
4. Add the following key-value pairs:
   | Key | Value |
   |-----|-------|
   | DATABASE_PASSWORD | super-secret-db-password |
   | api_key | ak_1234567890abcdef |
   | admin_token | admin_xyz_token_123 |
5. Click **Save**

---

### Authentication Setup

Dockhand supports three authentication methods. Choose the one that fits your needs.

#### Token Authentication (Simplest)

For development, use the root token directly. In production, create a specific token with limited permissions.

**Create a limited token (CLI):**

```bash
# Create a policy first
vault policy write dockhand-read - <<EOF
path "secret/data/*" {
  capabilities = ["read", "list"]
}
EOF

# Create a token with that policy
vault token create -policy=dockhand-read -ttl=720h
```

**Create a limited token (curl):**

```bash
# Create policy
curl --request PUT \
  --header "X-Vault-Token: myroot" \
  --data '{
    "policy": "path \"secret/data/*\" { capabilities = [\"read\", \"list\"] }"
  }' \
  http://localhost:8200/v1/sys/policies/acl/dockhand-read

# Create token
curl --request POST \
  --header "X-Vault-Token: myroot" \
  --data '{
    "policies": ["dockhand-read"],
    "ttl": "720h"
  }' \
  http://localhost:8200/v1/auth/token/create | jq -r '.auth.client_token'
```

#### AppRole Authentication (Recommended for Production)

AppRole provides machine-to-machine authentication with Role ID and Secret ID.

**Setup with CLI:**

```bash
# Enable AppRole auth method
vault auth enable approle

# Create a role for Dockhand
vault write auth/approle/role/dockhand \
  token_policies="dockhand-read" \
  token_ttl=1h \
  token_max_ttl=4h

# Get Role ID
vault read auth/approle/role/dockhand/role-id

# Generate Secret ID
vault write -f auth/approle/role/dockhand/secret-id
```

**Setup with curl:**

```bash
# Enable AppRole
curl --request POST \
  --header "X-Vault-Token: myroot" \
  --data '{"type": "approle"}' \
  http://localhost:8200/v1/sys/auth/approle

# Create role
curl --request POST \
  --header "X-Vault-Token: myroot" \
  --data '{
    "token_policies": ["dockhand-read"],
    "token_ttl": "1h",
    "token_max_ttl": "4h"
  }' \
  http://localhost:8200/v1/auth/approle/role/dockhand

# Get Role ID
curl --header "X-Vault-Token: myroot" \
  http://localhost:8200/v1/auth/approle/role/dockhand/role-id | jq -r '.data.role_id'

# Generate Secret ID
curl --request POST \
  --header "X-Vault-Token: myroot" \
  http://localhost:8200/v1/auth/approle/role/dockhand/secret-id | jq -r '.data.secret_id'
```

**Setup with UI:**

1. Go to **Access** > **Auth Methods**
2. Click **Enable new method**
3. Select **AppRole** and click **Enable Method**
4. Click **Create role**
5. Name: `dockhand`, Policies: `dockhand-read`
6. Save and copy the Role ID from the role details
7. Generate a Secret ID from the role page

---

## Configuring Dockhand

Now configure Dockhand to connect to your Vault.

### Method 1: Dockhand UI

1. Open Dockhand at `http://localhost:3000`
2. Go to **Settings** > **Vault** tab
3. Fill in the configuration:
   - **Vault URL**: `http://localhost:8200` (or your Vault address)
   - **Authentication Method**: Token or AppRole
   - **Token**: Your Vault token (if using Token auth)
   - **Role ID / Secret ID**: Your AppRole credentials (if using AppRole)
   - **Default Secret Path**: `secret/data/dockhand-test`
   - **Accept Self-Signed Certificates**: Enable if using HTTPS with self-signed certs
4. Click **Test Connection** to verify
5. Click **Save**

### Method 2: curl/HTTP API

```bash
# Save Vault configuration
curl --request PUT \
  --header "Content-Type: application/json" \
  --data '{
    "enabled": true,
    "url": "http://localhost:8200",
    "authMethod": "token",
    "token": "myroot",
    "defaultPath": "secret/data/dockhand-test",
    "skipTlsVerify": false
  }' \
  http://localhost:3000/api/vault/config

# For AppRole authentication:
curl --request PUT \
  --header "Content-Type: application/json" \
  --data '{
    "enabled": true,
    "url": "http://localhost:8200",
    "authMethod": "approle",
    "roleId": "YOUR_ROLE_ID",
    "secretId": "YOUR_SECRET_ID",
    "defaultPath": "secret/data/dockhand-test",
    "skipTlsVerify": false
  }' \
  http://localhost:3000/api/vault/config

# Verify configuration
curl http://localhost:3000/api/vault/config

# Test connection
curl --request POST \
  http://localhost:3000/api/vault/test
```

---

## Creating a Test Stack

### Option 1: Use the Example Repository

Clone the test repository:

```bash
git clone https://github.com/d0dg3r/dockhand-stack-test.git
```

Or use it directly in Dockhand by adding a Git stack with URL:
`https://github.com/d0dg3r/dockhand-stack-test.git`

### Option 2: Create Your Own Stack

Create a new directory with the following files. These files are also available at `docs/examples/vault-test/` in the Dockhand repository.

#### compose.yaml

```yaml
services:
  env-viewer:
    image: php:8-apache
    ports:
      - "8080:80"
    volumes:
      - ./index.php:/var/www/html/index.php:ro
    environment:
      # Default values (can be overridden by Vault secrets)
      - APP_NAME=${APP_NAME:-Dockhand Vault Test}
      - APP_ENV=${APP_ENV:-development}
      # These will be injected from Vault
      - DATABASE_PASSWORD=${DATABASE_PASSWORD:-not-set}
      - API_KEY=${API_KEY:-not-set}
      - ADMIN_TOKEN=${ADMIN_TOKEN:-not-set}
```

#### .secrets.yaml

```yaml
# Vault Secret Mappings for Dockhand
# This file defines which secrets to fetch from HashiCorp Vault

vault:
  # Default path for all secrets (can be overridden per-secret)
  path: secret/data/dockhand-test
  # Global setting: trigger redeploy when ANY secret changes (default: false)
  triggerRedeploy: false

secrets:
  # Simple mapping: environment variable name = Vault key name
  - DATABASE_PASSWORD

  # Explicit mapping with different Vault key
  - name: API_KEY
    key: api_key

  # Secret that triggers automatic redeploy when changed
  - name: ADMIN_TOKEN
    key: admin_token
    triggerRedeploy: true
```

#### .env

```bash
# Non-sensitive environment variables
# These are loaded directly by Docker Compose

APP_NAME=Dockhand Vault Test
APP_ENV=production
```

#### index.php

```php
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars(getenv('APP_NAME') ?: 'Vault Test') ?></title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 2rem;
            color: #e4e4e7;
        }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #22d3ee; }
        .subtitle { color: #a1a1aa; margin-bottom: 2rem; }
        .card {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
        }
        .card h2 {
            font-size: 1rem;
            color: #a78bfa;
            margin-bottom: 1rem;
            text-transform: uppercase;
        }
        .env-grid { display: grid; gap: 0.75rem; }
        .env-item {
            display: flex;
            justify-content: space-between;
            padding: 0.75rem 1rem;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 8px;
        }
        .env-name { font-family: monospace; color: #22d3ee; }
        .env-value { font-family: monospace; color: #4ade80; }
        .env-value.masked { color: #fbbf24; }
        .env-value.not-set { color: #f87171; }
        .badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
        }
        .badge.vault { background: #7c3aed; color: white; }
        .badge.env { background: #0891b2; color: white; }
    </style>
</head>
<body>
    <div class="container">
        <h1><?= htmlspecialchars(getenv('APP_NAME') ?: 'Vault Test') ?></h1>
        <p class="subtitle">Environment Variables Viewer</p>

        <div class="card">
            <h2><span class="badge vault">Vault</span> Secrets from HashiCorp Vault</h2>
            <div class="env-grid">
                <?php
                $vaultSecrets = ['DATABASE_PASSWORD', 'API_KEY', 'ADMIN_TOKEN'];
                foreach ($vaultSecrets as $name) {
                    $value = getenv($name);
                    $displayValue = $value ? str_repeat('*', min(strlen($value), 8)) . substr($value, -4) : 'NOT SET';
                    $class = $value ? 'masked' : 'not-set';
                    echo "<div class='env-item'>";
                    echo "<span class='env-name'>$name</span>";
                    echo "<span class='env-value $class'>$displayValue</span>";
                    echo "</div>";
                }
                ?>
            </div>
        </div>

        <div class="card">
            <h2><span class="badge env">ENV</span> Standard Environment Variables</h2>
            <div class="env-grid">
                <?php
                $envVars = ['APP_NAME', 'APP_ENV'];
                foreach ($envVars as $name) {
                    $value = getenv($name) ?: 'NOT SET';
                    $class = getenv($name) ? '' : 'not-set';
                    echo "<div class='env-item'>";
                    echo "<span class='env-name'>$name</span>";
                    echo "<span class='env-value $class'>" . htmlspecialchars($value) . "</span>";
                    echo "</div>";
                }
                ?>
            </div>
        </div>
    </div>
</body>
</html>
```

### Add Stack to Dockhand

#### Method 1: Dockhand UI

1. Open Dockhand at `http://localhost:3000`
2. Go to **Stacks** page
3. Click **Add Stack** > **Git Stack**
4. Fill in:
   - **Name**: `vault-test`
   - **Repository URL**: `https://github.com/d0dg3r/dockhand-stack-test.git` (or your own repo)
   - **Branch**: `main`
   - **Environment**: Select your environment
5. Click **Create**

#### Method 2: curl/HTTP API

```bash
# First, get the environment ID
curl http://localhost:3000/api/environments

# Create Git stack (replace ENVIRONMENT_ID with actual ID, e.g., 1)
curl --request POST \
  --header "Content-Type: application/json" \
  --data '{
    "url": "https://github.com/d0dg3r/dockhand-stack-test.git",
    "branch": "main",
    "name": "vault-test",
    "environmentId": 1
  }' \
  http://localhost:3000/api/git/stacks
```

---

## Deploying and Verifying

### Deploy the Stack

#### Method 1: Dockhand UI

1. Find your stack in the Stacks list
2. Click the **Sync All** button (green refresh icon) to sync Git and Vault
3. Click the **Deploy** button (play icon)
4. Wait for deployment to complete

#### Method 2: curl/HTTP API

```bash
# Get the Git stack ID first
curl http://localhost:3000/api/git/stacks

# Sync Git and Vault (replace ID with your stack ID)
curl --request POST \
  http://localhost:3000/api/git/stacks/1/sync?mode=all

# Deploy the stack
curl --request POST \
  http://localhost:3000/api/stacks/vault-test/deploy
```

### Verify Secrets

1. Open `http://localhost:8080` in your browser
2. You should see the test page showing:
   - **Vault Secrets**: DATABASE_PASSWORD, API_KEY, ADMIN_TOKEN (masked)
   - **ENV Variables**: APP_NAME, APP_ENV

If secrets show as "NOT SET", check:
- Vault connection in Settings > Vault
- Secrets path matches `.secrets.yaml`
- Stack has been synced after Vault configuration

### View Secrets in Dockhand UI

1. Go to **Stacks** in Dockhand
2. Click on your stack name
3. Go to the **Environment Variables** tab
4. You should see the Vault secrets listed (values are encrypted)

---

## Testing Sync Modes

Dockhand provides three sync modes for granular control:

| Button | Mode | Description |
|--------|------|-------------|
| Git (purple) | `git` | Only sync from Git repository |
| Vault (cyan) | `vault` | Only sync secrets from Vault |
| All (green) | `all` | Sync both Git and Vault |

### Test Vault-Only Sync

1. Change a secret in Vault:

   **CLI:**
   ```bash
   vault kv put secret/dockhand-test \
     DATABASE_PASSWORD="new-password-123" \
     api_key="ak_1234567890abcdef" \
     admin_token="admin_xyz_token_123"
   ```

   **curl:**
   ```bash
   curl --request POST \
     --header "X-Vault-Token: myroot" \
     --header "Content-Type: application/json" \
     --data '{
       "data": {
         "DATABASE_PASSWORD": "new-password-123",
         "api_key": "ak_1234567890abcdef",
         "admin_token": "admin_xyz_token_123"
       }
     }' \
     http://localhost:8200/v1/secret/data/dockhand-test
   ```

2. Click the **Vault** sync button (cyan key icon) in Dockhand
3. Verify the new secret is stored

### Test Automatic Redeploy

The `ADMIN_TOKEN` secret has `triggerRedeploy: true` in `.secrets.yaml`.

1. Change ADMIN_TOKEN in Vault:

   **CLI:**
   ```bash
   vault kv put secret/dockhand-test \
     DATABASE_PASSWORD="new-password-123" \
     api_key="ak_1234567890abcdef" \
     admin_token="changed_admin_token"
   ```

   **curl:**
   ```bash
   curl --request POST \
     --header "X-Vault-Token: myroot" \
     --header "Content-Type: application/json" \
     --data '{
       "data": {
         "DATABASE_PASSWORD": "new-password-123",
         "api_key": "ak_1234567890abcdef",
         "admin_token": "changed_admin_token"
       }
     }' \
     http://localhost:8200/v1/secret/data/dockhand-test
   ```

2. Click **Sync All** (green button)
3. The stack should automatically redeploy because `ADMIN_TOKEN` changed and has `triggerRedeploy: true`
4. Refresh `http://localhost:8080` to see the new value

---

## Troubleshooting

### Connection Errors

**Error: "ECONNREFUSED"**
- Check Vault is running: `curl http://localhost:8200/v1/sys/health`
- Verify the URL in Dockhand settings

**Error: "self signed certificate"**
- Enable "Accept Self-Signed Certificates" in Vault settings

**Error: "permission denied" (403)**
- Check your token has read permissions
- Verify the policy includes the secret path

### Secrets Not Appearing

1. Check Vault connection: Settings > Vault > Test Connection
2. Verify the path in `.secrets.yaml` matches Vault
3. Sync the stack after configuration changes
4. Check the secret exists: `vault kv get secret/dockhand-test`

### Debug Commands

```bash
# Check Vault status
vault status

# List all secrets at path
vault kv list secret/

# Read specific secret
vault kv get secret/dockhand-test

# Check Dockhand logs (if running in Docker)
docker logs dockhand

# Test Vault connection from Dockhand API
curl --request POST http://localhost:3000/api/vault/test
```

### Common Issues

| Issue | Solution |
|-------|----------|
| Secrets show "NOT SET" | Sync the stack (Vault button) after Vault setup |
| Old values after change | Click redeploy or use `triggerRedeploy: true` |
| 403 from Vault | Check token permissions and policy |
| Container port conflict | Stop other containers on port 8080 |

---

## Quick Reference

### Vault CLI Commands

```bash
# Set environment
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='myroot'

# Manage secrets
vault kv put secret/path key=value      # Create/Update
vault kv get secret/path                # Read
vault kv delete secret/path             # Delete
vault kv list secret/                   # List

# Manage engines
vault secrets enable -path=name kv-v2   # Enable
vault secrets disable name/             # Disable
vault secrets list                      # List
```

### Dockhand API Endpoints

```bash
# Vault configuration
GET    /api/vault/config         # Get config
PUT    /api/vault/config         # Save config
POST   /api/vault/test           # Test connection

# Stack sync
POST   /api/git/stacks/{id}/sync?mode=git    # Git only
POST   /api/git/stacks/{id}/sync?mode=vault  # Vault only
POST   /api/git/stacks/{id}/sync?mode=all    # Both

# Stack management
GET    /api/stacks               # List stacks
POST   /api/stacks/{name}/deploy # Deploy stack
GET    /api/stacks/{name}/env    # Get environment variables
```

### .secrets.yaml Reference

```yaml
vault:
  path: secret/data/myapp    # Default path
  triggerRedeploy: false     # Global redeploy setting

secrets:
  - SECRET_NAME              # Simple: name = key

  - name: ENV_VAR_NAME       # Explicit mapping
    key: vault_key_name

  - name: OTHER_SECRET       # Custom path + redeploy
    path: secret/data/other
    key: secret_key
    triggerRedeploy: true
```

---

## Next Steps

- Read the [Vault Integration Architecture](./VAULT_INTEGRATION.md) for deep technical details
- Set up AppRole authentication for production use
- Configure automatic secret rotation with Vault policies
- Explore Vault's dynamic secrets for database credentials
