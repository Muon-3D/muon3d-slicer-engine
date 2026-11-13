# Interleaved runs of gate-after-slice.mjs: the settings gate procedure right after an engine slice in the
# same process (st, mt) or with no engine (none). One process at a time.
#   python gate.py <label> <rounds> <repo root> [variants...] [--settle=ms]
import json, shutil, subprocess, sys
from pathlib import Path

NODE = r'C:\Users\jack\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe'
OUT = Path(__file__).resolve().parent
label, rounds, root = sys.argv[1], int(sys.argv[2]), sys.argv[3]
extra = [a for a in sys.argv[4:] if a.startswith('--')]
variants = [a for a in sys.argv[4:] if not a.startswith('--')] or ['none', 'st', 'mt']
out = OUT / f'gate-{label}.jsonl'
for i in range(rounds):
    for v in (variants if i % 2 == 0 else list(reversed(variants))):
        assert shutil.disk_usage('C:/').free > 8 * 1024**3, 'C: below 8 GiB'
        p = subprocess.run([NODE, str(OUT / 'gate-after-slice.mjs'), root, v, *extra], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=600,
                           env={**__import__('os').environ, 'ENGINE_DIR': str(Path(root).resolve() / 'dist')})
        line = next((l for l in p.stdout.splitlines() if l.startswith('{')), None)
        row = json.loads(line) if line else {'variant': v, 'error': (p.stdout + p.stderr)[-500:]}
        row.update(round=i, label=label, exit=p.returncode)
        with out.open('a', encoding='utf-8') as f:
            f.write(json.dumps(row) + '\n')
        print(json.dumps(row), flush=True)
