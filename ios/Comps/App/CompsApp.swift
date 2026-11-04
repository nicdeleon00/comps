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
    enum AppTab: Hashable { case collection, scan, deals, masterSets, search }

    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(Pref.dataURL) private var dataURL = ""
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
            MasterSetsView()
                .tabItem { Label("Master Sets", systemImage: "checklist") }
                .tag(AppTab.masterSets)
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
            // comps://connect?url=… from the website's Settings page QR code.
            if let pair = PairingScanner.parse(url.absoluteString) {
                dataURL = pair.0
                Task {
                    await Catalog.shared.ensureLoaded(force: true)
                    await Portfolio.refreshPrices(context: context)
                }
            }
        }
        .task {
            await Account.shared.loadConfig()
            await Catalog.shared.ensureLoaded()
            await Portfolio.migrateDefaultPrintings(context: context)
            await Portfolio.refreshPrices(context: context)
        }
        .task(id: scenePhase) {
            // Keep the collection in step with the account while the app is open.
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled, scenePhase == .active else { return }
                await CollectionSync.shared.sync(context)
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
