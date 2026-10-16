#include "../bridge/cantilever_compliance.hpp"
#include <cassert>
#include <cmath>
int main() {
    muon::CantileverCompliance sum;
    // Direct discrete integration of three unequal sections, independent reference.
    const double tops[] = {0.2, 0.5, 0.7};
    const double mids[] = {0.1, 0.35, 0.6};
    const double heights[] = {0.2, 0.3, 0.2};
    const double inertia[] = {1.0, 2.0, 0.5};
    for (int i = 0; i < 3; ++i) {
        double reference = 0;
        for (int j = 0; j <= i; ++j)
            reference += std::pow(tops[i] - mids[j], 2) * heights[j] / inertia[j];
        assert(std::abs(sum.add(tops[i], mids[i], heights[i], inertia[i]) - reference) < 1e-12);
    }
    // 100k sections: constant work per layer, hand-derived sum of squared half-integers.
    muon::CantileverCompliance tall;
    const double n = 100000;
    double got = 0;
    for (int i = 0; i < int(n); ++i) got = tall.add(i + 1.0, i + 0.5, 1, 1);
    const double want = n * (4*n*n - 1) / 12;
    assert(std::abs(got / want - 1) < 1e-12);
}
