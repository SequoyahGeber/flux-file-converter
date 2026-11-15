import SwiftUI
import UIKit
import SharedFeedback

@main
struct FluxApp: App {
  init() {
    LaunchFlags.applyBeforeLaunch()
    // Diagnostics and feedback start before anything can fail (shake opens the form from here on).
    FluxDiagnostics.start()
    _ = FluxFeedback.center
    if LaunchFlags.uiTesting { UIView.setAnimationsEnabled(false) }
  }
  @Environment(\.scenePhase) private var scenePhase
  var body: some Scene {
    WindowGroup { LocalView() }
      .onChange(of: scenePhase) { FluxDiagnostics.center.sceneBecame(active: scenePhase == .active) }
  }
}
