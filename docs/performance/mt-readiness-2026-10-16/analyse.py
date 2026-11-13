import hashlib, json, re, statistics
from pathlib import Path

out = Path(__file__).resolve().parent
rows = json.loads((out/'results-latency.json').read_text())
summary = []
for branch, variant in [('main','mt'),('field','mt'),('checks','mt'),('checks','st')]:
    runs = [r for r in rows if r['branch']==branch and r['label'].endswith('-'+variant)]
    for target in ['in-process','byte-stream','node-worker','built-host']:
        times = [next(m for m in r['timings'] if m['target']==target) for r in runs]
        vals = [m['p95'] for m in times]
        q1, _, q3 = statistics.quantiles(vals,n=4)
        summary.append(dict(branch=branch,variant=variant,target=target,runs=len(runs),median_p50=statistics.median(m['p50'] for m in times),median_p95=statistics.median(vals),q1=q1,q3=q3,min=min(vals),max=max(vals),failures=sum(v>=5 for v in vals)))
(out/'latency-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
for r in summary:
    if r['target'] in ['node-worker','built-host']: print(r)
hashes = {}
for branch in ['checks','field','main','main-control']:
    source = (out.parent/('codex48-engine-'+branch)/'test/conformance/conformance.test.ts').read_text()
    gate = source[source.index('    test(`settings.view: the dynamic state within'):source.index("    describe('engine',")]
    hashes[branch] = hashlib.sha256(gate.encode()).hexdigest()
assert len(set(hashes.values())) == 1, hashes
(out/'gate-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
print('Unchanged gate:', hashes)
