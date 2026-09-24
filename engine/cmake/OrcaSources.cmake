# Source selection for the out-of-tree libslic3r build.
#
# The file list is read from Orca's own src/libslic3r/CMakeLists.txt at configure time, so the engine
# follows the Orca checkout it is pointed at (ORCA_SRC) without a copy of the list to keep in sync. Only
# the unconditional `set(lisbslic3r_sources ...)` block is used: the CAD/* and Apple blocks are appended
# under SLIC3R_CAD / APPLE, which the browser engine does not enable, and OpenVDBUtils.cpp is only added
# when an OpenVDB target exists, which it never does here.

# orca_libslic3r_sources(<out_var>)
# Sets <out_var> to the .cpp files of Orca's libslic3r target, relative to src/libslic3r.
function(orca_libslic3r_sources out_var)
    set(cmake_file "${ORCA_SRC}/src/libslic3r/CMakeLists.txt")
    file(READ "${cmake_file}" text)
    # Strip comments first: the list contains commented-out entries (#GCodeSender.cpp,
    # #SLA/SupportTreeIGL.cpp) that must not be compiled.
    string(REGEX REPLACE "#[^\n]*" "" text "${text}")
    string(REGEX MATCH "set\\(lisbslic3r_sources([^)]*)\\)" block "${text}")
    if (NOT block)
        message(FATAL_ERROR "Could not find `set(lisbslic3r_sources ...)` in ${cmake_file}. "
                            "Orca's libslic3r CMakeLists changed; update engine/cmake/OrcaSources.cmake.")
    endif ()
    string(REGEX MATCHALL "[A-Za-z0-9_./-]+\\.cpp" sources "${CMAKE_MATCH_1}")
    list(REMOVE_DUPLICATES sources)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${cmake_file}")
    set(${out_var} "${sources}" PARENT_SCOPE)
endfunction()

# Orca libslic3r sources the browser engine does not compile, each with the reason. Files that kept code
# still references are replaced by a stub in engine/stubs/ (same relative path); the others are not
# referenced by anything the engine links, and libslic3r is a static archive, so leaving them out needs
# nothing else.
set(ORCA_LIBSLIC3R_EXCLUDED
    # OCCT (Open CASCADE): STEP and SVG import, text shapes.
    Format/STEP.cpp                    # stub: Step::load/mesh throw (Model::read_from_step)
    Format/svg.cpp                     # stub: load_svg throws (Model::read_from_file)
    Shape/TextShape.cpp                # unreferenced (GUI text tool)
    # assimp / draco.
    Format/AssimpImport.cpp            # stub: load_assimp_textured_model throws
    Format/DRC.cpp                     # stub: load_drc throws
    # OpenCV: texture-to-colour tools (GUI only).
    ObjColorUtils.cpp                  # unreferenced
    TexturePainting.cpp                # unreferenced
    TextureToColor/TextureToColor.cpp  # unreferenced
    TextureToColor/ColorUtils.cpp      # unreferenced
    # OpenVDB: SLA hollowing, and the SLA print pipeline built on it.
    SLA/Hollowing.cpp                  # stub: sla::DrainHole members, generated from Orca's own file
    SLAPrint.cpp                       # unreferenced by FFF
    SLAPrintSteps.cpp                  # unreferenced by FFF
    Format/SL1.cpp                     # unreferenced by FFF (SLA archive export)
    # Does not compile for Emscripten: static_assert(false, "Unknown platform detected").
    Platform.cpp                       # stub: same answers as Orca's unknown-platform branches
    # Precompiled-header translation unit; the header itself is used through target_precompile_headers.
    pchheader.cpp
)

# Kept on purpose although listed as "desktop-only" in the spec:
#  * Emboss.cpp uses only stb_truetype (deps_src/imgui/imstb_truetype.h) and CGAL, both available, and
#    NSVGUtils.cpp / CutSurface.cpp / the 3MF reader call into it. Compiling Orca's real file avoids
#    stubbing its shape-healing functions, which would change 3MF loading.
#  * BlacklistedLibraryCheck.cpp compiles to nothing outside Windows.
#  * The SLA support-tree sources compile without OpenVDB; SLA/IndexedMesh.cpp and
#    SLA/SupportTreeMesher.cpp are needed by FFF code, the rest is simply never linked in.

# orca_generate_drainhole_source(<out_file>)
# Writes the replacement for SLA/Hollowing.cpp: engine/stubs/SLA/Hollowing.cpp.in filled with the
# sla::DrainHole member definitions copied verbatim from Orca's Hollowing.cpp (the block that starts at
# `indexed_triangle_set DrainHole::to_mesh` and ends before `void cut_drainholes`). Those members are
# plain geometry used by FFF code; the rest of that file needs OpenVDB.
function(orca_generate_drainhole_source out_file)
    set(orca_file "${ORCA_SRC}/src/libslic3r/SLA/Hollowing.cpp")
    file(READ "${orca_file}" text)
    set(begin_marker "indexed_triangle_set DrainHole::to_mesh() const")
    set(end_marker "void cut_drainholes(")
    string(FIND "${text}" "${begin_marker}" begin_pos)
    string(FIND "${text}" "${end_marker}" end_pos)
    if (begin_pos EQUAL -1 OR end_pos EQUAL -1 OR NOT end_pos GREATER begin_pos)
        message(FATAL_ERROR "Could not find the sla::DrainHole member definitions in ${orca_file} "
                            "(between \"${begin_marker}\" and \"${end_marker}\"). Orca's Hollowing.cpp "
                            "changed; update orca_generate_drainhole_source() in engine/cmake/OrcaSources.cmake.")
    endif ()
    math(EXPR length "${end_pos} - ${begin_pos}")
    string(SUBSTRING "${text}" ${begin_pos} ${length} ORCA_DRAINHOLE_METHODS)
    # Sanity check: every out-of-line DrainHole member declared in Hollowing.hpp must be in the block.
    foreach (member "DrainHole::to_mesh" "DrainHole::operator==" "DrainHole::is_inside" "DrainHole::get_intersections")
        string(FIND "${ORCA_DRAINHOLE_METHODS}" "${member}" pos)
        if (pos EQUAL -1)
            message(FATAL_ERROR "${member} is no longer between the markers in ${orca_file}; "
                                "update orca_generate_drainhole_source() in engine/cmake/OrcaSources.cmake.")
        endif ()
    endforeach ()
    string(STRIP "${ORCA_DRAINHOLE_METHODS}" ORCA_DRAINHOLE_METHODS)
    set(ORCA_HOLLOWING_SOURCE "${orca_file}")
    configure_file("${ENGINE_DIR}/stubs/SLA/Hollowing.cpp.in" "${out_file}" @ONLY)
    # Re-run the generation when Orca's file changes.
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${orca_file}")
endfunction()
