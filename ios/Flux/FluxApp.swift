import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

@main
struct FluxPhoneApp: App {
  @StateObject private var client = MobileClient()
  @Environment(\.scenePhase) private var scenePhase
  var body: some Scene {
    WindowGroup {
      PhoneWorkspace(client: client)
        .onChange(of: scenePhase) { _, phase in
          if phase == .background { client.cancelDownloads() }
        }
    }
  }
}

struct PhoneWorkspace: View {
  @ObservedObject var client: MobileClient
  @State private var invitation = false
  @State private var privacy = false
  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if client.connected {
          PhoneWebContent(webView: client.webView)
        } else {
          ScrollView {
            VStack(alignment: .leading, spacing: 24) {
              Image(systemName: "arrow.left.arrow.right").font(.system(size: 48, weight: .bold))
                .foregroundStyle(.purple)
              Text("Good files.\nNew possibilities.").font(.largeTitle.bold())
              Text("Convert, compress, ZIP and unzip with your private Flux server.").font(.title3)
              Label(
                "Only files you select are uploaded for scanning and conversion.",
                systemImage: "doc.badge.arrow.up")
              Label("Sign in with your invitation and MFA.", systemImage: "lock.shield")
              Label("Name results, save to Files, or share them.", systemImage: "folder")
              Text(
                "5 GB media · 1.9 GB other files\n10-minute conversions · files expire after 30 minutes of inactivity."
              )
              .font(.footnote).foregroundStyle(.secondary)
              Button("Connect to Flux") { client.connect() }.buttonStyle(.borderedProminent).tint(
                .purple)
              Button("Open Invitation…") { invitation = true }.buttonStyle(.bordered)
              Button("Privacy & Storage") { privacy = true }
            }.padding(28)
          }
        }
        if let error = client.error {
          HStack(alignment: .top) {
            Text(error).font(.footnote)
            Spacer()
            Button {
              client.error = nil
            } label: {
              Image(systemName: "xmark.circle")
            }
            .accessibilityLabel("Dismiss error")
          }.padding().background(Color.orange.opacity(0.12))
        }
      }
      .navigationTitle("Flux")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Menu {
            Button("Open Invitation", systemImage: "person.badge.plus") { invitation = true }
            Button("Reconnect", systemImage: "arrow.clockwise") { client.reload() }
            Button("Privacy & Storage", systemImage: "lock.shield") { privacy = true }
            if client.connected {
              Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right") {
                client.signOut()
              }
            }
          } label: {
            Image(systemName: "line.3.horizontal")
          }
          .accessibilityLabel("Workspace menu")
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            client.showDownloads = true
          } label: {
            Image(systemName: "arrow.down.circle")
          }
          .accessibilityLabel("Downloads")
        }
      }
      .sheet(isPresented: $invitation) { PhoneInvitation(client: client) }
      .sheet(isPresented: $privacy) { PhonePrivacy() }
      .sheet(isPresented: $client.showDownloads) { PhoneDownloads(client: client) }
      .sheet(isPresented: $client.choosingFiles, onDismiss: { client.finishFileSelection(nil) }) {
        UploadPicker(client: client)
      }
    }.tint(.purple)
  }
}

struct PhoneWebContent: UIViewRepresentable {
  let webView: WKWebView
  func makeUIView(context: Context) -> WKWebView { webView }
  func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct UploadPicker: UIViewControllerRepresentable {
  let client: MobileClient
  func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
    let picker = UIDocumentPickerViewController(
      forOpeningContentTypes: [.data, .content], asCopy: false)
    picker.allowsMultipleSelection = true
    picker.delegate = client
    return picker
  }
  func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context)
  {}
}

struct PhoneInvitation: View {
  let client: MobileClient
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var invalid = false
  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(
            "Paste the owner's Flux link. Sign in and complete MFA before claiming access. Invitations expire after 24 hours and work once."
          )
          TextField("Invitation link", text: $text, axis: .vertical)
            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
          if invalid {
            Text("Use a valid invitation for fileconverter.sequoyahgeber.com.").foregroundStyle(
              .red)
          }
          Button("Continue to Sign In") {
            guard let url = ClientPolicy.invitation(text) else {
              invalid = true
              return
            }
            text = ""
            dismiss()
            client.connect(url)
          }
        }
      }.navigationTitle("Open Invitation").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
  }
}

struct PhonePrivacy: View {
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      List {
        Section("Files and storage") {
          Text(
            "Flux sends files you select, their names and conversion settings through Cloudflare to the owner's private Unraid converter. Originals stay where you selected them. Internet access and an invitation are required."
          )
          Text(
            "Server uploads and results expire after 30 minutes of inactivity. Delete my files removes them sooner. Saved copies in Files and other apps remain yours."
          )
          Text(
            "Downloads stay in Flux's private cache until saved to Files, cleared or the next launch. Two staging slots, 5 GB per result and a 10-minute timeout bound downloads. Keep Flux open during transfers; switching apps can interrupt them."
          )
        }
        Section("Account and privacy") {
          Text(
            "Cloudflare handles login, MFA and connection security. The owner can see members' emails and revoke access. Flux includes no advertising or tracking SDK and never runs a converted file."
          )
          Text(
            "Antivirus scanning reduces risk but cannot guarantee a harmless file. Apple separately collects TestFlight crash reports, usage and feedback under its TestFlight terms."
          )
          Link(
            "Privacy Policy",
            destination: URL(
              string:
                "https://github.com/SequoyahGeber/flux-file-converter/blob/main/docs/privacy.md")!)
          Link(
            "Source & Support",
            destination: URL(string: "https://github.com/SequoyahGeber/flux-file-converter")!)
        }
      }.navigationTitle("Privacy & Storage").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }
}

struct PhoneDownloads: View {
  @ObservedObject var client: MobileClient
  @Environment(\.dismiss) private var dismiss
  @State private var export: ExportSelection?
  @State private var renaming: UUID?
  @State private var name = ""
  var body: some View {
    NavigationStack {
      List {
        if client.transfers.isEmpty {
          ContentUnavailableView(
            "No downloads yet", systemImage: "arrow.down.circle",
            description: Text("Use Save as on a completed result in the workspace."))
        }
        ForEach(client.transfers) { transfer in
          VStack(alignment: .leading, spacing: 12) {
            Text(transfer.name).font(.headline).lineLimit(3)
            Text(transfer.detail).font(.caption).foregroundStyle(.secondary)
            if transfer.active {
              ProgressView(value: transfer.fraction)
              Button("Cancel download", role: .destructive) { client.cancel(transfer.id) }
            } else if let url = transfer.url {
              Button("Save to Files", systemImage: "folder") {
                export = ExportSelection(id: transfer.id, url: url)
              }
              ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
              Button("Rename", systemImage: "pencil") {
                name = transfer.name
                renaming = transfer.id
              }
            }
          }.padding(.vertical, 6)
        }
        Section {
          Text(
            "Keep Flux open while downloading. Results saved to Files stay there when the cache is cleared."
          ).font(.footnote)
          Button("Clear finished downloads", role: .destructive) { client.clearFinished() }
            .disabled(client.transfers.allSatisfy(\.active) || export != nil)
        }
      }.navigationTitle("Downloads").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .sheet(item: $export) { selection in
          ExportPicker(url: selection.url) { saved in
            if saved { client.exported(selection.id) }
            export = nil
          }
        }
        .alert(
          "Name this file",
          isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
        ) {
          TextField("Filename", text: $name).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Rename") {
            if let id = renaming { client.rename(id, to: name) }
            renaming = nil
          }
          Button("Cancel", role: .cancel) { renaming = nil }
        } message: {
          Text("Keep the file's extension.")
        }
    }
  }
}

struct ExportSelection: Identifiable {
  let id: UUID
  let url: URL
}

struct ExportPicker: UIViewControllerRepresentable {
  let url: URL
  let completion: (Bool) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
  func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
    let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context)
  {}
  final class Coordinator: NSObject, UIDocumentPickerDelegate {
    let completion: (Bool) -> Void
    init(completion: @escaping (Bool) -> Void) { self.completion = completion }
    func documentPicker(
      _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
    ) {
      completion(!urls.isEmpty)
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
      completion(false)
    }
  }
}
