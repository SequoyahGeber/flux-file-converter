// SHARED-EXPERIENCE: ios-navigation | standard: PROJECT_STANDARDS.md §iOS navigation | local implementation; changes must be mirrored in every app listed there
import SwiftUI
import UniformTypeIdentifiers
import OfflineKit
import SharedDesign
import SharedFeedback
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct LocalView: View {
    @StateObject private var model = LocalModel()
    @State private var importing = false
    @State private var showingFormats = false
    @State private var showingSettings = false
    @State private var confirmingClear = false
    @AppStorage(FluxSettings.Key.appearanceMode) private var appearance = AppearanceMode.system.rawValue
    #if os(iOS)
    @State private var exportFile: ExportFile?
    #endif
    @State private var saving = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The app mark's tile grows with its symbol at large text sizes; 56 points at the default size (FX-B-15).
    @ScaledMetric(relativeTo: .title) private var markSize: CGFloat = 56

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: FluxSpace.section) {
                    HStack(spacing: FluxSpace.item) {
                        Image(symbol: FluxIcon.appMark).font(FluxType.badge).foregroundStyle(.white)
                            .frame(width: markSize, height: markSize).background(FluxColor.accent.gradient, in: RoundedRectangle(cornerRadius: FluxRadius.badge))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: FluxSpace.titleLines) {
                            Text("Convert. Keep it local.").font(.title2.bold())
                            Label("On-device · No uploads · No login", symbol: FluxIcon.onDevice).font(.caption).foregroundStyle(FluxPalette.caption.color)
                        }
                    }
                    VStack(alignment: .leading, spacing: FluxSpace.item) {
                        Button { importing = true } label: {
                            Label(model.inputs.isEmpty ? "Choose files" : "Choose different files", symbol: FluxIcon.chooseFiles)
                                .frame(maxWidth: .infinity).padding(.vertical, 12)
                        }.buttonStyle(.borderedProminent).tint(FluxColor.accent).disabled(model.busy || saving).accessibilityIdentifier(AccessibilityID.Converter.chooseFiles)
                        if model.inputs.isEmpty {
                            Text("Convert an image, video, audio file or document. Select several files to make a ZIP.")
                                .font(.callout).foregroundStyle(FluxPalette.caption.color)
                            Menu {
                                ForEach(ReviewResources.samples, id: \.id) { sample in
                                    Button(sample.title) { model.selectSample(sample) }.accessibilityIdentifier(AccessibilityID.Converter.sample(sample.id))
                                }
                            } label: {
                                Label("Explore a sample file", symbol: FluxIcon.sample)
                                    .frame(minHeight: 44).contentShape(Rectangle())
                            }
                                .tint(FluxColor.link).accessibilityIdentifier(AccessibilityID.Converter.trySample).disabled(model.busy || saving)
                            Text("Fictional files included with Flux. Uses the same conversion and save flow.")
                                .font(.caption).foregroundStyle(FluxPalette.caption.color)
                        } else {
                            ForEach(Array(model.inputs.prefix(5).enumerated()), id: \.offset) { _, url in
                                Label(url.lastPathComponent, symbol: FluxIcon.file).font(.callout).lineLimit(2).truncationMode(.middle)
                            }
                            if model.inputs.count > 5 { Text("and \(model.inputs.count - 5) more files").font(.caption).foregroundStyle(FluxPalette.caption.color) }
                        }
                    }.padding(FluxSpace.card).background(FluxColor.card, in: RoundedRectangle(cornerRadius: FluxRadius.card))
                    if !model.inputs.isEmpty {
                        VStack(alignment: .leading, spacing: FluxSpace.l) {
                            VStack(alignment: .leading, spacing: FluxSpace.label) {
                                Text("Convert to").font(.caption.bold()).foregroundStyle(FluxPalette.caption.color).accessibilityHidden(true)
                                Picker("Convert to", selection: $model.target) {
                                    ForEach(model.formats, id: \.self) { format in Text(format == "unzip" ? "Extract archive" : ["txt", "md"].contains(format) && !["txt", "md"].contains(model.source) && LocalFormats.documents.contains(model.source) ? format.uppercased() + " · Extract text" : format.uppercased()).tag(format) }
                                }.pickerStyle(.menu).tint(FluxColor.link).accessibilityIdentifier(AccessibilityID.Converter.outputFormat)
                            }
                            VStack(alignment: .leading, spacing: FluxSpace.label) {
                                Text(model.target == "unzip" ? "Folder name" : "Output file name").font(.caption.bold()).foregroundStyle(FluxPalette.caption.color).accessibilityHidden(true)
                                TextField("Converted", text: $model.filename).textFieldStyle(.roundedBorder).accessibilityIdentifier(AccessibilityID.Converter.outputName)
                                    .accessibilityLabel(model.target == "unzip" ? "Folder name" : "Output file name")
                            }
                            if model.media && model.target != "zip" {
                                Toggle("Lossless / preserve quality", isOn: $model.options.lossless)
                                Text(model.options.lossless ? "Compatible streams are copied; PCM/ALAC audio is decoded and stored without lossy compression." : "Apple media encoding: MP4, MOV or M4A.")
                                    .font(.caption).foregroundStyle(FluxPalette.caption.color)
                            }
                            if model.target == "zip" { Toggle("Compress ZIP contents", isOn: $model.options.compressArchive) }
                            if ["jpg", "heic"].contains(model.target) || (model.media && !model.options.lossless) || (model.source == "pdf" && model.target == "pdf") {
                                VStack(alignment: .leading) {
                                    // The slider speaks its own name and value (FX-B-15).
                                    Text("Quality: \(Int(model.options.quality * 100))%").font(.caption).accessibilityHidden(true)
                                    Slider(value: $model.options.quality, in: 0.2...1)
                                        .accessibilityLabel("Quality")
                                        .accessibilityValue("\(Int(model.options.quality * 100)) percent")
                                }
                            }
                            Text(LocalFormats.note(source: model.source, target: model.target, lossless: model.options.lossless)).font(.caption).foregroundStyle(FluxPalette.caption.color).fixedSize(horizontal: false, vertical: true)
                        }.disabled(model.busy || saving).padding(FluxSpace.card).background(FluxColor.card, in: RoundedRectangle(cornerRadius: FluxRadius.card))
                        if model.busy {
                            // At accessibility text sizes the status and Cancel stack instead of sharing a row (FX-B-15).
                            (dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading)) : AnyLayout(HStackLayout())) {
                                ProgressView(); Text(model.message); Spacer()
                                Button(role: .cancel) { model.cancel() } label: {
                                    Text("Cancel").frame(minHeight: 44).contentShape(Rectangle())
                                }
                            }
                        } else {
                            Button { model.convert() } label: { Label("Convert", symbol: FluxIcon.convert).frame(maxWidth: .infinity).padding(.vertical, 10) }
                                .buttonStyle(.borderedProminent).tint(FluxColor.accent).disabled(saving).accessibilityIdentifier(AccessibilityID.Converter.convert)
                        }
                    }
                    if let result = model.result {
                        VStack(alignment: .leading, spacing: FluxSpace.m) {
                            Label(model.message, symbol: FluxIcon.success).foregroundStyle(FluxColor.successText)
                            Text(result.url.lastPathComponent).font(.callout).textSelection(.enabled)
                            Button { save(result) } label: { Label(saving ? "Saving…" : "Save as…", symbol: FluxIcon.save).frame(maxWidth: .infinity).padding(.vertical, 10) }
                                .buttonStyle(.borderedProminent).tint(FluxColor.accent).disabled(saving || model.busy).accessibilityIdentifier(AccessibilityID.Converter.save)
                            Text("Choose the destination in Files or the save dialog. The original file is kept.").font(.caption).foregroundStyle(FluxPalette.caption.color)
                        }.padding(FluxSpace.card).background(FluxColor.successBackground, in: RoundedRectangle(cornerRadius: FluxRadius.card))
                            .id(Outcome.result)
                    }
                    if !model.error.isEmpty { Label(model.error, symbol: FluxIcon.errorLine).foregroundStyle(FluxColor.failureText).font(.callout).textSelection(.enabled).id(Outcome.error) }
                    // A stop the person chose (or leaving Flux) is a plain status, not an error (FX-B-04).
                    if !model.notice.isEmpty { Label(model.notice, symbol: FluxIcon.info).font(.callout).id(Outcome.notice).accessibilityIdentifier(AccessibilityID.Converter.notice) }
                    VStack(alignment: .leading, spacing: 0) {
                        Button { showingFormats = true } label: {
                            Text("Supported conversions").frame(minHeight: 44).contentShape(Rectangle())
                        }.tint(FluxColor.link).accessibilityIdentifier(AccessibilityID.Converter.supportedConversions)
                        if !model.inputs.isEmpty {
                            Button(role: .destructive) {
                                // Confirm only when an unsaved result would be deleted (D-023).
                                if model.result != nil && !model.resultSaved { confirmingClear = true } else { model.clear() }
                            } label: {
                                Text("Clear").foregroundStyle(FluxColor.failureText).frame(minHeight: 44).contentShape(Rectangle())
                            }.disabled(model.busy || saving).accessibilityIdentifier(AccessibilityID.Converter.clear)
                        }
                    }.font(.callout)
                    VStack(alignment: .leading, spacing: FluxSpace.label) {
                        Text("5 GB media · 512 MB other files · One conversion at a time")
                        Text("Keep Flux open while converting. Temporary working files are cleared when you clear the job or reopen Flux.")
                    }.font(.caption).foregroundStyle(FluxPalette.caption.color).fixedSize(horizontal: false, vertical: true)
                }.padding(FluxSpace.xxl).frame(maxWidth: 700)
                    .frame(maxWidth: .infinity)
            }.accessibilityIdentifier(AccessibilityID.Converter.workspace).navigationTitle("Flux")
            // The outcome appears below Convert, often off screen: bring it into view (FX-B-05).
            .onChange(of: model.result?.url) { if model.result != nil { reveal(Outcome.result, proxy) } }
            .onChange(of: model.error) { if !model.error.isEmpty { reveal(Outcome.error, proxy) } }
            .onChange(of: model.notice) { if !model.notice.isEmpty { reveal(Outcome.notice, proxy) } }
            }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    // SharedKit's in-context button (id feedback.button, exclamationmark.bubble).
                    FeedbackButton(center: FluxFeedback.center)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingSettings = true } label: { Image(symbol: FluxIcon.settings) }
                        .accessibilityLabel("Settings").accessibilityIdentifier(AccessibilityID.Settings.open)
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView().feedbackHost(FluxFeedback.center) }
            .feedbackHost(FluxFeedback.center)
            #endif
            .confirmationDialog("Delete the unsaved result?", isPresented: $confirmingClear, titleVisibility: .visible) {
                Button("Delete result", role: .destructive) { model.clear() }
                    .accessibilityIdentifier(AccessibilityID.Converter.clearConfirm)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("“\(model.result?.url.lastPathComponent ?? "")” hasn’t been saved. Your original files are kept.")
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result { case .success(let urls): model.select(urls); case .failure(let error): model.error = error.localizedDescription }
            }
            .sheet(isPresented: $showingFormats) { FormatView() }
            .onChange(of: model.target) { model.configurationChanged() }
            .onChange(of: model.options) { model.configurationChanged() }
            .onChange(of: scenePhase) {
                guard scenePhase == .background, model.busy else { return }
                #if os(iOS)
                model.enteredBackground()
                #else
                model.cancel(.background)
                #endif
            }
            // Status and errors change without moving focus; announce them to VoiceOver.
            .onChange(of: model.message) { if !model.message.isEmpty { AccessibilityNotification.Announcement(model.message).post() } }
            .onChange(of: model.error) { if !model.error.isEmpty { AccessibilityNotification.Announcement(model.error).post() } }
            .onChange(of: model.notice) { if !model.notice.isEmpty { AccessibilityNotification.Announcement(model.notice).post() } }
            #if os(iOS)
            .sheet(item: $exportFile, onDismiss: { saving = false }) { file in
                ExportPicker(url: file.url) { success in
                    if success { model.message = "Saved to Files."; model.resultSaved = true }; saving = false; exportFile = nil
                }.ignoresSafeArea()
            }
            #endif
        }
        .preferredColorScheme((AppearanceMode(rawValue: appearance) ?? .system).colorScheme)
        .task { if LaunchFlags.demo && model.inputs.isEmpty, let sample = ReviewResources.samples.first { model.selectSample(sample) } }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 580)
        #endif
    }
    private enum Outcome: Hashable { case result, error, notice }
    /// Scrolls after the new card has been laid out; no animation with Reduce Motion.
    private func reveal(_ outcome: Outcome, _ proxy: ScrollViewProxy) {
        Task { @MainActor in
            await Task.yield()
            withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo(outcome, anchor: .center) }
        }
    }
    private func save(_ result: LocalResult) {
        saving = true
        Task {
            do { let renamed = try await model.renameResult(); presentSave(renamed) }
            catch { model.error = error.localizedDescription; saving = false }
        }
    }
    private func presentSave(_ result: LocalResult) {
        #if os(macOS)
        if result.isDirectory {
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true; panel.prompt = "Save here"
            panel.begin { response in
                guard response == .OK, let parent = panel.url else { saving = false; return }
                let scoped = parent.startAccessingSecurityScopedResource(); saving = true
                let destination = parent.appendingPathComponent(result.url.lastPathComponent)
                Task {
                    do {
                        try await Task.detached {
                            guard !FileManager.default.fileExists(atPath: destination.path) else { throw LocalError.invalid("A folder with this name already exists. Choose another location.") }
                            try SafeSave.commit(result.url, to: destination, replaceExisting: false)
                        }.value
                        model.message = "Saved to \(parent.lastPathComponent)."; model.resultSaved = true
                    } catch { model.error = error.localizedDescription }
                    if scoped { parent.stopAccessingSecurityScopedResource() }; saving = false
                }
            }
        } else {
            let panel = NSSavePanel(); panel.nameFieldStringValue = result.url.lastPathComponent; panel.canCreateDirectories = true
            panel.allowedContentTypes = [UTType(filenameExtension: result.url.pathExtension) ?? .data]
            panel.begin { response in
                guard response == .OK, let destination = panel.url else { saving = false; return }
                let scoped = destination.startAccessingSecurityScopedResource(); saving = true
                Task {
                    do { try await Task.detached { try SafeSave.commit(result.url, to: destination) }.value; model.message = "Saved \(destination.lastPathComponent)."; model.resultSaved = true }
                    catch { model.error = error.localizedDescription }
                    if scoped { destination.stopAccessingSecurityScopedResource() }; saving = false
                }
            }
        }
        #else
        exportFile = ExportFile(url: result.url)
        #endif
    }
}

private struct FormatView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("Images") { Text("\(LocalFormats.images.joined(separator: ", ")) → \(LocalFormats.imageOutputs.joined(separator: ", ")), PDF. Available codecs depend on this device. First frame only; up to 24 megapixels.") }
                Section("PDF") { Text("PDF → first-page image, extracted TXT, or a compressed PDF (rasterized, losing editable text/forms). Up to 200 pages.") }
                Section("Video & audio") { Text("\(LocalFormats.video.joined(separator: ", ")); \(LocalFormats.audio.joined(separator: ", ")). Lossless remux into MP4/MOV/MKV/WebM/AVI/TS/OGG/FLAC/MP3/AAC when every codec fits the destination. Apple audio codecs can produce WAV/AIFF/CAF/ALAC/AAC. Lossy Apple export supports MP4/MOV/M4A when the input codec is supported.") }
                Section("Documents") { Text("DOCX → PDF/HTML with supported fonts, emphasis, text colors, basic tables and embedded images. RTF → styled PDF/HTML. DOCX → styled RTF if it contains no images/tables. Complex unsupported layouts report an error; pagination may differ. TXT/MD extraction is separate. ODT/EPUB/HTML currently support text extraction only. Plain text can create DOCX/ODT/EPUB/RTF/HTML/PDF. EPUB extraction uses chapter filename order. Text limit: 16 MB.") }
                Section("Data & subtitles") { Text("JSON, YAML, CSV, TSV convert between those formats. CSV/TSV need an array of records; YAML aliases are rejected. SRT ↔ VTT or TXT (basic cues).") }
                Section("ZIP") { Text("Any regular file type → ZIP, including several files at once. ZIP → folder. ZIP extraction rejects links and unsafe paths; up to 2,000 entries, 1 GB expanded and 200× expansion.") }
                Section("More formats") { Text("This local beta does not include the desktop Electron app’s LibreOffice, Blender, Calibre or Python engines. Unsupported files can still be zipped. No conversion connects to Unraid or uploads files.") }
            }.navigationTitle("Supported conversions")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier(AccessibilityID.Formats.done) } }
        }
        .presentationDetents([.medium, .large])
        #if os(macOS)
        .frame(width: 580, height: 580)
        #endif
    }
}

#if os(iOS)
// The file and presentation are one state change, so the first sheet cannot
// capture an unset URL and leave a blank, disabled save screen.
private struct ExportFile: Identifiable {
    let id = UUID()
    let url: URL
}

private struct ExportPicker: UIViewControllerRepresentable {
    let url: URL, completion: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = context.coordinator; return picker
    }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let completion: (Bool) -> Void
        init(_ completion: @escaping (Bool) -> Void) { self.completion = completion }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { completion(!urls.isEmpty) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { completion(false) }
    }
}
#endif
