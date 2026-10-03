#include "FluxMedia.h"
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
#include <stdio.h>

typedef struct { int fd; int64_t written; } FileIO;
static int read_packet(void *opaque, uint8_t *buffer, int size) {
    FileIO *io = opaque;
    ssize_t n; do { n = read(io->fd, buffer, size); } while (n < 0 && errno == EINTR);
    return n > 0 ? (int)n : n == 0 ? AVERROR_EOF : AVERROR(errno);
}
static int write_packet(void *opaque, const uint8_t *buffer, int size) {
    FileIO *io = opaque;
    if (io->written + size > 6LL * 1024 * 1024 * 1024) return AVERROR(EFBIG);
    int offset = 0;
    while (offset < size) {
        ssize_t n = write(io->fd, buffer + offset, size - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return AVERROR(errno ? errno : EIO);
        offset += (int)n;
    }
    io->written += size; return size;
}
static int64_t seek_packet(void *opaque, int64_t offset, int whence) {
    FileIO *io = opaque;
    if (whence == AVSEEK_SIZE) { struct stat st; return fstat(io->fd, &st) ? AVERROR(errno) : st.st_size; }
    off_t p = lseek(io->fd, offset, whence & ~AVSEEK_FORCE);
    return p < 0 ? AVERROR(errno) : p;
}
static int deny_open(AVFormatContext *s, AVIOContext **pb, const char *url, int flags, AVDictionary **options) {
    return AVERROR(EPERM);
}
int flux_remux(const char *input, const char *output, const char *format,
               flux_interrupt interrupt, void *context, char *error, size_t error_size) {
    FileIO in = {.fd = -1}, out = {.fd = -1};
    AVFormatContext *src = NULL, *dst = NULL;
    AVIOContext *reader = NULL, *writer = NULL;
    AVPacket *packet = NULL;
    int result = AVERROR(EINVAL), header_written = 0;
    const char *stage = "input";
    av_max_alloc(128 * 1024 * 1024);
    av_log_set_level(AV_LOG_QUIET);
    in.fd = open(input, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (in.fd < 0) { result = AVERROR(errno); goto cleanup; }
    out.fd = open(output, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (out.fd < 0) { result = AVERROR(errno); goto cleanup; }
    reader = avio_alloc_context(av_malloc(65536), 65536, 0, &in, read_packet, NULL, seek_packet);
    writer = avio_alloc_context(av_malloc(65536), 65536, 1, &out, NULL, write_packet, seek_packet);
    src = avformat_alloc_context();
    if (!reader || !writer || !src) { result = AVERROR(ENOMEM); goto cleanup; }
    src->pb = reader; src->flags |= AVFMT_FLAG_CUSTOM_IO;
    src->io_open = deny_open;
    src->interrupt_callback = (AVIOInterruptCB){interrupt, context};
    src->probesize = 8 * 1024 * 1024; src->max_analyze_duration = 5 * AV_TIME_BASE;
    src->max_streams = 32;
    if ((result = avformat_open_input(&src, NULL, NULL, NULL)) < 0) goto cleanup;
    stage = "stream info";
    AVDictionary **decoder_options = av_calloc(32, sizeof(*decoder_options));
    if (!decoder_options) { result = AVERROR(ENOMEM); goto cleanup; }
    for (unsigned i = 0; i < 32; i++) av_dict_set(&decoder_options[i], "threads", "1", 0);
    result = avformat_find_stream_info(src, decoder_options);
    for (unsigned i = 0; i < 32; i++) av_dict_free(&decoder_options[i]);
    av_free(decoder_options);
    if (result < 0) goto cleanup;
    if (src->nb_streams == 0 || src->nb_streams > 32) { result = AVERROR_INVALIDDATA; goto cleanup; }
    stage = "output container";
    if ((result = avformat_alloc_output_context2(&dst, NULL, format, NULL)) < 0 || !dst) goto cleanup;
    dst->pb = writer; dst->flags |= AVFMT_FLAG_CUSTOM_IO; dst->io_open = deny_open;
    dst->interrupt_callback = src->interrupt_callback;
    for (unsigned i = 0; i < src->nb_streams; i++) {
        AVStream *s = src->streams[i];
        if (s->codecpar->codec_type != AVMEDIA_TYPE_AUDIO && s->codecpar->codec_type != AVMEDIA_TYPE_VIDEO && s->codecpar->codec_type != AVMEDIA_TYPE_SUBTITLE) {
            result = AVERROR(ENOTSUP); goto cleanup;
        }
        /* Never silently drop an unsupported track. */
        if (avformat_query_codec(dst->oformat, s->codecpar->codec_id, FF_COMPLIANCE_NORMAL) == 0) { result = AVERROR(ENOTSUP); goto cleanup; }
        AVStream *d = avformat_new_stream(dst, NULL);
        if (!d) { result = AVERROR(ENOMEM); goto cleanup; }
        if ((result = avcodec_parameters_copy(d->codecpar, s->codecpar)) < 0) goto cleanup;
        d->codecpar->codec_tag = 0; d->time_base = s->time_base;
        d->disposition = s->disposition;
        av_dict_copy(&d->metadata, s->metadata, 0);
    }
    av_dict_copy(&dst->metadata, src->metadata, 0);
    stage = "container header";
    if ((result = avformat_write_header(dst, NULL)) < 0) goto cleanup;
    header_written = 1; packet = av_packet_alloc();
    if (!packet) { result = AVERROR(ENOMEM); goto cleanup; }
    stage = "packets";
    while ((result = av_read_frame(src, packet)) >= 0) {
        if ((interrupt && interrupt(context)) || packet->size > 64 * 1024 * 1024) { result = AVERROR_EXIT; goto cleanup; }
        AVStream *s = src->streams[packet->stream_index], *d = dst->streams[packet->stream_index];
        av_packet_rescale_ts(packet, s->time_base, d->time_base); packet->pos = -1;
        result = av_interleaved_write_frame(dst, packet); av_packet_unref(packet);
        if (result < 0) goto cleanup;
    }
    if (result == AVERROR_EOF) result = av_write_trailer(dst);
    if (result >= 0 && writer->error < 0) result = writer->error;
cleanup:
    (void)header_written;
    if (result < 0 && error && error_size) {
        char reason[128]; av_strerror(result, reason, sizeof(reason));
        snprintf(error, error_size, "%s: %s", stage, reason);
    }
    av_packet_free(&packet);
    avformat_close_input(&src); avformat_free_context(dst);
    if (reader) { av_freep(&reader->buffer); avio_context_free(&reader); }
    if (writer) { av_freep(&writer->buffer); avio_context_free(&writer); }
    if (in.fd >= 0) close(in.fd);
    if (out.fd >= 0) { close(out.fd); if (result < 0) unlink(output); }
    return result;
}
