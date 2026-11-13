#include "platform.h"
#include <csetjmp>
#include <csignal>
#include <cstring>
#include <unistd.h>

namespace jelly::platform {

static thread_local const char* busy = nullptr;
static thread_local sigjmp_buf* jump = nullptr;
void setCurrent(const char* label) { busy = label; }
const char* current() { return busy; }

static void onFault(int sig) {
  if (jump) siglongjmp(*jump, 1);
  const char* head = "JELLY-CRASH-IN: ";
  (void) !::write(2, head, strlen(head));
  if (busy) (void) !::write(2, busy, strlen(busy));
  (void) !::write(2, "\n", 1);
  std::signal(sig, SIG_DFL);
  std::raise(sig);
}

void init() {
  std::signal(SIGPIPE, SIG_IGN);
  for (int s : { SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT }) std::signal(s, onFault);
}

bool guarded(void (*fn)(void*), void* ctx) {
  sigjmp_buf here;
  sigjmp_buf* prev = jump;
  if (sigsetjmp(here, 1)) {
    jump = prev;
    return false;
  }
  jump = &here;
  try {
    fn(ctx);
  } catch (...) {
    jump = prev;
    return false;
  }
  jump = prev;
  return true;
}

bool readStdin(void* dst, std::size_t n) {
  auto* p = static_cast<char*>(dst);
  while (n > 0) {
    ssize_t got = ::read(0, p, n);
    if (got <= 0) return false;
    p += got;
    n -= (std::size_t) got;
  }
  return true;
}

bool writeStdout(const void* src, std::size_t n) {
  auto* p = static_cast<const char*>(src);
  while (n > 0) {
    ssize_t put = ::write(1, p, n);
    if (put <= 0) return false;
    p += put;
    n -= (std::size_t) put;
  }
  return true;
}

} // namespace jelly::platform
