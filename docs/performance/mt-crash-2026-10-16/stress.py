# Repeats mt-stress.mjs in fresh processes, one at a time, and records every run.
#   python stress.py <label> <runs> <repo root> <engine dir> [node flags...] [-- harness flags...]
import json, shutil, subprocess, sys, time
from pathlib import Path

NODE = r'C:\Users\jack\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe'
OUT = Path(__file__).resolve().parent
label, runs, root, engine = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
rest = sys.argv[5:]
node_flags = rest[: rest.index('--')] if '--' in rest else rest
harness_flags = rest[rest.index('--') + 1 :] if '--' in rest else []
logs = OUT / 'logs' / label
logs.mkdir(parents=True, exist_ok=True)
results = OUT / f'stress-{label}.jsonl'
crashes = 0
for i in range(runs):
    assert shutil.disk_usage('C:/').free > 8 * 1024**3, 'C: below 8 GiB'
    start = time.time()
    p = subprocess.run([NODE, *node_flags, str(OUT / 'mt-stress.mjs'), root, engine, *harness_flags], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300)
    text = p.stdout + p.stderr
    crashed = p.returncode != 0
    if crashed:
        crashes += 1
        (logs / f'{i:03}.log').write_text(text, encoding='utf-8')
    row = dict(label=label, run=i, exit=p.returncode, seconds=round(time.time() - start, 2), crashed=crashed,
               detail=[l for l in text.splitlines() if l.startswith(('MT_', 'worker sent'))][:6])
    with results.open('a', encoding='utf-8') as f:
        f.write(json.dumps(row) + '\n')
    print(f'{label} {i} exit={p.returncode} {row["seconds"]}s crashes={crashes}', flush=True)
print(f'DONE {label}: {crashes}/{runs} crashed', flush=True)
