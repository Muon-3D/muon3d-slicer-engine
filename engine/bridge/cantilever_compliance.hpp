#pragma once

namespace muon {

// Sum (h - z)^2 dz/I at each printed height. Advancing the reference height updates
// the first two moments in constant work, without subtracting large nearly equal terms.
class CantileverCompliance {
    double height_ = 0, weight_ = 0, first_ = 0, second_ = 0;
public:
    double add(double top, double mid, double thickness, double inertia) {
        const double advance = top - height_;
        second_ += 2 * advance * first_ + advance * advance * weight_;
        first_ += advance * weight_;
        const double weight = thickness / inertia, distance = top - mid;
        weight_ += weight;
        first_ += weight * distance;
        second_ += weight * distance * distance;
        height_ = top;
        return second_;
    }
};

} // namespace muon
