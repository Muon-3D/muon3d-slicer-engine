# Interleaved A/B (or more) campaign of mt-stress.mjs, fresh process per run, one at a time.
#   python ab.py <label> <rounds> <config.json>
# config.json: [{"name": ..., "root": ..., "engine": ..., "node": [...], "harness": [...]}, ...]
import json, os, shutil, subprocess, sys, time
from pathlib import Path

NODE = r'C:\Users\jack\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe'
OUT = Path(__file__).resolve().parent
label, rounds, configs = sys.argv[1], int(sys.argv[2]), json.loads(Path(sys.argv[3]).read_text())
logs = OUT / 'logs' / label
logs.mkdir(parents=True, exist_ok=True)
results = OUT / f'ab-{label}.jsonl'
crashes = {c['name']: 0 for c in configs}
runs = {c['name']: 0 for c in configs}
for i in range(rounds):
    order = configs if i % 2 == 0 else list(reversed(configs))
    for c in order:
        assert shutil.disk_usage('C:/').free > 8 * 1024**3, 'C: below 8 GiB'
        start = time.time()
        try:
            p = subprocess.run([NODE, *c.get('node', []), str(OUT / 'mt-stress.mjs'), c['root'], c['engine'], *c.get('harness', [])],
                               capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300)
            code, text = p.returncode, p.stdout + p.stderr
        except subprocess.TimeoutExpired as e:
            code, text = 'timeout', (e.stdout or b'').decode('utf-8', 'replace') + (e.stderr or b'').decode('utf-8', 'replace')
        runs[c['name']] += 1
        crashed = code != 0
        if crashed:
            crashes[c['name']] += 1
            (logs / f'{i:03}-{c["name"]}.log').write_text(text, encoding='utf-8')
        row = dict(label=label, round=i, config=c['name'], exit=code, seconds=round(time.time() - start, 2), crashed=crashed,
                   detail=[l[:300] for l in text.splitlines() if l.startswith(('MT_', 'worker sent', 'Aborted'))][:6],
                   summary=next((l for l in text.splitlines() if l.startswith('{"ok"')), None))
        with results.open('a', encoding='utf-8') as f:
            f.write(json.dumps(row) + '\n')
        print(f'{label} r{i} {c["name"]} exit={code} {row["seconds"]}s crashes={crashes}', flush=True)
print(f'DONE {label}: ' + ', '.join(f'{k} {crashes[k]}/{runs[k]}' for k in crashes), flush=True)
