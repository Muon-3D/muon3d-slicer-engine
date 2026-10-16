// The plate's other objects as support blockers, and what a G-code path conflict was.
//
// Orca generates each object's supports seeing only that object (PrintObject::_generate_support_material,
// TreeModelVolumes: the collision areas are the object's own layer outlines), so a branch of one object's
// tree support can pass through a neighbouring object, and the plate then fails the conflict check (-101).
// Organic tree supports route around support-blocker volumes (TreeModelVolumes: the anti-overhang areas are
// added to every collision area). The engine therefore adds, on each object whose supports are organic
// trees, every other object within reach of its branches as a support-blocker volume, placed where it is on
// the plate. Orca is not changed: the blockers are ordinary ModelVolumes, as a 3MF's "support blocker"
// parts are.
#pragma once

#include "job.hpp"

#include <libslic3r/GCode/GCodeProcessor.hpp>
#include <libslic3r/Model.hpp>
#include <libslic3r/Print.hpp>
#include <libslic3r/PrintConfig.hpp>

#include <string>
#include <vector>

namespace muon {

// An object that got neighbours as support blockers, by its ModelObject's id (Print::apply copies the
// Model; the copies keep the ids), with the names of those neighbours.
struct BlockedObject {
    size_t                   object_id = 0;
    std::string              name;
    std::vector<size_t>      neighbour_ids;
    std::vector<std::string> neighbour_names;
};

// How far (mm, in XY) an object's tree support may reach from the object's own footprint: the farthest a
// branch can lean over the object's height at the branch angle, its radius growing at the diameter angle,
// the widest branch and the base, the XY distance, the support brim and the raft's first-layer expansion,
// plus a margin. Conservative: a branch never reaches farther.
double organic_support_reach(const Slic3r::DynamicPrintConfig &config, double object_height);

// How far (mm, in XY) the blockers keep an object's organic supports from a neighbour: the support's XY
// distance, plus what Orca adds around the supports' base without looking at other objects (the first layer's
// expansion, raft_first_layer_expansion, and with a raft its expansion, raft_expansion), plus 0.2 mm. A
// support-blocker only keeps a branch's centre a radius away (TreeModelVolumes adds the blockers to the
// collision areas grown by the radius alone), so without this a branch could touch the neighbour, and its
// first layer, widened, would overlap it.
double organic_support_clearance(const Slic3r::DynamicPrintConfig &config);

// True when `config` (the plate's settings with the object's over them) gives the object organic tree
// supports (support_type tree(auto) or tree(manual) with support_style "default" or "organic", as
// SupportParameters resolves it), which may be generated: supports on, enforced layers, or support paint.
bool has_organic_supports(const Slic3r::DynamicPrintConfig &config, const Slic3r::ModelObject &object);

// For each object with organic supports, adds every other object instance within reach
// (organic_support_reach, on XY bounding boxes) as support-blocker volumes: each of that instance's model
// parts, sharing its mesh, transformed into this object's coordinates, once where it is and once moved by the
// clearance (organic_support_clearance) in each of 8-24 directions spread evenly on the bed, at most 1 mm
// apart on the clearance's circle; together they are the neighbour grown by the clearance in XY (where the
// neighbour is thinner than that gap, the clearance has notches, never the neighbour itself). Other instances of the same object
// count as neighbours too. An object with several instances gets the neighbours of each of them (its
// supports are generated once for all of them). Nothing is added when no object has organic supports, or
// none is within reach: the plate then slices exactly as before. Call after the objects are placed
// (ensure_on_bed) and before Print::apply. `plate_config` is the plate's full print config.
std::vector<BlockedObject> add_neighbour_blockers(Slic3r::Model &model, const Slic3r::DynamicPrintConfig &plate_config);

// After Print::process: for each object that got neighbours, the overhangs over a neighbour that its
// organic supports left unsupported, as one "support_dropped" warning per object naming it and those
// neighbours. Only supports placed automatically (tree(auto)) are checked. See the definition for how an
// overhang and "unsupported" are approximated.
std::vector<EngineWarning> find_dropped_supports(const Slic3r::Print &print, const std::vector<BlockedObject> &blocked);

// The conflict Orca found (Print::get_conflict_result) as the protocol's SliceConflict: the two objects, the
// print Z of the layer (the layer whose bottom is ConflictResult::_height), its index among the plate's
// layers (as GCodeViewer numbers it: the number of layers below it, so the index into Toolpaths.layerZ),
// and whose support hit the other object (the object whose support extrusions on that layer cross the other
// object's outline there), or empty when neither's does (walls, or support against support).
ConflictInfo describe_conflict(const Slic3r::Print &print, const Slic3r::ConflictResult &conflict, const std::vector<float> *layer_z);

// The lowest of the plate's path conflicts between two objects, given the one Orca found (`found`,
// Print::get_conflict_result). Orca checks the layers in parallel (ConflictChecker::
// find_inter_of_lines_in_diff_objs, tbb::parallel_for) and keeps whichever conflict a thread reported
// first: on the mt engines that is any conflicting layer, a different one from run to run, while st (the
// serial shim) finds the lowest. This checks the layers in order, as st does, so every variant reports the
// same conflict: the first layer the plate would go wrong on. A conflict with the prime tower is returned
// as Orca found it.
Slic3r::ConflictResult lowest_conflict(Slic3r::Print &print, const Slic3r::ConflictResult &found);

} // namespace muon
