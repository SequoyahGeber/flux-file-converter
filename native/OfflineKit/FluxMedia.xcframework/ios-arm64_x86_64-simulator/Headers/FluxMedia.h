#ifndef FLUX_MEDIA_H
#define FLUX_MEDIA_H
#include <stddef.h>
typedef int (*flux_interrupt)(void *context);
/* Copies compatible encoded streams. No decoding, networking, or subprocesses. */
int flux_remux(const char *input, const char *output, const char *format,
               flux_interrupt interrupt, void *context, char *error, size_t error_size);
#endif
