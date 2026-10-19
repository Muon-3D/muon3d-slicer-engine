import hashlib, json, os, re, shutil, statistics, subprocess, sys, tarfile, time
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent
NODE = str(ROOT / 'AppData/Local/OpenAI/Codex/runtimes/cua_node/a9ba6825a525118c/bin/node.exe')
RESULTS = []

def run(label, branch, args, extra=None, timeout=600):
    assert shutil.disk_usage(ROOT).free > 8 * 1024**3, 'C: below 8 GiB'
    cwd = ROOT / ('codex48-engine-' + branch)
    env = os.environ | {'ENGINE_DIR': str(cwd / 'dist'), 'ENGINE_TEST_OUT': str(OUT / ('test-out-' + branch))} | (extra or {})
    start = time.time()
    with (OUT / (label + '.log')).open('w', encoding='utf-8') as log:
        try:
            result = subprocess.run([NODE, *args], cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = 'timeout'
    raw = (OUT / (label + '.log')).read_text(encoding='utf-8', errors='replace')
    timings = [dict(target=t, p50=float(a), p95=float(b)) for t,a,b in re.findall(r'# (in-process|byte-stream|node-worker|built-host): settings.view p50 ([\d.]+) ms, p95 ([\d.]+) ms', raw)]
    counts = {k: int(v) for k,v in re.findall(r'(?:ℹ|#) (tests|pass|fail|cancelled|skipped) (\d+)', raw)}
    crashes = re.findall(r'.*(?:memory access out of bounds|engine crashed|worker sent an error|unhandled|Aborted\().*', raw, re.I)
    row = dict(label=label, branch=branch, exit=code, seconds=round(time.time()-start,2), timings=timings, counts=counts, crashes=crashes)
    RESULTS.append(row)
    (OUT / ('results-' + sys.argv[1] + '.json')).write_text(json.dumps(RESULTS, indent=2)+'\n')
    print(json.dumps(row), flush=True)
    return code

if sys.argv[1] == 'setup':
    for branch, pr in [('field',4), ('checks',5), ('main',4), ('main-control',4)]:
        cwd = ROOT / ('codex48-engine-' + branch)
        source = next(p for p in (ROOT / f'codex45-engine-evidence/validation-pr{pr}').iterdir() if p.is_dir())
        original = json.loads((ROOT / f'codex45-engine-evidence/ci-pr{pr}-manifest.json').read_text())
        dist = cwd / 'dist'
        dist.mkdir(exist_ok=True)
        for variant, info in original['variants'].items():
            for ext in ['mjs','wasm']:
                name = info[ext]
                assert hashlib.sha256((source/name).read_bytes()).hexdigest() == info['sha256'][ext]
                shutil.copyfile(source/name, dist/name)
        (dist/'manifest.json').write_text(json.dumps(original,indent=2)+'\n')
        assert run('build-'+branch,branch,['host/build.mjs']) == 0
elif sys.argv[1] == 'latency':
    for cycle in range(16):
        order = [('main','mt'),('field','mt'),('checks','mt'),('checks','st')]
        if cycle % 2: order.reverse()
        for branch, variant in order:
            run(f'latency-{cycle:02}-{branch}-{variant}',branch,['--test','--test-name-pattern=settings.view: the dynamic state within','test/conformance/conformance.test.ts'], {'ENGINE_VARIANT':variant})
elif sys.argv[1] == 'probe':
    assets = OUT/'main-runtime'
    archive = assets/'muon3d-slicer-engine-0.5.0.tgz'
    expected = next(line.split()[0] for line in (assets/'SHA256SUMS').read_text().splitlines() if line.endswith('  '+archive.name))
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for m in members:
            assert not Path(m.name).is_absolute() and '..' not in Path(m.name).parts and (m.isfile() or m.isdir())
        tar.extractall(assets/'extracted')
    source = next((assets/'extracted').glob('*/manifest.json')).parent
    manifest = json.loads((source/'manifest.json').read_text())
    assert manifest['source']['commit'] == 'ed35130d5aaa8f8226c48604cb5a0ccd3497023b'
    dist = ROOT/'codex48-engine-main/dist'
    for v, info in manifest['variants'].items():
        for ext in ['mjs','wasm']:
            name = info[ext]
            assert hashlib.sha256((source/name).read_bytes()).hexdigest() == info['sha256'][ext]
            shutil.copyfile(source/name,dist/name)
    shutil.copyfile(source/'manifest.json',dist/'manifest.json')
    assert run('build-main-release','main',['host/build.mjs']) == 0
    for branch in ['main','checks']:
        for loaded in [False,True]:
            label = f'profile-{branch}-'+('loaded' if loaded else 'idle')
            args = [str(OUT/'settings-mt-probe.mjs'),str(ROOT/('codex48-engine-'+branch)),str(OUT/label)]
            if loaded: args.append('--loaded')
            run(label,branch,args)
elif sys.argv[1] == 'repeat':
    for branch in ['field','main-control','main','checks']:
        run(f'mt-full-00-{branch}',branch,['engine/scripts/test-engine.mjs','mt','--test-concurrency=1'])
    for cycle in range(50):
        assert run(f'mt-first-{cycle:02}-field','field',[str(OUT/'first-slice-probe.mjs'),str(ROOT/'codex48-engine-field')]) == 0, 'Inspect captured first-slice failure before continuing'
        if cycle % 5 == 0:
            for branch in ['main-control','main']:
                assert run(f'mt-first-{cycle:02}-{branch}',branch,[str(OUT/'first-slice-probe.mjs'),str(ROOT/('codex48-engine-'+branch))]) == 0, 'Inspect captured control failure before continuing'
    for cycle in range(1,5):
        run(f'mt-full-{cycle:02}-field','field',['engine/scripts/test-engine.mjs','mt','--test-concurrency=1'])
