# Dockhand monitoring with Zabbix

This directory contains the **Dockhand by HTTP** monitoring template for Zabbix 7.4.

The template combines two data sources:

- the Dockhand API for environment and container discovery, state polling, and metadata;
- Zabbix Agent 2 with the Docker plugin for monitoring the local Docker Engine and the Dockhand application container.

It can also receive Dockhand notification events through the Zabbix `history.push` API. Event data is correlated with the environments and containers discovered through the Dockhand API.

## Requirements

- Zabbix server 7.4 or later;
- Zabbix Agent 2 installed on the host running Dockhand;
- the Zabbix Agent 2 Docker plugin;
- access from the Zabbix server or proxy to the Dockhand HTTP API;
- permission for the Zabbix agent user to access the Docker socket;
- a Dockhand API token when authentication is enabled.

The template was exported from Zabbix 7.4. Import into an older Zabbix version is not supported.

## Installation

1. In the Zabbix frontend, open **Data collection → Templates**.
2. Select **Import**.
3. Import [`zbx_dockhand_by_http.json`](zbx_dockhand_by_http.json).
4. Create a host for the machine running Dockhand, or use its existing host.
5. Add an Agent interface that points to the Zabbix Agent 2 instance on that machine.
6. Link the **Dockhand by HTTP** template to the host.
7. Configure the template macros described below.

## Template macros

| Macro | Default | Description |
| --- | --- | --- |
| `{$DOCKHAND.URL}` | `http://<dockhand-host>:3000` | Base URL of the Dockhand instance. Do not include a trailing slash. |
| `{$DOCKHAND.API.TOKEN}` | empty | Dockhand bearer API token. Leave empty if Dockhand authentication is disabled. Store it as **Secret text** on the monitored host. |
| `{$DOCKHAND.LOCAL.CONTAINER.NAME}` | `dockhand` | Name of the local Dockhand application container monitored through the Docker plugin. |
| `{$DOCKHAND.LLD.INTERVAL}` | `5m` | Environment and container low-level discovery interval. |
| `{$DOCKHAND.POLL.INTERVAL}` | `1m` | Current container state and metadata polling interval. |
| `{$DOCKHAND.RESTART.COUNT}` | `3` | Number of restarts required to report a restart loop. |
| `{$DOCKHAND.RESTART.WINDOW}` | `10m` | Time window used to count container restarts. |

Set `{$DOCKHAND.API.TOKEN}` on the host rather than changing it in the template. This keeps the exported template reusable and avoids storing a credential in the repository.

## Zabbix Agent 2 Docker access

The agent user must be able to read the Docker socket. On a typical Linux host using the default socket:

```bash
sudo usermod -aG docker zabbix
sudo systemctl restart zabbix-agent2
```

Verify access using the same account under which Zabbix Agent 2 runs:

```bash
sudo -u zabbix docker info
```

Group membership in `docker` grants privileged access to the Docker daemon. Apply the permission only on the Dockhand host and follow the security policy of your environment.

## Event delivery

The template contains a Zabbix trapper item with this key:

```text
dockhand.event
```

Dockhand events should be sent to that item through the Zabbix `history.push` API. The target host must be the host to which this template is linked.

For event correlation, the JSON payload should retain the context supplied by Dockhand, in particular:

- `environment_id` for environment and container events;
- `environment` as the environment-name fallback;
- `container` for container events;
- the original event type and lifecycle data.

The dependent discovery items filter the shared event stream by environment ID and container name. Start, restart, and healthy lifecycle events can therefore close the corresponding stopped, restart-loop, or unhealthy problems without waiting for the next polling cycle.

The `dockhand.event` item accepts values only from hosts allowed by its **Allowed hosts** setting. Restrict this setting to the Dockhand source address or the relevant proxy/server address before enabling event delivery.

## Container discovery opt-out

All containers returned by the Dockhand API are discovered by default. To exclude a container from this template, add the following Docker label:

```yaml
labels:
  dockhand.notify: "false"
```

The container will be omitted on the next low-level discovery run. Lost discovery resources are retained according to the template's discovery lifetime settings.

## Monitored data

### Dockhand API

- Dockhand environments and their online/offline state;
- containers in every environment;
- container ID, name, image, stack, and Compose service;
- state, health, status, exit code, and restart count;
- lifecycle and notification events received through `history.push`.

### Local Zabbix Agent 2

- Docker Engine availability and server version;
- storage driver and image count;
- total, running, and stopped container counts;
- Dockhand application container presence and running state;
- health, exit code, OOM state, restart count, PID count, and errors;
- CPU, memory, and network usage of the Dockhand application container.

## Included alerts

The template reports problems for:

- local Docker Engine unavailable;
- local Dockhand application container missing or stopped;
- local Dockhand container OOM-killed or reporting an error;
- local or discovered container restart loop;
- discovered container stopped, exited, unhealthy, or out of memory;
- Dockhand environment offline.

## Verification

After linking the template:

1. Open **Monitoring → Latest data** for the Dockhand host.
2. Check that **Local Docker engine: Ping** has a value.
3. Check that **Dockhand application container: Present** and **Running** are `Yes`.
4. Wait for `{$DOCKHAND.LLD.INTERVAL}` and confirm that environment and container items appear.
5. If event delivery is configured, trigger a harmless container stop/start cycle and confirm that **Dockhand raw event** receives data and the related problem recovers.

If local Docker items are unsupported, verify the Agent 2 Docker plugin and Docker socket permissions. If discovery fails, verify `{$DOCKHAND.URL}`, the API token, network reachability, and the error shown for the discovery item.

## Compatibility

| Component | Supported version |
| --- | --- |
| Zabbix template format | 7.4 |
| Dockhand API | Current Dockhand API endpoints used by this repository |
| Zabbix agent | Zabbix Agent 2 with Docker plugin |


