#include "platform.h"
#include <csignal>
#include <unistd.h>

namespace jelly::platform {

void init() { std::signal(SIGPIPE, SIG_IGN); }

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
