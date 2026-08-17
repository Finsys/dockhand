import { describe, expect, spyOn, test } from 'bun:test';
import * as shared from '../src/lib/server/notifications/shared';
import { sendZabbix } from '../src/lib/server/notifications/zabbix';

const successResponse = () =>
new Response(
JSON.stringify({
jsonrpc: '2.0',
result: {
response: 'success',
data: [{ itemid: '12345' }]
},
id: 1
}),
{ status: 200 }
);

describe('Zabbix notifications', () => {
test('sends history.push with correct payload', async () => {
const fetchSpy = spyOn(shared, 'notificationFetch')
.mockResolvedValue(successResponse());

const result = await sendZabbix(
'zabbixs://zabbix.example.com?token=secret-token&host=Dockhand&key=dockhand.event',
{
title: 'Container unhealthy',
message: 'Container test is unhealthy',
type: 'error',
environmentName: 'Docker Test',
eventType: 'container_unhealthy'
}
);

expect(result.success).toBe(true);
expect(fetchSpy).toHaveBeenCalledTimes(1);

const [url, options] = fetchSpy.mock.calls[0];

expect(url.toString()).toBe(
'https://zabbix.example.com/api_jsonrpc.php'
);

const headers = options?.headers as Record<string, string>;

expect(headers.Authorization).toBe('Bearer secret-token');
expect(headers['Content-Type']).toBe('application/json-rpc');

const body = JSON.parse(options?.body as string);

expect(body.method).toBe('history.push');
expect(body.params[0].host).toBe('Dockhand');
expect(body.params[0].key).toBe('dockhand.event');

const event = JSON.parse(body.params[0].value);

expect(event.event_type).toBe('container_unhealthy');
expect(event.title).toBe('Container unhealthy');
expect(event.environment).toBe('Docker Test');
expect(event.type).toBe('error');

fetchSpy.mockRestore();
});

test('converts zabbix scheme to HTTP', async () => {
const fetchSpy = spyOn(shared, 'notificationFetch')
.mockResolvedValue(successResponse());

const result = await sendZabbix(
'zabbix://10.112.8.22/zabbix/api_jsonrpc.php?token=test&host=Dockhand&key=dockhand.event',
{
title: 'Test',
message: 'Test',
type: 'info',
eventType: 'test'
}
);

expect(result.success).toBe(true);

const [url] = fetchSpy.mock.calls[0];

expect(url.toString()).toBe(
'http://10.112.8.22/zabbix/api_jsonrpc.php'
);

fetchSpy.mockRestore();
});

test('returns error for Zabbix API error', async () => {
const fetchSpy = spyOn(shared, 'notificationFetch')
.mockResolvedValue(
new Response(
JSON.stringify({
jsonrpc: '2.0',
error: {
code: -32602,
message: 'Invalid params.',
data: 'Invalid host.'
},
id: 1
}),
{ status: 200 }
)
);

const result = await sendZabbix(
'zabbixs://zabbix.example.com?token=test&host=Dockhand&key=dockhand.event',
{
title: 'Test',
message: 'Test'
}
);

expect(result.success).toBe(false);
expect(result.error).toContain('Zabbix API error');

fetchSpy.mockRestore();
});

test('returns error when history.push rejects item', async () => {
const fetchSpy = spyOn(shared, 'notificationFetch')
.mockResolvedValue(
new Response(
JSON.stringify({
jsonrpc: '2.0',
result: {
response: 'success',
data: [
{
itemid: '12345',
error: 'No permissions to referred object.'
}
]
},
id: 1
}),
{ status: 200 }
)
);

const result = await sendZabbix(
'zabbixs://zabbix.example.com?token=test&host=Dockhand&key=dockhand.event',
{
title: 'Test',
message: 'Test'
}
);

expect(result.success).toBe(false);
expect(result.error).toContain('history.push error');

fetchSpy.mockRestore();
});

test('does not send request without API token', async () => {
const fetchSpy = spyOn(shared, 'notificationFetch');

const result = await sendZabbix(
'zabbixs://zabbix.example.com?host=Dockhand&key=dockhand.event',
{
title: 'Test',
message: 'Test'
}
);

expect(result.success).toBe(false);
expect(result.error).toContain('token');
expect(fetchSpy).not.toHaveBeenCalled();

fetchSpy.mockRestore();
});
});
