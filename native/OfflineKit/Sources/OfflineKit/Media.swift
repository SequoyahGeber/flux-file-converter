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
        let integerAudio = integerPCM || description.mFormatID == kAudioFormatAppleLossless || description.mFormatID == kAudioFormatFLAC
        let common: AVAudioCommonFormat = integerAudio ? .pcmFormatInt32 : probe.fileFormat.commonFormat == .pcmFormatFloat64 ? .pcmFormatFloat64 : .pcmFormatFloat32
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
            settings[AVLinearPCMIsFloatKey] = !integerAudio
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
        let preset = target == "m4a" ? AVAssetExportPresetAppleM4A :
            options.quality < 0.6 ? AVAssetExportPresetMediumQuality : AVAssetExportPreset1920x1080
        let type: AVFileType = target == "m4a" ? .m4a : target == "mov" ? .mov : .mp4
        try await export(AVURLAsset(url: input), preset: preset, type: type, output: output, control: control)
    }
    static func export(_ asset: AVAsset, preset: String, type: AVFileType, output: URL, control: JobControl) async throws {
        let presets = AVAssetExportSession.exportPresets(compatibleWith: asset)
        guard presets.contains(preset), let export = AVAssetExportSession(asset: asset, presetName: preset) else { throw LocalError.unsupported }
        guard export.supportedFileTypes.contains(type) else { throw LocalError.unsupported }
        export.outputURL = output; export.outputFileType = type; export.shouldOptimizeForNetworkUse = false
        export.exportAsynchronously(completionHandler: {})
        do {
            while export.status == .waiting || export.status == .exporting || export.status == .unknown {
                if control.isCancelled { export.cancelExport() }
                // Wait for the exporter to stop before removing its working folder.
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        } catch {
            export.cancelExport()
            while export.status == .waiting || export.status == .exporting || export.status == .unknown {
                await Task.detached { try? await Task.sleep(nanoseconds: 100_000_000) }.value
            }
            throw error
        }
        try control.check()
        guard export.status == .completed else { throw export.error ?? LocalError.unsupported }
    }
    /// Video to an audio format keeps only the sound (FX-A-05). M4A copies the encoded audio samples unchanged in
    /// lossless mode (reader and writer with no settings) or re-encodes them as AAC; WAV, AIFF and CAF decode to
    /// 32-bit integer PCM. The video track is never written.
    static func videoAudio(_ input: URL, output: URL, target: String, options: ConversionOptions, control: JobControl) async throws {
        let asset = AVURLAsset(url: input)
        guard let track = try? await asset.loadTracks(withMediaType: .audio).first else {
            throw LocalError.invalid("This video has no audio track that this device can read.")
        }
        try control.check()
        if target == "m4a", !options.lossless {
            let composition = AVMutableComposition()
            guard let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw LocalError.unsupported }
            try audio.insertTimeRange(try await track.load(.timeRange), of: track, at: .zero)
            try await export(composition, preset: AVAssetExportPresetAppleM4A, type: .m4a, output: output, control: control)
            return
        }
        guard let description = try await track.load(.formatDescriptions).first,
              let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { throw LocalError.unsupported }
        guard basic.mSampleRate.isFinite, basic.mSampleRate >= 8000, basic.mSampleRate <= 192000, basic.mChannelsPerFrame > 0, basic.mChannelsPerFrame <= 8 else {
            throw LocalError.invalid("Audio sample rate or channel count exceeds its safety limit.")
        }
        // Lossless M4A copies the encoded samples unchanged (nil settings on both sides); the others decode to PCM.
        let copy = target == "m4a"
        var settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: false,
                                       AVLinearPCMIsBigEndianKey: target == "aiff", AVLinearPCMIsNonInterleaved: false]
        let reader = try AVAssetReader(asset: asset)
        let source = AVAssetReaderTrackOutput(track: track, outputSettings: copy ? nil : settings)
        guard reader.canAdd(source) else { throw LocalError.unsupported }
        reader.add(source)
        settings[AVSampleRateKey] = basic.mSampleRate; settings[AVNumberOfChannelsKey] = Int(basic.mChannelsPerFrame)
        var layoutSize = 0
        if let layout = CMAudioFormatDescriptionGetChannelLayout(description, sizeOut: &layoutSize), layoutSize > 0 {
            settings[AVChannelLayoutKey] = Data(bytes: layout, count: layoutSize)
        }
        let type: AVFileType = copy ? .m4a : target == "wav" ? .wav : target == "aiff" ? .aiff : .caf
        let writer = try AVAssetWriter(outputURL: output, fileType: type)
        let sink = AVAssetWriterInput(mediaType: .audio, outputSettings: copy ? nil : settings, sourceFormatHint: copy ? description : nil)
        guard writer.canAdd(sink) else {
            if copy { throw LocalError.invalid("This video’s audio can’t be copied into M4A unchanged. Turn off Lossless to convert it to AAC, or choose WAV.") }
            throw LocalError.unsupported
        }
        writer.add(sink)
        guard reader.startReading() else { throw reader.error ?? LocalError.unsupported }
        guard writer.startWriting() else { reader.cancelReading(); throw writer.error ?? LocalError.unsupported }
        do {
            var started = false, appended = 0
            while let buffer = source.copyNextSampleBuffer() {
                try control.check()
                if !started { writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(buffer)); started = true }
                while !sink.isReadyForMoreMediaData { try control.check(); try await Task.sleep(nanoseconds: 10_000_000) }
                guard sink.append(buffer) else { throw writer.error ?? LocalError.unsupported }
                appended += 1
                if appended % 64 == 0, ((try? LocalPolicy.fileSize(output)) ?? 0) > 6 * 1024 * 1024 * 1024 { throw LocalError.invalid("Converted audio exceeds 6 GB.") }
            }
            try control.check()
            guard reader.status == .completed, started else { throw reader.error ?? LocalError.invalid("This video’s audio track could not be read.") }
            sink.markAsFinished()
            await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error ?? LocalError.unsupported }
        } catch {
            reader.cancelReading(); writer.cancelWriting(); throw error
        }
    }
    static func convert(_ input: URL, output: URL, target: String, options: ConversionOptions, control: JobControl) async throws {
        let ext = input.pathExtension.lowercased()
        if LocalFormats.video.contains(ext), ["m4a", "wav", "aiff", "caf"].contains(target) {
            try await videoAudio(input, output: output, target: target, options: options, control: control)
        } else if LocalFormats.audio.contains(ext), ["wav", "aiff", "caf", "m4a"].contains(target) {
            if target == "m4a", options.lossless, !["wav", "aif", "aiff", "caf"].contains(ext) {
                try remux(input, output: output, target: target, control: control)
            } else { try audio(input, output: output, target: target, options: options, control: control) }
        } else if options.lossless { try remux(input, output: output, target: target, control: control) }
        else if ["mp4", "mov", "m4a"].contains(target) { try await export(input, output: output, target: target, options: options, control: control) }
        else { throw LocalError.invalid("Lossy media encoding on this device supports MP4, MOV and M4A. Choose lossless mode for other containers.") }
    }
}
