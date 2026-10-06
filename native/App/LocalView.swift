import SwiftUI
import UniformTypeIdentifiers
import OfflineKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct LocalView: View {
    @StateObject private var model = LocalModel()
    @State private var importing = false
    @State private var showingFormats = false
    @State private var showingPrivacy = false
    #if os(iOS)
    @State private var exportFile: ExportFile?
    #endif
    @State private var saving = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(spacing: 14) {
                        Image(systemName: "arrow.left.arrow.right").font(.title).foregroundStyle(.white)
                            .frame(width: 56, height: 56).background(.purple.gradient, in: RoundedRectangle(cornerRadius: 15))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Convert. Keep it local.").font(.title2.bold())
                            Label("On-device · No uploads · No login", systemImage: "lock.shield").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        Button { importing = true } label: {
                            Label(model.inputs.isEmpty ? "Choose files" : "Choose different files", systemImage: "plus.circle.fill")
                                .frame(maxWidth: .infinity).padding(.vertical, 12)
                        }.buttonStyle(.borderedProminent).tint(.purple).disabled(model.busy || saving).accessibilityIdentifier("choose-files")
                        if model.inputs.isEmpty {
                            Text("Convert an image, video, audio file or document. Select several files to make a ZIP.")
                                .font(.callout).foregroundStyle(.secondary)
                            Menu {
                                ForEach(ReviewResources.samples, id: \.id) { sample in
                                    Button(sample.title) { model.selectSample(sample) }.accessibilityIdentifier("sample-" + sample.id)
                                }
                            } label: { Label("Try a sample", systemImage: "sparkles") }
                                .accessibilityIdentifier("try-sample").disabled(model.busy || saving)
                            Text("Fictional files included with Flux. Uses the same conversion and save flow.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(model.inputs.prefix(5).enumerated()), id: \.offset) { _, url in
                                Label(url.lastPathComponent, systemImage: "doc").font(.callout).lineLimit(2)
                            }
                            if model.inputs.count > 5 { Text("and \(model.inputs.count - 5) more files").font(.caption).foregroundStyle(.secondary) }
                        }
                    }.padding(18).background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
                    if !model.inputs.isEmpty {
                        VStack(alignment: .leading, spacing: 16) {
                            Picker("Convert to", selection: $model.target) {
                                ForEach(model.formats, id: \.self) { format in Text(format == "unzip" ? "Extract ZIP to folder" : ["txt", "md"].contains(format) && !["txt", "md"].contains(model.source) && LocalFormats.documents.contains(model.source) ? format.uppercased() + " · Extract text" : format.uppercased()).tag(format) }
                            }.pickerStyle(.menu).accessibilityIdentifier("output-format")
                            VStack(alignment: .leading, spacing: 6) {
                                Text(model.target == "unzip" ? "Folder name" : "Output file name").font(.caption.bold()).foregroundStyle(.secondary)
                                TextField("Converted", text: $model.filename).textFieldStyle(.roundedBorder).accessibilityIdentifier("output-name")
                            }
                            if model.media && model.target != "zip" {
                                Toggle("Lossless / preserve quality", isOn: $model.options.lossless)
                                Text(model.options.lossless ? "Compatible streams are copied; PCM/ALAC audio is decoded and stored without lossy compression." : "Apple media encoding: MP4, MOV or M4A.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if model.target == "zip" { Toggle("Compress ZIP contents", isOn: $model.options.compressArchive) }
                            if ["jpg", "heic"].contains(model.target) || (model.media && !model.options.lossless) || (model.source == "pdf" && model.target == "pdf") {
                                VStack(alignment: .leading) {
                                    Text("Quality: \(Int(model.options.quality * 100))%").font(.caption)
                                    Slider(value: $model.options.quality, in: 0.2...1)
                                        .accessibilityLabel("Quality")
                                        .accessibilityValue("\(Int(model.options.quality * 100)) percent")
                                }
                            }
                            Text(LocalFormats.note(source: model.source, target: model.target, lossless: model.options.lossless)).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }.disabled(model.busy || saving).padding(18).background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
                        if model.busy {
                            HStack { ProgressView(); Text(model.message); Spacer(); Button("Cancel", role: .cancel) { model.cancel() } }
                        } else {
                            Button { model.convert() } label: { Label("Convert locally", systemImage: "arrow.triangle.2.circlepath").frame(maxWidth: .infinity).padding(.vertical, 10) }
                                .buttonStyle(.borderedProminent).tint(.purple).disabled(saving).accessibilityIdentifier("convert-local")
                        }
                    }
                    if let result = model.result {
                        VStack(alignment: .leading, spacing: 12) {
                            Label(model.message, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                            Text(result.url.lastPathComponent).font(.callout).textSelection(.enabled)
                            Button { save(result) } label: { Label(saving ? "Saving…" : "Save to…", systemImage: "square.and.arrow.down").frame(maxWidth: .infinity).padding(.vertical, 10) }
                                .buttonStyle(.borderedProminent).tint(.purple).disabled(saving || model.busy).accessibilityIdentifier("save-output")
                            Text("Choose the destination in Files or the save dialog. The original file is kept.").font(.caption).foregroundStyle(.secondary)
                        }.padding(18).background(.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
                    }
                    if !model.error.isEmpty { Label(model.error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.callout).textSelection(.enabled) }
                    HStack {
                        Button("Supported conversions") { showingFormats = true }
                        Spacer()
                        if !model.inputs.isEmpty { Button("Clear", role: .destructive) { model.clear() }.disabled(model.busy || saving).accessibilityIdentifier("clear-job") }
                    }.font(.callout)
                    HStack {
                        Button("Privacy & support") { showingPrivacy = true }.accessibilityIdentifier("privacy-support")
                        Spacer()
                    }.font(.callout)
                    Text("5 GB media · 512 MB other files · One conversion at a time\nKeep Flux open while converting. Temporary working files are cleared when you clear the job or reopen Flux.")
                        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.padding(24).frame(maxWidth: 700)
                    .frame(maxWidth: .infinity)
            }.accessibilityIdentifier("converter-workspace").navigationTitle("Flux Local")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result { case .success(let urls): model.select(urls); case .failure(let error): model.error = error.localizedDescription }
            }
            .sheet(isPresented: $showingFormats) { FormatView() }
            .sheet(isPresented: $showingPrivacy) { PrivacySupportView() }
            .onChange(of: model.target) { model.configurationChanged() }
            .onChange(of: model.options) { model.configurationChanged() }
            .onChange(of: scenePhase) { if scenePhase == .background && model.busy { model.cancel() } }
            // Status and errors change without moving focus; announce them to VoiceOver.
            .onChange(of: model.message) { if !model.message.isEmpty { AccessibilityNotification.Announcement(model.message).post() } }
            .onChange(of: model.error) { if !model.error.isEmpty { AccessibilityNotification.Announcement(model.error).post() } }
            #if os(iOS)
            .sheet(item: $exportFile, onDismiss: { saving = false }) { file in
                ExportPicker(url: file.url) { success in
                    if success { model.message = "Saved to Files." }; saving = false; exportFile = nil
                }.ignoresSafeArea()
            }
            #endif
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 580)
        #endif
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
                        model.message = "Saved to \(parent.lastPathComponent)."
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
                    do { try await Task.detached { try SafeSave.commit(result.url, to: destination) }.value; model.message = "Saved \(destination.lastPathComponent)." }
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
            }.navigationTitle("Supported conversions").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
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
