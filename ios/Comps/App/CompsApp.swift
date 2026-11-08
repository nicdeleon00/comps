import SwiftUI
import SwiftData

@main
struct CompsApp: App {
    /// True when the saved collection couldn't be opened (it stays on disk, untouched).
    static var storeProblem = false
    /// Why it couldn't be opened, shown so it can be fixed.
    static var storeError: String?
    /// How many cards were rescued from a file that wouldn't open.
    static var rescued: Int?

    let container: ModelContainer = {
        CrashLog.install()
        let schema = Schema([Holding.self, ValueSnapshot.self])
        let memory = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        // Screenshots run on sample cards in memory, never on a real collection.
        if Screenshots.on { return try! ModelContainer(for: schema, configurations: memory) }
        StoreRescue.backupOnce()
        do {
            // iCloud stays off: some ways of installing the app add iCloud to its signature, and
            // SwiftData then tries to sync the collection with iCloud, which it can't open.
            let saved = StoreRescue.isMoved
                ? ModelConfiguration(schema: schema, url: StoreRescue.currentURL, cloudKitDatabase: .none)
                : ModelConfiguration(schema: schema, isStoredInMemoryOnly: false, cloudKitDatabase: .none)
            return try ModelContainer(for: schema, configurations: saved)
        } catch {
            CompsApp.storeError = String(describing: error)
            // Read the cards straight out of a copy of the file into a fresh one (the file stays as it is).
            do {
                let r = try StoreRescue.recover(schema: schema)
                CompsApp.rescued = r.cards
                return r.container
            } catch {
                CompsApp.storeError = (CompsApp.storeError ?? "") + "\n\nRescue: \(error)"
            }
            // Don't brick the app, and don't touch the saved file: run in memory and say so.
            CompsApp.storeProblem = true
            return try! ModelContainer(for: schema, configurations: memory)
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
    @State private var selection: AppTab = RootView.firstTab
    @State private var scanning = false
    @State private var storeProblem = CompsApp.storeProblem
    @State private var rescued = CompsApp.rescued != nil
    @State private var crashed = CrashLog.last != nil

    /// The Collection tab, unless screenshot mode asks for another one.
    private static var firstTab: AppTab {
        switch Screenshots.value("-tab") {
        case "deals": return .deals
        case "masterSets": return .masterSets
        case "search": return .search
        default: return .collection
        }
    }

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
            Button("Copy details") { UIPasteboard.general.string = CompsApp.storeError }
            Button("OK", role: .cancel) {}
        } message: {
            Text("They’re still saved on this phone, untouched. Don’t delete the app, and don’t scan until it’s fixed: send the details to get it fixed. Cards in your account are safe on the website.\n\n\(CompsApp.storeError.map { String($0.prefix(300)) } ?? "")")
        }
        .alert("Comps closed unexpectedly last time", isPresented: $crashed) {
            Button("Copy details") { UIPasteboard.general.string = CrashLog.last }
            Button("OK", role: .cancel) {}
        } message: {
            Text("Your cards are fine. Tap Copy details and send it, so it can be fixed.")
        }
        .alert("Your cards are back", isPresented: $rescued) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("The saved collection wouldn’t open, so \(CompsApp.rescued ?? 0) cards were copied out of it into a fresh file. The original is kept as a backup. Signed in? Everything in your account loads too.")
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
