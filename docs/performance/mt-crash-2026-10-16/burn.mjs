// CPU contention for the crash campaign: N threads spinning until killed (no memory to speak of).
import { Worker, isMainThread } from 'node:worker_threads';
if (isMainThread) for (let i = 0; i < Number(process.argv[2] ?? 12); i++) new Worker(new URL(import.meta.url));
else for (;;) { let x = 0; for (let i = 0; i < 1e7; i++) x += i; }
