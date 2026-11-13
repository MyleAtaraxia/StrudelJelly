// Everything OS-specific lives behind this header: platform_win.cpp (Win32) or platform_posix.cpp (Linux/macOS).
#pragma once
#include <cstddef>

namespace jelly::platform {
void init();                                  // binary stdio, no crash dialogs
bool readStdin(void* dst, std::size_t n);     // blocks until n bytes arrived; false on EOF or error
bool writeStdout(const void* src, std::size_t n);
} // namespace jelly::platform
