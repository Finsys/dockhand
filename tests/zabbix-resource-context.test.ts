import { describe, expect, spyOn, test } from 'bun:test';
import * as shared from '../src/lib/server/notifications/shared';
import { sendZabbix } from '../src/lib/server/notifications/zabbix';

describe('Zabbix resource context', () => {
test('includes compose container context in history.push value', async () => {
let requestBody: any;

const fetchSpy = spyOn(shared, 'notificationFetch').mockImplementation(
async (_url: string | URL, init?: RequestInit) => {
requestBody = JSON.parse(String(init?.body));

return new Response(
JSON.stringify({
jsonrpc: '2.0',
result: {
response: 'success',
data: [{ itemid: '12345' }]
},
id: 1
}),
{
status: 200,
headers: { 'Content-Type': 'application/json' }
}
);
}
);

try {
const result = await sendZabbix(
'zabbix://127.0.0.1/api_jsonrpc.php?token=test-token&host=Dockhand&key=dockhand.event',
{
eventType: 'container_unhealthy',
title: 'Container unhealthy',
message: 'Container uptime-kuma is unhealthy',
type: 'error',
environmentId: 1,
environmentName: 'dockhand',
stack: 'cit',
container: 'uptime-kuma',
containerId: '2c13d7ebddd11331b069dfe6f2b941946210edadf668952760b3ed5bff77e52f'
} as any
);

expect(result.success).toBe(true);

const event = JSON.parse(requestBody.params[0].value);

expect(event.event_type).toBe('container_unhealthy');
expect(event.environment_id).toBe(1);
expect(event.environment).toBe('dockhand');
expect(event.stack).toBe('cit');
expect(event.container).toBe('uptime-kuma');
expect(event.container_id).toBe(
'2c13d7ebddd11331b069dfe6f2b941946210edadf668952760b3ed5bff77e52f'
);
} finally {
fetchSpy.mockRestore();
}
});

test('represents a standalone container without inventing a stack name', async () => {
let requestBody: any;

const fetchSpy = spyOn(shared, 'notificationFetch').mockImplementation(
async (_url: string | URL, init?: RequestInit) => {
requestBody = JSON.parse(String(init?.body));

return new Response(
JSON.stringify({
jsonrpc: '2.0',
result: {
response: 'success',
data: [{ itemid: '12345' }]
},
id: 1
}),
{
status: 200,
headers: { 'Content-Type': 'application/json' }
}
);
}
);

try {
const result = await sendZabbix(
'zabbix://127.0.0.1/api_jsonrpc.php?token=test-token&host=Dockhand&key=dockhand.event',
{
eventType: 'container_started',
title: 'Container started',
message: 'Container dockhand-zabbix-test started',
type: 'info',
environmentId: 1,
environmentName: 'dockhand',
stack: null,
container: 'dockhand-zabbix-test',
containerId:
'5109def483b4deeb414bb0e1e00b7a05cab4541cef3c17b80b381f5e70a922da'
} as any
);

expect(result.success).toBe(true);

const event = JSON.parse(requestBody.params[0].value);

expect(event.environment_id).toBe(1);
expect(event.environment).toBe('dockhand');
expect(event.stack).toBeNull();
expect(event.container).toBe('dockhand-zabbix-test');
} finally {
fetchSpy.mockRestore();
}
});

test('extracts Dockhand container and stack names from Docker event attributes', () => {
const context = shared.containerNotificationContext(
'2c13d7ebddd11331b069dfe6f2b941946210edadf668952760b3ed5bff77e52f',
'uptime-kuma',
{
'com.docker.compose.project': 'cit',
'com.docker.compose.service': 'uptime-kuma'
}
);

expect(context).toEqual({
stack: 'cit',
container: 'uptime-kuma',
containerId:
'2c13d7ebddd11331b069dfe6f2b941946210edadf668952760b3ed5bff77e52f'
});
});

test('does not invent a stack name for standalone containers', () => {
const context = shared.containerNotificationContext(
'5109def483b4deeb414bb0e1e00b7a05cab4541cef3c17b80b381f5e70a922da',
'dockhand-zabbix-test',
{}
);

expect(context).toEqual({
stack: null,
container: 'dockhand-zabbix-test',
containerId:
'5109def483b4deeb414bb0e1e00b7a05cab4541cef3c17b80b381f5e70a922da'
});
});

test('falls back to the short Docker ID when the container name is missing', () => {
const context = shared.containerNotificationContext(
'abcdef1234567890abcdef1234567890',
undefined,
{}
);

expect(context).toEqual({
stack: null,
container: 'abcdef123456',
containerId: 'abcdef1234567890abcdef1234567890'
});
});

});
