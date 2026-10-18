# Prints the C strings at the given static addresses of a wasm module's data segments.
#   python wasmstr.py engine.wasm 2836 12548 ...
import sys

def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s; s += 7
        if x < 0x80: return r, i

data = open(sys.argv[1], 'rb').read()
i = 8
mem = {}
while i < len(data):
    sid = data[i]; i += 1
    size, i = leb(data, i)
    end = i + size
    if sid == 11:  # data section
        n, j = leb(data, i)
        for _ in range(n):
            flags, j = leb(data, j)
            offset = None
            if flags in (0, 2):
                if flags == 2: _, j = leb(data, j)
                op = data[j]; j += 1
                assert op == 0x41, op  # i32.const
                offset, j = leb(data, j)  # (unsigned is fine for small offsets)
                assert data[j] == 0x0b; j += 1
            ln, j = leb(data, j)
            mem[(offset, j)] = data[j:j + ln]
            j += ln
    i = end
segs = [(o, b) for (o, _), b in mem.items()]
print('segments', [(o, len(b)) for o, b in segs][:10])
for a in map(int, sys.argv[2:]):
    for o, b in segs:
        if o is not None and o <= a < o + len(b):
            s = b[a - o:a - o + 200].split(b'\0')[0]
            print(a, repr(s.decode('latin1')))
            break
    else:
        print(a, 'not in an active segment (passive segments, pthreads build?)')
