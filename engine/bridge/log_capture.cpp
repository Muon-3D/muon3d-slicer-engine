// See log_capture.hpp.
#include "log_capture.hpp"

#include <boost/log/core.hpp>
#include <boost/log/expressions.hpp>
#include <boost/log/sinks/basic_sink_backend.hpp>
#include <boost/log/sinks/sync_frontend.hpp>
#include <boost/log/trivial.hpp>
#include <boost/make_shared.hpp>

#include <algorithm>
#include <mutex>

namespace muon {

namespace logging = boost::log;
namespace sinks   = boost::log::sinks;
using logging::trivial::severity_level;

namespace {

int g_level = 1;

const severity_level k_severities[] = {logging::trivial::fatal, logging::trivial::error, logging::trivial::warning,
                                       logging::trivial::info,  logging::trivial::debug, logging::trivial::trace};

severity_level severity_of(int level) { return k_severities[std::clamp(level, 0, 5)]; }

int level_of(severity_level severity)
{
    switch (severity) {
    case logging::trivial::fatal: return 0;
    case logging::trivial::error: return 1;
    case logging::trivial::warning: return 2;
    case logging::trivial::info: return 3;
    case logging::trivial::debug: return 4;
    default: return 5;
    }
}

} // namespace

const char *log_level_name(int level)
{
    static const char *names[] = {"fatal", "error", "warning", "info", "debug", "trace"};
    return names[std::clamp(level, 0, 5)];
}

void set_engine_log_level(int level)
{
    g_level   = std::clamp(level, 0, 5);
    auto core = logging::core::get();
    if (g_level <= 0) {
        core->set_logging_enabled(false);
        return;
    }
    // Orca's --debug scale (utils.cpp level_to_boost). Orca's own set_logging_level() forces "info" for
    // -dev versions, which floods the console and slows slicing, so it is bypassed.
    core->set_logging_enabled(true);
    core->set_filter(logging::trivial::severity >= severity_of(g_level));
}

int engine_log_level() { return g_level; }

struct LogCapture::State {
    mutable std::mutex   mutex;
    std::vector<LogLine> lines;
    size_t               bytes = 0;
    size_t               max_bytes;
    size_t               dropped = 0;
    boost::shared_ptr<sinks::sink> sink;
};

namespace {

class CaptureBackend : public sinks::basic_sink_backend<sinks::synchronized_feeding> {
public:
    explicit CaptureBackend(std::shared_ptr<LogCapture::State> state) : m_state(std::move(state)) {}

    void consume(const logging::record_view &record)
    {
        const auto severity = record[logging::trivial::severity];
        const auto message  = record[logging::expressions::smessage];
        LogLine    line{severity ? level_of(severity.get()) : 3, message ? message.get() : std::string()};
        while (!line.message.empty() && (line.message.back() == '\n' || line.message.back() == '\r'))
            line.message.pop_back();
        std::lock_guard<std::mutex> lock(m_state->mutex);
        if (m_state->bytes + line.message.size() > m_state->max_bytes) {
            ++m_state->dropped;
            return;
        }
        m_state->bytes += line.message.size();
        m_state->lines.push_back(std::move(line));
    }

private:
    std::shared_ptr<LogCapture::State> m_state;
};

} // namespace

LogCapture::LogCapture(int level, size_t max_bytes) : m_state(std::make_shared<State>()), m_saved_level(g_level)
{
    m_state->max_bytes = max_bytes;
    auto sink          = boost::make_shared<sinks::synchronous_sink<CaptureBackend>>(boost::make_shared<CaptureBackend>(m_state));
    sink->set_filter(logging::trivial::severity >= severity_of(std::max(level, 1)));
    m_state->sink = sink;
    auto core     = logging::core::get();
    // With a sink of its own registered, Boost.Log stops writing to the console (its default sink).
    core->add_sink(sink);
    core->set_logging_enabled(true);
    core->set_filter(logging::trivial::severity >= severity_of(std::max(level, 1)));
}

LogCapture::~LogCapture()
{
    auto core = logging::core::get();
    core->remove_sink(m_state->sink);
    set_engine_log_level(m_saved_level);
}

std::vector<LogLine> LogCapture::lines() const
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    return m_state->lines;
}

size_t LogCapture::dropped() const
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    return m_state->dropped;
}

std::string LogCapture::text() const
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    std::string out;
    out.reserve(m_state->bytes + m_state->lines.size() * 10);
    for (const LogLine &line : m_state->lines) {
        out += log_level_name(line.level);
        out += ": ";
        out += line.message;
        out += '\n';
    }
    if (m_state->dropped > 0)
        out += "(" + std::to_string(m_state->dropped) + " more lines left out)\n";
    return out;
}

} // namespace muon
