// Everything OS-specific lives behind this header: platform_win.cpp (Win32) or platform_posix.cpp (Linux/macOS).
#pragma once
#include <cstddef>
#include <type_traits>

namespace jelly::platform {
void init();                                  // binary stdio, no crash dialogs, crash reporter
bool readStdin(void* dst, std::size_t n);     // blocks until n bytes arrived; false on EOF or error
bool writeStdout(const void* src, std::size_t n);

// Runs fn(ctx) and returns false instead of dying if it faults (access violation, C++ throw out of a plugin...).
// Code after a caught fault must not touch whatever faulted again: the plugin is abandoned.
bool guarded(void (*fn)(void*), void* ctx);

// What the calling thread is busy with (a plugin label, or nullptr). If the process dies of an uncaught fault, the
// crash reporter writes "JELLY-CRASH-IN: <label>\n" to stderr so Electron knows which plugin took it down.
void setCurrent(const char* label);
const char* current();
} // namespace jelly::platform

namespace jelly {
// guard(f): guarded() for any callable
template <typename F> bool guard(F&& f) {
  return platform::guarded([](void* p) { (*static_cast<std::remove_reference_t<F>*>(p))(); }, &f);
}
// labels the current thread for the duration of a scope
struct Busy {
  const char* prev;
  explicit Busy(const char* l) : prev(platform::current()) { platform::setCurrent(l); }
  ~Busy() { platform::setCurrent(prev); }
};
} // namespace jelly
