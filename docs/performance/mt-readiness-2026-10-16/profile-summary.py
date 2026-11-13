import json
from pathlib import Path

out=Path(__file__).resolve().parent
rows=[]
for branch in ['main','checks']:
    for state in ['idle','loaded']:
        name=f'profile-{branch}-{state}'
        cpu=json.loads((out/(name+'.cpuprofile')).read_text())
        heap=json.loads((out/(name+'.heapprofile')).read_text())
        def total(node):
            return node.get('selfSize',0)+sum(total(c) for c in node.get('children',[]))
        boundary=json.loads((out/(name+'.log')).read_text())
        top=sorted([n for n in cpu['nodes'] if '/settings/' in n['callFrame']['url']],key=lambda n:n.get('hitCount',0),reverse=True)[:10]
        rows.append(dict(name=name,boundary=boundary,cpu_samples=len(cpu['samples']),sampled_allocation_bytes=total(heap['head']),settings_top=[dict(name=n['callFrame']['functionName'],file=n['callFrame']['url'].split('/')[-1],samples=n.get('hitCount',0)) for n in top]))
(out/'profile-summary.json').write_text(json.dumps(rows,indent=2)+'\n')
for row in rows:
    print(row['name'], 'MT delta',row['boundary']['settingsDelta'],'CPU samples',row['cpu_samples'],'sampled bytes',row['sampled_allocation_bytes'])
