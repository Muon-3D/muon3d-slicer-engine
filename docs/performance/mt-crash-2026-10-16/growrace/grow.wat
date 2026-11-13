;; probe(k, base, atomic): wait (spinning) until the generation at address 0 reaches k, then read the first word
;; of page base + k, grown by the other thread just before it published k: atomically, or with a plain load.
;; probe_blocked(k, base): the same, but the thread sleeps in memory.atomic.wait32 until it is woken.
(module
  (import "m" "m" (memory 16 32768 shared))
  (func (export "probe") (param $k i32) (param $base i32) (param $atomic i32) (result i32)
    (loop $wait
      (br_if $wait (i32.lt_u (i32.atomic.load (i32.const 0)) (local.get $k))))
    (if (result i32) (local.get $atomic)
      (then (i32.atomic.load (i32.shl (i32.add (local.get $base) (local.get $k)) (i32.const 16))))
      (else (i32.load (i32.shl (i32.add (local.get $base) (local.get $k)) (i32.const 16))))))
  (func (export "probe_blocked") (param $k i32) (param $base i32) (result i32) (local $seen i32)
    (block $done
      (loop $wait
        (local.set $seen (i32.atomic.load (i32.const 0)))
        (br_if $done (i32.ge_u (local.get $seen) (local.get $k)))
        (drop (memory.atomic.wait32 (i32.const 0) (local.get $seen) (i64.const -1)))
        (br $wait)))
    (i32.atomic.load (i32.shl (i32.add (local.get $base) (local.get $k)) (i32.const 16)))))
