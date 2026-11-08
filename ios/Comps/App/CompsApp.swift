import SwiftUI
import SwiftData

@main
struct CompsApp: App {
    /// True when the saved collection couldn't be opened (it stays on disk, untouched).
    static var storeProblem = false

    let container: ModelContainer = {
        let memory = ModelConfiguration(isStoredInMemoryOnly: true)
        // Screenshots run on sample cards in memory, never on a real collection.
        if Screenshots.on { return try! ModelContainer(for: Holding.self, ValueSnapshot.self, configurations: memory) }
        do {
            return try ModelContainer(for: Holding.self, ValueSnapshot.self)
        } catch {
            // Don't brick the app, and don't touch the saved file: run in memory and say so.
            CompsApp.storeProblem = true
            return try! ModelContainer(for: Holding.self, ValueSnapshot.self, configurations: memory)
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
    @State private var selection: AppTab = switch Screenshots.value("-tab") {
        case "deals": .deals
        case "masterSets": .masterSets
        case "search": .search
        default: .collection
    }
    @State private var scanning = false
    @State private var storeProblem = CompsApp.storeProblem

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
        .alert("Couldn’t open your saved cards", isPresented: $storeProblem) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("They’re still saved on this phone, untouched. Don’t delete the app: install the next update and they’ll be back. If you’re signed in, they also load from your account.")
        }
        .task {
            if Screenshots.on { await Screenshots.seed(context) }
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
