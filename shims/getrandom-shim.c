/*
 * getrandom() shim for old kernels (< 3.17) that lack the syscall.
 *
 * musl libc calls getrandom() which returns ENOSYS on kernel 3.10.x
 * (e.g. Synology DS1513+). This shim intercepts the call and falls
 * back to /dev/urandom, which is cryptographically secure after boot
 * and is the same entropy source getrandom() reads from on modern kernels.
 *
 * Usage: LD_PRELOAD=/usr/lib/libgetrandom-shim.so <command>
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_getrandom
#  ifdef __x86_64__
#    define SYS_getrandom 318
#  elif defined(__aarch64__)
#    define SYS_getrandom 278
#  else
#    error "Unsupported architecture"
#  endif
#endif

ssize_t getrandom(void *buf, size_t buflen, unsigned int flags) {
    /* Try the real syscall first */
    long ret = syscall(SYS_getrandom, buf, buflen, flags);
    if (ret >= 0 || errno != ENOSYS)
        return (ssize_t)ret;

    /* Kernel too old — fall back to /dev/urandom */
    int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return -1;

    ssize_t total = 0;
    while ((size_t)total < buflen) {
        ssize_t n = read(fd, (char *)buf + total, buflen - (size_t)total);
        if (n <= 0) {
            if (n < 0 && errno == EINTR)
                continue;
            close(fd);
            return -1;
        }
        total += n;
    }

    close(fd);
    return total;
}
