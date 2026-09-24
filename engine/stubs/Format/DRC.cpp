// Replaces src/libslic3r/Format/DRC.cpp (Google draco) in the browser engine.
// Model::read_from_file() calls load_drc() for .drc files. The other DRC.hpp functions (load into a
// TriangleMesh, store_drc) have no caller in libslic3r and are left undefined, as the linker allows.
#include "libslic3r/Format/DRC.hpp"

#include "../Unsupported.hpp"

namespace Slic3r {

bool load_drc(const char * /*path*/, Model * /*model*/, const char * /*object_name*/)
{
    browser_engine::throw_unsupported("Draco (.drc) import");
}

} // namespace Slic3r
