import SwiftUI
import UIKit

@main
struct FluxApp: App {
  init() {
    LaunchFlags.applyBeforeLaunch()
    if LaunchFlags.uiTesting { UIView.setAnimationsEnabled(false) }
  }
  var body: some Scene { WindowGroup { LocalView() } }
}
