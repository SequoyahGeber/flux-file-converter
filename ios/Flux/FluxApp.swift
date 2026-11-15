import SwiftUI
import UIKit
import OfflineKit
import SharedDesign
import SharedDiagnostics
import SharedFeedback

@main
struct FluxApp: App {
  @ObservedObject private var session = UITestSession.shared

  init() {
    LaunchFlags.applyBeforeLaunch()
    // Diagnostics and feedback start before anything can fail (shake opens the form from here on).
    FluxDiagnostics.start()
    _ = FluxFeedback.center
    if LaunchFlags.uiTesting { UIView.setAnimationsEnabled(false) }
    // Fast UI tests (D-083): the next test resets this app in place instead of relaunching it. Listens only in a
    // Debug build launched with -uiTesting; declines (and the test relaunches) when it asks for other arguments.
    UITestResetListener.start { UITestSession.shared.reset() }
  }

  @Environment(\.scenePhase) private var scenePhase
  var body: some Scene {
    WindowGroup {
      // A new identity rebuilds every screen's state and dismisses what was presented over it.
      LocalView().id(session.generation)
        .tonePalette(FluxPalette.tones)
        .transaction { if LaunchFlags.uiTesting { $0.disablesAnimations = true } }
    }
    .onChange(of: scenePhase) { FluxDiagnostics.center.sceneBecame(active: scenePhase == .active) }
  }
}

/// What a `-resetData` launch would do, done in place for the next UI test.
@MainActor final class UITestSession: ObservableObject {
  static let shared = UITestSession()
  @Published private(set) var generation = 0

  func reset() {
    FluxFeedback.center.close()
    FluxSettings.reset()
    OfflineEngine.clearTemporaryFiles()
    generation += 1
  }
}
