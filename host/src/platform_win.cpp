#include "platform.h"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstring>
#include <malloc.h>

namespace jelly::platform {

static thread_local const char* busy = nullptr;
void setCurrent(const char* label) { busy = label; }
const char* current() { return busy; }

static LONG WINAPI onCrash(EXCEPTION_POINTERS*) {
  const HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  char line[512] = "JELLY-CRASH-IN: ";
  const char* l = busy ? busy : "";
  strncat_s(line, sizeof line, l, _TRUNCATE);
  strncat_s(line, sizeof line, "\n", _TRUNCATE);
  DWORD put = 0;
  WriteFile(err, line, (DWORD) strlen(line), &put, nullptr);
  return EXCEPTION_EXECUTE_HANDLER; // end the process quietly
}

void init() {
  // A crash must end the process quietly so Electron can restart it, not wait on a "has stopped working" dialog.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  SetUnhandledExceptionFilter(onCrash);
}

static int filter(unsigned code) {
  // a debugger breakpoint is not a crash
  return code == EXCEPTION_BREAKPOINT ? EXCEPTION_CONTINUE_SEARCH : EXCEPTION_EXECUTE_HANDLER;
}

bool guarded(void (*fn)(void*), void* ctx) {
  __try {
    fn(ctx);
    return true;
  } __except (filter(GetExceptionCode())) {
    if (GetExceptionCode() == EXCEPTION_STACK_OVERFLOW) _resetstkoflw();
    return false;
  }
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
