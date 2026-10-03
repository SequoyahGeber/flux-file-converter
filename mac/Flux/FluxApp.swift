import SwiftUI
import WebKit

@main
struct FluxApp: App {
  @StateObject private var client = ClientModel()
  var body: some Scene {
    Window("Flux", id: "main") {
      ContentView(client: client).frame(minWidth: 1000, minHeight: 700)
    }
    .defaultSize(width: 1260, height: 860)
    .commands {
      CommandGroup(after: .newItem) {
        Button("Choose Files…") { client.chooseFiles() }
          .keyboardShortcut("o").disabled(!client.inWorkspace)
        Button("Open Invitation…") { client.showInvitation = true }
          .keyboardShortcut("i", modifiers: [.command, .shift])
      }
      CommandGroup(replacing: .appSettings) {
        Button("Privacy & Storage…") { client.showPrivacy = true }
      }
    }
  }
}

struct ContentView: View {
  @ObservedObject var client: ClientModel
  var body: some View {
    VStack(spacing: 0) {
      if client.connected {
        HStack(spacing: 14) {
          Image(systemName: "arrow.left.arrow.right").foregroundStyle(.purple)
          Text("Flux").fontWeight(.semibold)
          Text(client.status).font(.caption).foregroundStyle(.secondary)
            .lineLimit(1).accessibilityIdentifier("connectionStatus")
          Spacer()
          Button {
            client.chooseFiles()
          } label: {
            Label("Choose Files", systemImage: "plus")
          }
          .disabled(!client.inWorkspace)
          Button {
            client.reload()
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .help("Reconnect to the private converter")
          Button {
            client.showDownloads.toggle()
          } label: {
            Label("Downloads", systemImage: "arrow.down.circle")
          }
          Button {
            client.showPrivacy = true
          } label: {
            Image(systemName: "lock.shield")
          }
          .help("Privacy and storage")
        }.padding(14).background(.bar)
        Divider()
        HStack(spacing: 0) {
          WebContent(webView: client.webView)
          if client.showDownloads {
            Divider()
            DownloadList(client: client).frame(width: 280)
          }
        }
        if let error = client.error {
          HStack {
            Label(error, systemImage: "exclamationmark.circle").font(.callout)
            Spacer()
            Button("Dismiss") { client.error = nil }
          }.padding(12).background(Color.orange.opacity(0.12))
        }
      } else {
        WelcomeView(client: client)
      }
    }
    .sheet(isPresented: $client.showPrivacy) { PrivacyView() }
    .sheet(isPresented: $client.showInvitation) { InvitationView(client: client) }
    .onDisappear { client.cancelDownloads() }
  }
}

struct WelcomeView: View {
  @ObservedObject var client: ClientModel
  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      Image(nsImage: NSImage(named: NSImage.applicationIconName)!)
        .resizable().frame(width: 92, height: 92)
      Text("Good files.\nNew possibilities.")
        .font(.system(size: 48, weight: .bold)).tracking(-1.5)
      Text("Convert, compress, ZIP and unzip with your private Flux server.")
        .font(.title3).foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 14) {
        Label(
          "Only files you select are uploaded for scanning and conversion.",
          systemImage: "doc.badge.arrow.up")
        Label("Your account and MFA protect the workspace.", systemImage: "lock.shield")
        Label("Choose the name and save location for every result.", systemImage: "folder")
      }.font(.callout)
      Text(
        "5 GB media · 1.9 GB other files · 10-minute conversions\nServer files expire after 30 minutes of inactivity."
      )
      .font(.caption).foregroundStyle(.secondary)
      HStack(spacing: 16) {
        Button("Connect to Flux") { client.connect() }.buttonStyle(.borderedProminent).tint(.purple)
        Button("Open Invitation…") { client.showInvitation = true }
        Button("Privacy & Storage") { client.showPrivacy = true }.buttonStyle(.link)
      }
      Text("fileconverter.sequoyahgeber.com").font(.caption.monospaced()).foregroundStyle(
        .secondary)
      if let error = client.error { Text(error).font(.callout).foregroundStyle(.orange) }
    }.padding(60).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
  }
}

struct PrivacyView: View {
  @Environment(\.dismiss) var dismiss
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Label("Privacy & Storage", systemImage: "lock.shield").font(.title2.bold())
      Text(
        "Flux for TestFlight is a client for the owner's private Unraid converter. An internet connection and an invitation are required. Files are processed on that server."
      )
      Text(
        "Selecting files sends their contents and filenames through Cloudflare to the server. Cloudflare handles login, MFA, and connection security. Membership records contain your email; the owner can revoke access. No advertising or tracking SDK is included."
      )
      Text(
        "Server uploads and results expire after 30 minutes of inactivity. Use Delete files in the workspace to remove them sooner. Downloaded results belong to you and remain wherever you save them."
      )
      Text(
        "Downloads are staged in the app's private cache. Failed and cancelled transfers are removed. Flux never opens or runs a converted file. Antivirus scanning reduces risk but cannot guarantee a harmless result."
      )
      Text(
        "Apple separately collects TestFlight crash reports, usage information, and feedback under its TestFlight terms. Avoid including private file contents in feedback."
      )
      HStack {
        Link(
          "Source & Support",
          destination: URL(string: "https://github.com/SequoyahGeber/flux-file-converter")!)
        Spacer()
        Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
      }
    }.font(.callout).padding(28).frame(width: 580)
  }
}

struct InvitationView: View {
  @ObservedObject var client: ClientModel
  @Environment(\.dismiss) var dismiss
  @State private var text = ""
  @State private var invalid = false
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Open an invitation").font(.title2.bold())
      Text(
        "Paste the Flux link from the owner. You'll sign in and complete MFA before claiming access. Invitations expire after 24 hours and work once."
      )
      TextField("https://fileconverter.sequoyahgeber.com/?invite=…", text: $text)
        .textFieldStyle(.roundedBorder).accessibilityIdentifier("invitationField")
      if invalid {
        Text("Use a valid invitation for fileconverter.sequoyahgeber.com.").foregroundStyle(.red)
      }
      HStack {
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Spacer()
        Button("Continue to Sign In") {
          guard let url = ClientPolicy.invitation(text) else {
            invalid = true
            return
          }
          text = ""
          dismiss()
          client.connect(url)
        }.keyboardShortcut(.defaultAction)
      }
    }.padding(28).frame(width: 550)
  }
}

struct DownloadList: View {
  @ObservedObject var client: ClientModel
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Saved this session").font(.headline)
      if client.transfers.isEmpty {
        Text("Save a converted result to choose its name and folder.")
          .font(.callout).foregroundStyle(.secondary)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          ForEach(client.transfers) { transfer in
            VStack(alignment: .leading, spacing: 8) {
              Text(transfer.name).font(.callout.bold()).lineLimit(2)
              if transfer.active {
                ProgressView(value: transfer.fraction)
                HStack {
                  Text(transfer.detail).font(.caption).foregroundStyle(.secondary)
                  Spacer()
                  Button("Cancel") { client.cancel(transfer.id) }.font(.caption)
                }
              } else if transfer.saving {
                ProgressView("Saving…").font(.caption)
              } else if let url = transfer.savedURL {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                  .font(.caption)
              } else {
                Text(transfer.detail).font(.caption).foregroundStyle(.secondary)
                if transfer.temporary != nil {
                  Button("Choose Save Location…") { client.retrySave(transfer.id) }.font(.caption)
                }
              }
            }
            Divider()
          }
        }
      }
      Button("Clear finished downloads") { client.clearFinished() }
        .font(.caption).disabled(client.transfers.allSatisfy(\.busy))
    }.padding(18)
  }
}

struct WebContent: NSViewRepresentable {
  let webView: WKWebView
  func makeNSView(context: Context) -> WKWebView { webView }
  func updateNSView(_ nsView: WKWebView, context: Context) {}
}
