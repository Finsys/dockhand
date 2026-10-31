type PendingTerminalAction = 'kill' | 'stop' | 'oom';

export interface ContainerNotificationTrackerOptions {
delayMs?: number;
}

export interface ContainerNotificationTracker {
shouldNotify(environmentId: number, containerId: string, action: string): boolean;

dispatch(
environmentId: number,
containerId: string,
action: string,
notify: () => void
): void;
}

export function createContainerNotificationTracker(
options: ContainerNotificationTrackerOptions = {}
): ContainerNotificationTracker {
const delayMs = options.delayMs ?? 1000;

const pendingTerminal = new Map<string, PendingTerminalAction>();

const pendingStop = new Map<string, ReturnType<typeof setTimeout>>();
const pendingStart = new Map<string, ReturnType<typeof setTimeout>>();

const keyFor = (environmentId: number, containerId: string) =>
`${environmentId}:${containerId}`;

function cancelTimer(
map: Map<string, ReturnType<typeof setTimeout>>,
key: string
): void {
const timer = map.get(key);
if (timer) {
clearTimeout(timer);
map.delete(key);
}
}

function schedule(
map: Map<string, ReturnType<typeof setTimeout>>,
key: string,
notify: () => void
): void {
cancelTimer(map, key);

const timer = setTimeout(() => {
map.delete(key);
notify();
}, delayMs);

map.set(key, timer);
}

function shouldNotify(
environmentId: number,
containerId: string,
action: string
): boolean {
const key = keyFor(environmentId, containerId);

switch (action) {
case 'kill':
pendingTerminal.set(key, 'kill');
return false;

case 'stop':
pendingTerminal.set(key, 'stop');
return true;

case 'oom':
pendingTerminal.set(key, 'oom');
return true;

case 'die': {
const previous = pendingTerminal.get(key);
pendingTerminal.delete(key);

if (previous === 'stop' || previous === 'oom') {
return false;
}

return true;
}

case 'start':
pendingTerminal.delete(key);
return true;

case 'restart':
pendingTerminal.delete(key);
return true;

case 'destroy':
pendingTerminal.delete(key);
return true;

default:
return true;
}
}

function dispatch(
environmentId: number,
containerId: string,
action: string,
notify: () => void
): void {
const key = keyFor(environmentId, containerId);

switch (action) {
case 'kill':
pendingTerminal.set(key, 'kill');
return;

case 'stop':
pendingTerminal.set(key, 'stop');
schedule(pendingStop, key, notify);
return;

case 'oom':
pendingTerminal.set(key, 'oom');
notify();
return;

case 'die': {
const previous = pendingTerminal.get(key);
pendingTerminal.delete(key);

if (previous === 'stop' || previous === 'oom') {
return;
}

notify();
return;
}

case 'start':
pendingTerminal.delete(key);
schedule(pendingStart, key, notify);
return;

case 'restart':
pendingTerminal.delete(key);

// Docker emits:
// kill -> stop -> die -> start -> restart
// The restart event arrives last, so discard the delayed
// stop/start notifications and emit only restart.
cancelTimer(pendingStop, key);
cancelTimer(pendingStart, key);

notify();
return;

case 'destroy':
pendingTerminal.delete(key);
cancelTimer(pendingStop, key);
cancelTimer(pendingStart, key);
notify();
return;

default:
notify();
}
}

return {
shouldNotify,
dispatch
};
}
