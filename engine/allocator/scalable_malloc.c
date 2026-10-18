// tbbmalloc's C API (tbb::scalable_allocator and friends) on the engine's own malloc, for the mt and mt64 engines.
//
// Orca allocates every Points vector (Point.hpp: PointsAllocator) and the support layers' storage
// (Support/SupportLayer.hpp) with tbb::scalable_allocator. Natively that is tbbmalloc. On wasm32,
// tbbmalloc takes its memory from Emscripten's mmap, which is malloc underneath, and keeps it in
// per-thread caches and its own backend, on top of mimalloc: on a plate of two 200 000-triangle parts the
// mt heap was 1.6 GB after "Slicing mesh" with tbbmalloc and 0.5 GB without it, at 8 threads (st, whose
// serial shim allocates these with operator new, slices the whole plate in 0.65 GB).
// Here the same calls go straight to malloc (mimalloc in the mt build), so the memory is pooled in one
// allocator. Nothing else changes: an allocator does not change the G-code, which the goldens check.
// engine/PATCHES.md and engine/cmake/Engine.cmake say where this replaces libtbbmalloc.a.
#include <malloc.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

void *scalable_malloc(size_t size) { return malloc(size); }
void scalable_free(void *ptr) { free(ptr); }
void *scalable_realloc(void *ptr, size_t size) { return realloc(ptr, size); }
void *scalable_calloc(size_t nobj, size_t size) { return calloc(nobj, size); }
int scalable_posix_memalign(void **memptr, size_t alignment, size_t size) { return posix_memalign(memptr, alignment, size); }

void *scalable_aligned_malloc(size_t size, size_t alignment)
{
    void *ptr = NULL;
    return posix_memalign(&ptr, alignment < sizeof(void *) ? sizeof(void *) : alignment, size) == 0 ? ptr : NULL;
}

void *scalable_aligned_realloc(void *ptr, size_t size, size_t alignment)
{
    if (!ptr) return scalable_aligned_malloc(size, alignment);
    if (size == 0) {
        free(ptr);
        return NULL;
    }
    void *moved = scalable_aligned_malloc(size, alignment);
    if (!moved) return NULL;
    const size_t old_size = malloc_usable_size(ptr);
    memcpy(moved, ptr, old_size < size ? old_size : size);
    free(ptr);
    return moved;
}

void scalable_aligned_free(void *ptr) { free(ptr); }
size_t scalable_msize(void *ptr) { return ptr ? malloc_usable_size(ptr) : 0; }

// Tuning and buffer-cleaning requests for tbbmalloc's own pools: there are none. TBBMALLOC_OK.
int scalable_allocation_mode(int param, intptr_t value) { (void)param; (void)value; return 0; }
int scalable_allocation_command(int cmd, void *param) { (void)cmd; (void)param; return 0; }
