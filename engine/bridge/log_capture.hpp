// Orca's log (Boost.Log, BOOST_LOG_TRIVIAL) for the engine: the verbosity the engine runs with, and a
// capture that collects the records of one job (a slice's log, the errors of a profile load) instead of
// printing them to the console.
#pragma once

#include <cstddef>
#include <memory>
#include <string>
#include <vector>

namespace muon {

// Orca's --debug scale: 0 off, 1 error (the engine's default), 2 warning, 3 info, 4 debug, 5 trace.
void set_engine_log_level(int level);
int  engine_log_level();

struct LogLine {
    int         level; // on the scale above: 0 fatal, 1 error, 2 warning, 3 info, 4 debug, 5 trace
    std::string message;
};

// While it lives, every record at `level` or more severe goes into lines() (thread-safe: the mt
// build logs from TBB threads), and nothing goes to the console. At most `max_bytes` of messages are
// kept; the rest are counted in dropped(). Captures do not nest: a second one replaces the first.
class LogCapture {
public:
    explicit LogCapture(int level, size_t max_bytes = 4u << 20);
    ~LogCapture();
    LogCapture(const LogCapture &)            = delete;
    LogCapture &operator=(const LogCapture &) = delete;

    std::vector<LogLine> lines() const;
    size_t               dropped() const;
    // The lines as text, one per line: "<severity>: <message>".
    std::string text() const;

    struct State;

private:
    std::shared_ptr<State> m_state;
    int                    m_saved_level;
};

const char *log_level_name(int level);

} // namespace muon
