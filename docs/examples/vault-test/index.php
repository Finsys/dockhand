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
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        h1 {
            font-size: 2rem;
            margin-bottom: 0.5rem;
            color: #22d3ee;
        }
        .subtitle {
            color: #a1a1aa;
            margin-bottom: 2rem;
        }
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
            letter-spacing: 0.05em;
        }
        .env-grid {
            display: grid;
            gap: 0.75rem;
        }
        .env-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem 1rem;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 8px;
        }
        .env-name {
            font-family: 'Monaco', 'Consolas', monospace;
            color: #22d3ee;
            font-size: 0.9rem;
        }
        .env-value {
            font-family: 'Monaco', 'Consolas', monospace;
            color: #4ade80;
            font-size: 0.9rem;
            max-width: 50%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .env-value.masked {
            color: #fbbf24;
        }
        .env-value.not-set {
            color: #f87171;
        }
        .badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
        }
        .badge.vault { background: #7c3aed; color: white; }
        .badge.env { background: #0891b2; color: white; }
        .footer {
            text-align: center;
            margin-top: 2rem;
            color: #71717a;
            font-size: 0.875rem;
        }
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
                $vaultSecrets = [
                    'DATABASE_PASSWORD',
                    'API_KEY',
                    'ADMIN_TOKEN'
                ];
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
                $envVars = [
                    'APP_NAME',
                    'APP_ENV'
                ];
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

        <div class="footer">
            <p>Powered by Dockhand | <?= date('Y-m-d H:i:s') ?></p>
        </div>
    </div>
</body>
</html>
