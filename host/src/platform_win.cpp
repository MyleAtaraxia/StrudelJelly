#include "platform.h"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace jelly::platform {

void init() {
  // A crash must end the process quietly so Electron can restart it, not wait on a "has stopped working" dialog.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
}

bool readStdin(void* dst, std::size_t n) {
  static HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
  auto* p = static_cast<char*>(dst);
  while (n > 0) {
    DWORD got = 0;
    if (!ReadFile(h, p, (DWORD) (n > (1u << 20) ? (1u << 20) : n), &got, nullptr) || got == 0) return false;
    p += got;
    n -= got;
  }
  return true;
}

bool writeStdout(const void* src, std::size_t n) {
  static HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  auto* p = static_cast<const char*>(src);
  while (n > 0) {
    DWORD put = 0;
    if (!WriteFile(h, p, (DWORD) n, &put, nullptr) || put == 0) return false;
    p += put;
    n -= put;
  }
  return true;
}

} // namespace jelly::platform
