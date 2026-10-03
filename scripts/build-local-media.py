#!/usr/bin/env python3
"""Rebuild the pinned, protocol-free LGPL FFmpeg remux library for Apple platforms."""
import concurrent.futures
import hashlib
import os
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = pathlib.Path('/tmp/flux-local-media-9.0.2-r2').resolve()
SHA = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'
ENV = dict(os.environ, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')

def run(args, **kwargs):
    return subprocess.check_output(args, env=ENV, **kwargs)

def build(spec):
    name, sdk, arch, target = spec
    directory = CACHE / name
    directory.mkdir(parents=True, exist_ok=True)
    prefix = directory / 'install'
    if not (prefix / 'lib/libavformat.a').exists():
        sdkpath = run(['xcrun', '--sdk', sdk, '--show-sdk-path'], text=True).strip()
        cc = run(['xcrun', '--sdk', sdk, '--find', 'clang'], text=True).strip()
        args = [str(CACHE / 'ffmpeg-9.0.2/configure'), '--prefix=' + str(prefix),
                '--arch=' + arch, '--target-os=darwin', '--enable-cross-compile', '--cc=' + cc,
                '--sysroot=' + sdkpath, '--extra-cflags=-target ' + target,
                '--extra-ldflags=-target ' + target, '--disable-everything', '--disable-programs',
                '--disable-doc', '--disable-debug', '--disable-network', '--disable-protocols',
                '--disable-autodetect', '--disable-asm', '--disable-shared', '--enable-static',
                '--disable-avdevice', '--disable-avfilter', '--disable-swscale', '--disable-swresample',
                '--enable-avformat', '--enable-avcodec', '--enable-avutil',
                '--enable-demuxer=mov,matroska,ogg,mp3,flac,wav,aiff,avi,mpegts,flv,mpegps,aac,ac3,asf',
                '--enable-muxer=mp4,mov,matroska,webm,mpegts,avi,ogg,flac,wav,aiff,adts,mp3',
                '--enable-parser=h264,hevc,aac,opus,vorbis,mpegaudio,flac,av1,vp9,ac3',
                '--enable-decoder=h264,hevc,aac,mp3,flac,opus,vorbis,vp9',
                '--enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,vp9_superframe',
                '--enable-pthreads']
        with (directory / 'build.log').open('w') as log:
            subprocess.run(args, cwd=directory, env=ENV, stdout=log, stderr=subprocess.STDOUT, check=True)
            subprocess.run(['make', '-j2'], cwd=directory, env=ENV, stdout=log, stderr=subprocess.STDOUT, check=True)
            subprocess.run(['make', 'install'], cwd=directory, env=ENV, stdout=log, stderr=subprocess.STDOUT, check=True)
    framework = directory / 'FluxMedia.framework'
    headers = framework / 'Headers'
    headers.mkdir(parents=True, exist_ok=True)
    shutil.copy(ROOT / 'native/Media/FluxMedia.h', headers)
    modules = framework / 'Modules'
    modules.mkdir(exist_ok=True)
    (modules / 'module.modulemap').write_text('framework module FluxMedia { umbrella header "FluxMedia.h" export * }\n')
    obj = directory / 'FluxMedia.o'
    run(['xcrun', '--sdk', sdk, 'clang', '-target', target, '-isysroot',
         run(['xcrun', '--sdk', sdk, '--show-sdk-path'], text=True).strip(), '-O2', '-I' + str(prefix / 'include'),
         '-c', str(ROOT / 'native/Media/FluxMedia.c'), '-o', str(obj)])
    run(['xcrun', 'libtool', '-static', '-o', str(framework / 'FluxMedia'), str(obj)] +
        [str(prefix / ('lib/' + lib + '.a')) for lib in ['libavformat', 'libavcodec', 'libavutil']])
    import plistlib
    (framework / 'Info.plist').write_bytes(plistlib.dumps(dict(CFBundleIdentifier='com.sequoyah.flux.media',
        CFBundleName='FluxMedia', CFBundleExecutable='FluxMedia', CFBundlePackageType='FMWK', CFBundleVersion='9.0.2',
        CFBundleShortVersionString='9.0.2', MinimumOSVersion='14.0' if sdk == 'macosx' else '18.4')))
    print('Built ' + name, flush=True)
    return framework

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    tar = CACHE / 'ffmpeg-9.0.2.tar.xz'
    if not tar.exists():
        urllib.request.urlretrieve('https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz', tar)
    if hashlib.sha256(tar.read_bytes()).hexdigest() != SHA:
        raise SystemExit('FFmpeg source checksum differs from the reviewed release.')
    if not (CACHE / 'ffmpeg-9.0.2/configure').exists():
        with tarfile.open(tar) as archive:
            for member in archive.getmembers():
                if not (CACHE / member.name).resolve().is_relative_to(CACHE) or member.issym() or member.islnk():
                    raise SystemExit('Unexpected path or link in pinned source archive.')
            archive.extractall(CACHE)
    specs = [('mac-arm', 'macosx', 'arm64', 'arm64-apple-macos14.0'),
             ('mac-intel', 'macosx', 'x86_64', 'x86_64-apple-macos14.0'),
             ('ios', 'iphoneos', 'arm64', 'arm64-apple-ios18.4'),
             ('sim-arm', 'iphonesimulator', 'arm64', 'arm64-apple-ios18.4-simulator'),
             ('sim-intel', 'iphonesimulator', 'x86_64', 'x86_64-apple-ios18.4-simulator')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        frameworks = list(pool.map(build, specs))
    universal = []
    for name, pair in [('mac', frameworks[:2]), ('sim', frameworks[3:])]:
        dst = CACHE / name / 'FluxMedia.framework'
        shutil.copytree(pair[0], dst, dirs_exist_ok=True)
        run(['xcrun', 'lipo', '-create', str(pair[0] / 'FluxMedia'), str(pair[1] / 'FluxMedia'), '-output', str(dst / 'FluxMedia')])
        universal.append(dst)
    output = ROOT / 'native/OfflineKit/FluxMedia.xcframework'
    if output.exists(): shutil.rmtree(output)
    args = ['xcodebuild', '-create-xcframework']
    for item in [universal[0], frameworks[2], universal[1]]:
        library = item.parent / 'libFluxMedia.a'
        shutil.copy(item / 'FluxMedia', library)
        (item / 'Headers/module.modulemap').write_text('module FluxMedia { header "FluxMedia.h" export * }\n')
        args += ['-library', str(library), '-headers', str(item / 'Headers')]
    run(args + ['-output', str(output)])
    print('Created ' + str(output), flush=True)

if __name__ == '__main__': main()
