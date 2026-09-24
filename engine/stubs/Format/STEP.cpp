// Replaces src/libslic3r/Format/STEP.cpp (OCCT) in the browser engine.
//
// Model.hpp includes Format/STEP.hpp, and Model::read_from_step() (Model.cpp) constructs a Step,
// loads it and meshes it, so these four members must exist. STEP import needs OCCT, which the
// browser engine does not build: load() and mesh() throw. The OCCT types STEP.hpp names come from
// engine/shims/occt. load_step() is declared in STEP.hpp but not defined by Orca either.
#include "libslic3r/Format/STEP.hpp"

#include "../Unsupported.hpp"

namespace Slic3r {

Step::Step(std::string path, ImportStepProgressFn stepFn, StepIsUtf8Fn isUtf8Fn)
    : m_path(std::move(path)), m_stepFn(std::move(stepFn)), m_utf8Fn(std::move(isUtf8Fn))
{}

Step::~Step() = default;

Step::Step_Status Step::load()
{
    browser_engine::throw_unsupported("STEP import");
}

Step::Step_Status Step::mesh(Model *, bool &, bool, double, double)
{
    browser_engine::throw_unsupported("STEP import");
}

} // namespace Slic3r
