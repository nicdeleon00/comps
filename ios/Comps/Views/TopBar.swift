import SwiftUI

/// The Search and Settings buttons at the top of every tab, where the website has them too.
struct TopBarButtons: ViewModifier {
    @State private var searching = false
    @State private var showSettings = false
    /// The tab the app opens on: screenshot mode opens Search or Settings from it.
    var first = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { searching = true } label: { Image(systemName: "magnifyingglass") }
                        .accessibilityLabel("Search cards")
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $searching) { SearchView(inSheet: true) }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .task {
                guard first else { return }
                if Screenshots.value("-tab") == "search" {
                    try? await Task.sleep(for: .seconds(2))
                    searching = true
                } else if Screenshots.flag("-settings") {
                    try? await Task.sleep(for: .seconds(3))
                    showSettings = true
                }
            }
    }
}

extension View {
    /// Search and Settings in the navigation bar. `first` marks the tab the app opens on.
    func topBarButtons(first: Bool = false) -> some View { modifier(TopBarButtons(first: first)) }
}
