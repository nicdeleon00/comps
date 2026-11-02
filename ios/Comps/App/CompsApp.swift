import SwiftUI
import SwiftData

@main
struct CompsApp: App {
    let container: ModelContainer = {
        do {
            return try ModelContainer(for: Holding.self, ValueSnapshot.self)
        } catch {
            // A schema we can't migrate shouldn't brick the app; start fresh in memory.
            return try! ModelContainer(for: Holding.self, ValueSnapshot.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        }
    }()

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(container)
    }
}

@MainActor
struct RootView: View {
    enum AppTab: Hashable { case collection, scan, deals, search }

    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(Pref.serverURL) private var serverURL = ""
    @AppStorage(Pref.serverToken) private var token = ""
    @State private var selection: AppTab = .collection
    @State private var scanning = false

    var body: some View {
        TabView(selection: $selection) {
            CollectionView(onScan: { scanning = true })
                .tabItem { Label("Collection", systemImage: "square.stack.3d.up.fill") }
                .tag(AppTab.collection)
            Color.clear
                .tabItem { Label("Scan", systemImage: "viewfinder") }
                .tag(AppTab.scan)
            DealsView()
                .tabItem { Label("Deals", systemImage: "tag.fill") }
                .tag(AppTab.deals)
            SearchView()
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(AppTab.search)
        }
        .onChange(of: selection) { old, new in
            if new == .scan {
                scanning = true
                selection = old
            }
        }
        .fullScreenCover(isPresented: $scanning) {
            ScannerView()
        }
        .onOpenURL { url in
            // comps://connect?url=…&token=… from the server's pairing QR code.
            if let pair = PairingScanner.parse(url.absoluteString) {
                serverURL = pair.0
                if let t = pair.1 { token = t }
                UserDefaults.standard.set(0.0, forKey: Pref.lastSync)
                Task { _ = try? await Portfolio.sync(context: context); await Portfolio.refreshPrices(context: context) }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await Portfolio.refreshPrices(context: context) } }
        }
        .onChange(of: scanning) { _, isScanning in
            if !isScanning { Task { await Portfolio.refreshPrices(context: context) } }
        }
    }
}
