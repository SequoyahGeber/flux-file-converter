import Foundation
import AVFoundation
import FluxMedia

enum Media {
    static func remux(_ input: URL, output: URL, target: String, control: JobControl) throws {
        let formats = ["mkv": "matroska", "ts": "mpegts", "m4a": "mp4", "aac": "adts", "aiff": "aiff"]
        let format = formats[target] ?? target
        var error = [CChar](repeating: 0, count: 512)
        let pointer = Unmanaged.passUnretained(control).toOpaque()
        let result = flux_remux(input.path, output.path, format, { raw in
            guard let raw else { return 1 }
            return Unmanaged<JobControl>.fromOpaque(raw).takeUnretainedValue().isCancelled ? 1 : 0
        }, pointer, &error, error.count)
        try control.check()
        guard result >= 0 else {
            throw LocalError.invalid("The destination cannot store all of these tracks without re-encoding (\(String(cString: error))). Try lossy mode with MP4/MOV, or WAV/M4A for audio.")
        }
    }
    static func audio(_ input: URL, output: URL, target: String, options: ConversionOptions, control: JobControl) throws {
        try autoreleasepool { try audioImpl(input, output: output, target: target, options: options, control: control) }
    }
    static func audioImpl(_ input: URL, output: URL, target: String, options: ConversionOptions, control: JobControl) throws {
        let probe = try AVAudioFile(forReading: input)
        let description = probe.fileFormat.streamDescription.pointee
        let integerPCM = description.mFormatID == kAudioFormatLinearPCM && description.mFormatFlags & kAudioFormatFlagIsFloat == 0
        let common: AVAudioCommonFormat = integerPCM ? .pcmFormatInt32 : probe.fileFormat.commonFormat == .pcmFormatFloat64 ? .pcmFormatFloat64 : .pcmFormatFloat32
        let source = try AVAudioFile(forReading: input, commonFormat: common, interleaved: true)
        let format = source.processingFormat
        guard format.sampleRate.isFinite, format.sampleRate >= 8000, format.sampleRate <= 192000, format.channelCount > 0, format.channelCount <= 8 else { throw LocalError.invalid("Audio sample rate or channel count exceeds its safety limit.") }
        var settings: [String: Any] = [AVSampleRateKey: format.sampleRate, AVNumberOfChannelsKey: format.channelCount]
        if target == "m4a" {
            if options.lossless && !integerPCM { throw LocalError.invalid("Use WAV or CAF to preserve floating-point audio exactly, or choose lossy AAC. ALAC encoding here requires integer PCM input.") }
            settings[AVFormatIDKey] = options.lossless ? kAudioFormatAppleLossless : kAudioFormatMPEG4AAC
            if options.lossless { settings[AVEncoderBitDepthHintKey] = min(32, max(16, Int(description.mBitsPerChannel))) }
            else { settings[AVEncoderBitRateKey] = options.quality < 0.6 ? 128000 : 256000 }
        } else {
            settings[AVFormatIDKey] = kAudioFormatLinearPCM
            settings[AVLinearPCMBitDepthKey] = common == .pcmFormatFloat64 ? 64 : 32
            settings[AVLinearPCMIsFloatKey] = !integerPCM
            settings[AVLinearPCMIsBigEndianKey] = target == "aiff"
            settings[AVLinearPCMIsNonInterleaved] = false
        }
        let destination = try AVAudioFile(forWriting: output, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 32768) else { throw LocalError.unsupported }
        while source.framePosition < source.length {
            try control.check()
            try source.read(into: buffer, frameCount: AVAudioFrameCount(min(32768, source.length - source.framePosition)))
            if buffer.frameLength == 0 { break }
            try destination.write(from: buffer)
            if try LocalPolicy.fileSize(output) > 6 * 1024 * 1024 * 1024 { throw LocalError.invalid("Converted audio exceeds 6 GB.") }
        }
    }
    static func export(_ input: URL, output: URL, target: String, options: ConversionOptions, control: JobControl) async throws {
        let asset = AVURLAsset(url: input)
        let presets = AVAssetExportSession.exportPresets(compatibleWith: asset)
        let preset = target == "m4a" ? AVAssetExportPresetAppleM4A :
            options.quality < 0.6 ? AVAssetExportPresetMediumQuality : AVAssetExportPreset1920x1080
        guard presets.contains(preset), let export = AVAssetExportSession(asset: asset, presetName: preset) else { throw LocalError.unsupported }
        let type: AVFileType = target == "m4a" ? .m4a : target == "mov" ? .mov : .mp4
        guard export.supportedFileTypes.contains(type) else { throw LocalError.unsupported }
        export.outputURL = output; export.outputFileType = type; export.shouldOptimizeForNetworkUse = false
        export.exportAsynchronously(completionHandler: {})
        while export.status == .waiting || export.status == .exporting || export.status == .unknown {
            if control.isCancelled { export.cancelExport(); throw LocalError.cancelled }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard export.status == .completed else { throw export.error ?? LocalError.unsupported }
    }
    static func convert(_ input: URL, output: URL, target: String, options: ConversionOptions, control: JobControl) async throws {
        let ext = input.pathExtension.lowercased()
        if LocalFormats.audio.contains(ext), ["wav", "aiff", "caf", "m4a"].contains(target) {
            if target == "m4a", options.lossless, !["wav", "aif", "aiff", "caf"].contains(ext) {
                try remux(input, output: output, target: target, control: control)
            } else { try audio(input, output: output, target: target, options: options, control: control) }
        } else if options.lossless { try remux(input, output: output, target: target, control: control) }
        else if ["mp4", "mov", "m4a"].contains(target) { try await export(input, output: output, target: target, options: options, control: control) }
        else { throw LocalError.invalid("Lossy media encoding on this device supports MP4, MOV and M4A. Choose lossless mode for other containers.") }
    }
}
