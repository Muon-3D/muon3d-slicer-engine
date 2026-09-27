// GCodeProcessorResult -> preview toolpaths and print statistics.
//
// The preview format is Toolpaths (packages/protocol), which a G-code text parser also produces
// (test/helpers/parseGcode.ts); the aim is that the same file gives the same picture whichever way it was
// read. Where Orca's processor and the text parser see a move differently, the parser's view wins:
//
//  * One segment per G-code move. The processor splits a straight move into pieces at its
//    acceleration/cruise/deceleration points ("actual speed" moves, internal_only, time 0,
//    inserted before the original move) - that roughly triples the segment count of a Benchy.
//    Those pieces are merged back: consecutive pieces of the same G-code line (same gcode_id)
//    joined at an internal_only vertex and continuing in a straight line become one segment,
//    with the attributes of its last piece, which is the G-code move itself (the pieces before
//    it carry width and height interpolated from the previous move, GCodeProcessor.cpp:541).
//    Arcs are also tessellated into internal_only pieces, but those turn, so they stay separate
//    (the parser flattens arcs into chords too).
//  * Travels include wipes (the parser draws any move that does not extrude as a travel).
//  * Each extrusion keeps the processor's own width and height (MoveVertex::width/height, what
//    Orca's preview draws the bead with), as the parser's size codes.
//  * The processor starts at (0,0,0) and treats G28 as a move to 0; the parser does not draw
//    moves until the head position is known. Dropping the travels before the first extrusion
//    removes those made-up lines from the start G-code (it may also drop one real travel there).
//  * Layer Z: non-Bambu G-code gives the processor no print Z (MoveVertex::print_z comes only
//    from Bambu's "; Z_HEIGHT:" tag), so a layer's Z is its last extrusion's Z outside custom
//    G-code, as libvgcode does (src/libvgcode/src/Layers.cpp); for normal and vase layers this
//    equals the ";Z:" value the parser reads.
#include "toolpaths.hpp"

#include <libslic3r/libslic3r.h>
#include <libslic3r/ExtrusionEntity.hpp>
#include <libslic3r/Layer.hpp>
#include <libslic3r/Utils.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>

using namespace Slic3r;

namespace muon {
namespace {

using MoveVertex = GCodeProcessorResult::MoveVertex;

constexpr size_t NORMAL_MODE = size_t(PrintEstimatedStatistics::ETimeMode::Normal);
// parse.ts size codes: a width or height in one byte, 0.01 mm steps up to 2 mm (codes 1-200), then
// 0.05 mm steps up to 4.75 mm (201-255); 0 = none.
constexpr double SIZE_STEP_MM        = 0.01;
constexpr int    SIZE_FINE_CODES     = 200;
constexpr double SIZE_COARSE_STEP_MM = 0.05;
constexpr int    MAX_SIZE_CODE       = 255;
// Pieces of one move lie on one line up to float rounding (well under this); the chords of a
// tessellated arc bend away from each other by far more.
constexpr double COLLINEAR_OFFSET = 1e-4; // mm

// parse.ts sizeCode
uint8_t size_code(float mm)
{
    if (!(mm > 0.f))
        return 0;
    const long fine = std::lround(double(mm) / SIZE_STEP_MM);
    if (fine <= SIZE_FINE_CODES)
        return uint8_t(std::max(fine, 1L));
    const long coarse = SIZE_FINE_CODES + std::lround((double(mm) - SIZE_FINE_CODES * SIZE_STEP_MM) / SIZE_COARSE_STEP_MM);
    return uint8_t(std::min<long>(coarse, MAX_SIZE_CODE));
}

// parse.ts sizeMm
double size_mm(int code)
{
    return code <= SIZE_FINE_CODES ? code * SIZE_STEP_MM : SIZE_FINE_CODES * SIZE_STEP_MM + (code - SIZE_FINE_CODES) * SIZE_COARSE_STEP_MM;
}

// True when the path a -> b -> c goes straight on at b, i.e. dropping b (drawing a -> c) moves
// the line by at most COLLINEAR_OFFSET. Measuring the offset rather than the turn angle matters
// for the tiny first piece a split often has: its float end points give it a direction that can
// be a degree off, although it lies on the line.
bool continues_straight(const Vec3f &a, const Vec3f &b, const Vec3f &c)
{
    const Vec3d  ab = (b - a).cast<double>(), bc = (c - b).cast<double>(), ac = (c - a).cast<double>();
    const double length_ac = ac.squaredNorm();
    if (ab.squaredNorm() == 0. || bc.squaredNorm() == 0.)
        return true;
    if (ab.dot(bc) <= 0.)
        return false;
    // Distance of b from the line a-c: |ab x ac| / |ac|.
    return ab.cross(ac).squaredNorm() <= COLLINEAR_OFFSET * COLLINEAR_OFFSET * length_ac;
}

// A piece of the move that the previous segment ended with: same G-code line, joined at a vertex
// the processor inserted itself.
bool continues_same_move(const MoveVertex &prev, const MoveVertex &cur) { return prev.internal_only && prev.gcode_id == cur.gcode_id; }

void push_segment(std::vector<float> &positions, const Vec3f &from, const Vec3f &to)
{
    positions.insert(positions.end(), {from.x(), from.y(), from.z(), to.x(), to.y(), to.z()});
}

void extend_segment(std::vector<float> &positions, const Vec3f &to)
{
    float *end = positions.data() + positions.size() - 3;
    end[0] = to.x();
    end[1] = to.y();
    end[2] = to.z();
}

Vec3f segment_start(const std::vector<float> &positions)
{
    const float *start = positions.data() + positions.size() - 6;
    return Vec3f(start[0], start[1], start[2]);
}

// printf("%.2f") and back: the rounding Orca's G-code comments apply to the statistics.
double round2(double value)
{
    char buf[64];
    std::snprintf(buf, sizeof buf, "%.2f", value);
    return std::strtod(buf, nullptr);
}

// parseAmount (test/helpers/gcodeStats.ts): the sum of the printed values, rounded to 3 decimals.
double sum_as_printed(const std::vector<double> &values)
{
    double sum = 0.;
    for (double v : values)
        sum += round2(v);
    return std::round(sum * 1000.) / 1000.;
}

// parseDuration (test/helpers/gcodeStats.ts) for Orca's get_time_dhms text ("1d 2h 3m 4s", "44m 38s",
// "0.500000s"): total seconds, rounded like Math.round.
std::optional<double> parse_duration(const std::string &text)
{
    double      seconds = 0.;
    bool        any     = false;
    const char *s       = text.c_str();
    while (*s != '\0') {
        while (*s == ' ')
            ++s;
        if (*s == '\0')
            break;
        char        *end    = nullptr;
        const double amount = std::strtod(s, &end);
        if (end == s)
            return std::nullopt;
        s = end;
        while (*s == ' ')
            ++s;
        switch (std::tolower(static_cast<unsigned char>(*s))) {
        case 'd': seconds += amount * 86400.; break;
        case 'h': seconds += amount * 3600.; break;
        case 'm': seconds += amount * 60.; break;
        case 's': seconds += amount; break;
        default: return std::nullopt;
        }
        ++s;
        any = true;
    }
    if (!any)
        return std::nullopt;
    return std::floor(seconds + 0.5);
}

} // namespace

ToolpathData build_toolpaths(const GCodeProcessorResult &result, bool with_extras)
{
    ToolpathData                   out;
    const std::vector<MoveVertex> &moves = result.moves;

    uint32_t layer_count = 0;
    for (const MoveVertex &move : moves)
        layer_count = std::max(layer_count, move.layer_id + 1);
    out.extrusion_layer_start.assign(size_t(layer_count) + 1, 0);
    out.travel_layer_start.assign(size_t(layer_count) + 1, 0);

    const float     no_z = std::numeric_limits<float>::quiet_NaN();
    std::vector<float> layer_z_printed(layer_count, no_z); // last extrusion outside custom G-code
    std::vector<float> layer_z_any(layer_count, no_z);     // last extrusion of any kind

    std::array<int, size_t(erCount)>             role_slot;
    std::array<double, size_t(MAX_SIZE_CODE) + 1>  width_length{};
    role_slot.fill(-1);

    float bmin[3] = {std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max()};
    float bmax[3] = {std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest()};
    float min_extrusion_z = std::numeric_limits<float>::max();

    constexpr size_t NONE = std::numeric_limits<size_t>::max();
    size_t   last_extrusion_move = NONE, last_travel_move = NONE;
    double   open_segment_length = 0.; // length of the last extrusion segment, while it may still grow
    bool     seen_extrusion      = false;
    uint32_t current_layer       = 0;
    // MoveVertex::time is each move's own duration (GCodeProcessor.cpp:505), not a timestamp.
    double time = moves.empty() ? 0. : double(moves.front().time[NORMAL_MODE]);

    for (size_t i = 1; i < moves.size(); ++i) {
        const MoveVertex &prev = moves[i - 1];
        const MoveVertex &cur  = moves[i];
        time += double(cur.time[NORMAL_MODE]);

        // Moves arrive in layer order; never step back even if a move says otherwise.
        const uint32_t layer = std::max(current_layer, std::min(cur.layer_id, layer_count - 1));
        while (current_layer < layer) {
            ++current_layer;
            out.extrusion_layer_start[current_layer] = uint32_t(out.extrusion_count());
            out.travel_layer_start[current_layer]    = uint32_t(out.travel_count());
        }

        const bool extrusion = cur.type == EMoveType::Extrude;
        const bool travel    = cur.type == EMoveType::Travel || cur.type == EMoveType::Wipe;
        if ((!extrusion && !travel) || cur.position == prev.position)
            continue;

        if (extrusion) {
            seen_extrusion   = true;
            const int  role  = int(cur.extrusion_role) < int(erCount) ? int(cur.extrusion_role) : int(erNone);
            if (role_slot[role] < 0) {
                role_slot[role] = int(out.roles.size());
                out.roles.push_back(ExtrusionEntity::role_to_string(ExtrusionRole(role)));
                out.role_length.push_back(0.);
            }
            const uint8_t slot   = uint8_t(role_slot[role]);
            const uint8_t width  = size_code(cur.width);
            const uint8_t height = size_code(cur.height);
            const double  length = double((cur.position - prev.position).norm());

            const bool merge = last_extrusion_move == i - 1 && continues_same_move(prev, cur) && out.extrusion_role.back() == slot &&
                               continues_straight(segment_start(out.extrusion_positions), prev.position, cur.position);
            if (merge) {
                extend_segment(out.extrusion_positions, cur.position);
                // The segment's length so far was counted at its first piece's (interpolated) width.
                width_length[out.extrusion_width.back()] -= open_segment_length;
                width_length[width] += open_segment_length;
                out.extrusion_width.back()  = width;
                out.extrusion_height.back() = height;
                open_segment_length += length;
            } else {
                push_segment(out.extrusion_positions, prev.position, cur.position);
                out.extrusion_role.push_back(slot);
                out.extrusion_width.push_back(width);
                out.extrusion_height.push_back(height);
                open_segment_length = length;
            }
            if (with_extras) {
                // A merged segment takes the values of its last piece, which is the G-code move itself.
                const float    feedrate    = cur.feedrate;
                const uint8_t  fan         = uint8_t(std::clamp(std::lround(double(cur.fan_speed)), 0L, 100L));
                const uint16_t temperature = uint16_t(std::clamp(std::lround(double(cur.temperature)), 0L, 65535L));
                if (merge) {
                    out.feedrate.back()    = feedrate;
                    out.fan_speed.back()   = fan;
                    out.temperature.back() = temperature;
                    out.time.back()        = float(time);
                    out.height.back()      = cur.height;
                } else {
                    out.feedrate.push_back(feedrate);
                    out.fan_speed.push_back(fan);
                    out.temperature.push_back(temperature);
                    out.time.push_back(float(time));
                    out.height.push_back(cur.height);
                }
            }
            last_extrusion_move = i;

            out.role_length[slot] += length;
            width_length[width] += length;
            for (int axis = 0; axis < 3; ++axis) {
                bmin[axis] = std::min({bmin[axis], prev.position[axis], cur.position[axis]});
                bmax[axis] = std::max({bmax[axis], prev.position[axis], cur.position[axis]});
            }
            min_extrusion_z = std::min({min_extrusion_z, prev.position.z(), cur.position.z()});
            layer_z_any[layer] = cur.position.z();
            if (cur.extrusion_role != erCustom)
                layer_z_printed[layer] = cur.position.z();
        } else {
            if (!seen_extrusion)
                continue;
            const bool merge = last_travel_move == i - 1 && continues_same_move(prev, cur) &&
                               continues_straight(segment_start(out.travel_positions), prev.position, cur.position);
            if (merge)
                extend_segment(out.travel_positions, cur.position);
            else
                push_segment(out.travel_positions, prev.position, cur.position);
            last_travel_move = i;
        }
    }
    for (uint32_t l = current_layer + 1; l <= layer_count; ++l) {
        out.extrusion_layer_start[l] = uint32_t(out.extrusion_count());
        out.travel_layer_start[l]    = uint32_t(out.travel_count());
    }

    // parse.ts: no segments at all means no layers.
    if (out.extrusion_count() == 0 && out.travel_count() == 0) {
        out.layer_z.clear();
        out.extrusion_layer_start.assign(1, 0);
        out.travel_layer_start.assign(1, 0);
        return out;
    }

    // A layer without extrusions sits on the one below it (parse.ts does the same).
    out.layer_z.resize(layer_count);
    for (uint32_t l = 0; l < layer_count; ++l) {
        float z = !std::isnan(layer_z_printed[l]) ? layer_z_printed[l] : layer_z_any[l];
        if (std::isnan(z))
            z = l > 0 ? out.layer_z[l - 1] : (out.extrusion_count() > 0 ? min_extrusion_z : 0.f);
        out.layer_z[l] = z;
    }

    if (out.extrusion_count() > 0) {
        out.has_bounds = true;
        std::copy(bmin, bmin + 3, out.bounds_min);
        std::copy(bmax, bmax + 3, out.bounds_max);
    }

    // The width most of the toolpath length is printed at; ties keep the narrower (parse.ts).
    int dominant = 0;
    for (int w = 1; w <= MAX_SIZE_CODE; ++w)
        if (width_length[w] > (dominant > 0 ? width_length[dominant] : 0.))
            dominant = w;
    if (dominant > 0)
        out.line_width = size_mm(dominant);

    return out;
}

GcodeStats build_stats(const GCodeProcessorResult &result, const Print &print)
{
    GcodeStats stats;

    // Footer "; estimated printing time (normal mode) = …" (Bambu: the header's "total estimated
    // time") and "; estimated first layer printing time (normal mode) = …", which Orca fills with
    // the time until the first layer starts (the machine start G-code), GCodeProcessor.cpp:1156-1184.
    const PrintEstimatedStatistics::Mode &normal = result.print_statistics.modes[NORMAL_MODE];
    stats.print_time_text       = get_time_dhms(normal.time);
    stats.print_time_seconds    = parse_duration(*stats.print_time_text);
    stats.first_layer_time_text = get_time_dhms(normal.prepare_time);

    // The footer's filament lines are rewritten by GCodeProcessor::run_post_process
    // (GCodeProcessor.cpp:1044-1058) from the processor's per-filament volumes.
    const size_t        filaments = result.filaments_count;
    std::vector<double> used_mm(filaments, 0.), used_cm3(filaments, 0.), used_g(filaments, 0.), cost(filaments, 0.);
    double              total_g = 0., total_cost = 0.;
    for (const auto &[id, volume] : result.print_statistics.total_volumes_per_extruder) {
        if (id >= filaments || id >= result.filament_diameters.size() || id >= result.filament_densities.size() ||
            id >= result.filament_costs.size())
            continue;
        used_mm[id]  = volume / (static_cast<double>(M_PI) * sqr(0.5 * result.filament_diameters[id]));
        used_cm3[id] = volume * 0.001;
        used_g[id]   = used_cm3[id] * double(result.filament_densities[id]);
        cost[id]     = used_g[id] * double(result.filament_costs[id]) * 0.001;
        total_g += used_g[id];
        total_cost += cost[id];
    }
    if (filaments > 0) {
        stats.filament_mm  = sum_as_printed(used_mm);
        stats.filament_cm3 = sum_as_printed(used_cm3);
        if (print.is_BBL_printer()) {
            // Bambu G-code has no "total" lines; a text reader sums the per-filament lines, which
            // Orca writes only when some filament has a weight (and a cost).
            if (total_g > 0.)
                stats.filament_g = sum_as_printed(used_g);
            if (total_cost > 0.)
                stats.filament_cost = sum_as_printed(cost);
        } else {
            stats.filament_g    = round2(total_g);
            stats.filament_cost = round2(total_cost);
        }
    }

    // Header "; total layer number: N": the number of layer changes the processor counted, which
    // is also the number of layers the moves are spread over.
    uint32_t layers = 0;
    for (const auto &move : result.moves)
        layers = std::max(layers, move.layer_id + 1);
    stats.layers = double(layers);

    // Header "; max_z_height: %.2f" (GCode.cpp:3171-3183).
    double max_z = -1.;
    for (const PrintObject *object : print.objects())
        if (!object->layers().empty())
            max_z = std::max(max_z, double(object->layers().back()->print_z));
    if (max_z >= 0.)
        stats.max_z = round2(max_z);

    return stats;
}

} // namespace muon
