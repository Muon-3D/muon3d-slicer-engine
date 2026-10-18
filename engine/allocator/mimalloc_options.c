// mimalloc settings for the mt and mt64 engines (-sMALLOC=mimalloc), applied before the first allocation.
//
// arena_max_object_size = 4 MiB: objects larger than that come from emmalloc (mimalloc's "OS" in
// Emscripten) and go back to it when freed, where they merge with their neighbours and are reused. By
// default mimalloc puts objects of any size in its arenas, which on wasm are real memory, never released.
// An organic tree support allocates and frees buffers of 20-50 MB over and over, from several threads; mimalloc
// found no room for the next one in its existing arenas and reserved a new arena each time (32, 48, 64, then
// 128 and 256 MB, as mimalloc grows them), so Harry's two-part plate (464 000 triangles, organic supports)
// ran the 4 GB heap out while mimalloc itself had about 0.4 GB in use. With the limit it peaks at 2.0 GB at 8
// threads, a Benchy's engine at 1.1 GB instead of 1.7-2.0 GB, and the heap stops growing from job to job.
// The value is the arena chunk size on wasm32 (256 slices of 16 KiB): every object up to it still fits in
// one chunk. 1 MiB was measured too, and gave the same speed with a little more memory. mt64 (wasm64) has the
// same problem and takes the same limit (64 of its 64 KiB slices).
#include <mimalloc.h>

__attribute__((constructor(101))) static void muon_mimalloc_options(void)
{
    mi_option_set(mi_option_arena_max_object_size, 4 * 1024); // KiB
}
