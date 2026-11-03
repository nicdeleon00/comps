import SwiftUI

// Shapes of the shared drops files (same as the website and the PC monitor).

struct DropWatch: Codable, Identifiable, Hashable {
    var id: String
    var url: String
    var name: String?
    var maxPrice: Double?
    var addedAt: Double
}

struct DropDevice: Codable, Hashable {
    var id: String
    var name: String
    var endpoint: String
    var keys: [String: String]
    var addedAt: Double
}

struct DropsFile: Codable {
    var v = 1
    var updatedAt: Double = 0
    var watch: [DropWatch] = []
    var devices: [DropDevice] = []

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = (try? c.decodeIfPresent(Int.self, forKey: .v)) ?? 1
        updatedAt = (try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0
        watch = (try? c.decodeIfPresent([DropWatch].self, forKey: .watch)) ?? []
        devices = (try? c.decodeIfPresent([DropDevice].self, forKey: .devices)) ?? []
    }
}

struct WatchStatus: Codable, Hashable {
    var state: String
    var price: Double?
    var title: String?
    var store: String?
    var note: String?
    var checkedAt: Double?
}

struct DropEvent: Codable, Identifiable, Hashable {
    var id: String
    var watchId: String
    var at: Double
    var state: String
    var price: Double?
    var title: String?
    var url: String
    var store: String?
}

struct MonitorFile: Codable {
    var seenAt: Double
    var status: [String: WatchStatus]
    var events: [DropEvent]
    var dead: [String]?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seenAt = (try? c.decodeIfPresent(Double.self, forKey: .seenAt)) ?? 0
        status = (try? c.decodeIfPresent([String: WatchStatus].self, forKey: .status)) ?? [:]
        events = (try? c.decodeIfPresent([DropEvent].self, forKey: .events)) ?? []
        dead = try? c.decodeIfPresent([String].self, forKey: .dead)
    }

    var isOnline: Bool { Date().millis - seenAt < 5 * 60_000 }
}

enum DropText {
    static let stores = ["target": "Target", "walmart": "Walmart", "bestbuy": "Best Buy", "pokemoncenter": "Pokémon Center", "gamestop": "GameStop",
                         "amazon": "Amazon", "samsclub": "Sam's Club", "costco": "Costco", "tcgplayer": "TCGplayer"]
    static let states = ["in_stock": "In stock", "preorder": "Pre-order", "in_store": "In store only", "out_of_stock": "Out of stock",
                         "unknown": "Unknown", "blocked": "Blocked", "error": "Error"]

    static func store(of url: String) -> String {
        guard let host = URL(string: url)?.host?.lowercased() else { return "" }
        let h = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        return stores.keys.first { h == "\($0).com" || h.hasSuffix(".\($0).com") } ?? h
    }

    static func storeName(_ id: String?) -> String { id.flatMap { stores[$0] ?? $0 } ?? "" }
    static func buyable(_ state: String?) -> Bool { state == "in_stock" || state == "preorder" }
    static func ago(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "never" }
        return Date(millis: ms).formatted(.relative(presentation: .named))
    }
}

@MainActor
@Observable
final class DropsModel {
    static let dropsFile = "comps-drops.json"
    static let monitorFile = "comps-monitor.json"

    var drops = DropsFile()
    var monitor: MonitorFile?
    var loaded = false
    var error: String?

    func load() async {
        guard CollectionSync.shared.isConnected else { return }
        do {
            let files = try await CollectionSync.shared.gistFiles()
            drops = files[Self.dropsFile].flatMap { try? JSONDecoder().decode(DropsFile.self, from: $0) } ?? DropsFile()
            monitor = files[Self.monitorFile].flatMap { try? JSONDecoder().decode(MonitorFile.self, from: $0) }
            error = nil
            loaded = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Reads the latest list, changes it, writes back only the drops file.
    private func update(_ change: (inout DropsFile) -> Void) async {
        do {
            let files = try await CollectionSync.shared.gistFiles()
            var latest = files[Self.dropsFile].flatMap { try? JSONDecoder().decode(DropsFile.self, from: $0) } ?? DropsFile()
            change(&latest)
            if let dead = monitor?.dead, !dead.isEmpty { latest.devices.removeAll { dead.contains($0.endpoint) } }
            latest.updatedAt = Date().millis.rounded()
            try await CollectionSync.shared.writeGistFile(Self.dropsFile, data: JSONEncoder().encode(latest))
            withAnimation(.snappy) { drops = latest }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func add(url: String, name: String?, maxPrice: Double?) async {
        await update { d in
            guard !d.watch.contains(where: { $0.url == url }) else { return }
            d.watch.insert(DropWatch(id: UUID().uuidString.lowercased(), url: url, name: name, maxPrice: maxPrice, addedAt: Date().millis.rounded()), at: 0)
        }
    }

    func remove(_ id: String) async {
        await update { d in d.watch.removeAll { $0.id == id } }
    }
}

/// Drops: what the monitor on your PC is watching, live stock status, recent drops,
/// and upcoming releases.
@MainActor
struct DropsView: View {
    @State private var model = DropsModel()
    @State private var url = ""
    @State private var name = ""
    @State private var maxPrice = ""
    @State private var adding = false
    @State private var upcoming: [SetOption] = []
    @State private var copied = false
    @Environment(\.openURL) private var openURL
    private var sync: CollectionSync { .shared }

    private var validURL: Bool {
        let t = url.trimmingCharacters(in: .whitespaces)
        return (t.hasPrefix("https://") || t.hasPrefix("http://")) && URL(string: t)?.host?.contains(".") == true
    }

    var body: some View {
        NavigationStack {
            List {
                if !sync.isConnected {
                    Section {
                        Label("Drops share your watch list with the monitor on your PC using your sync key.", systemImage: "bolt.horizontal.circle")
                        Text("Set up **Sync with computer** first: Collection → ⚙︎ Settings.").font(.footnote).foregroundStyle(.secondary)
                    }
                } else {
                    monitorSection
                    addSection
                    watchSection
                    if let events = model.monitor?.events, !events.isEmpty { eventsSection(events) }
                    alertsSection
                }
                if !upcoming.isEmpty { upcomingSection }
            }
            .navigationTitle("Drops")
            .refreshable { await model.load() }
            .task {
                // Live while this screen is open.
                while !Task.isCancelled {
                    await model.load()
                    try? await Task.sleep(for: .seconds(15))
                }
            }
            .task { await loadUpcoming() }
        }
    }

    // MARK: Sections

    private var monitorSection: some View {
        Section {
            HStack(spacing: 12) {
                Circle().fill(model.monitor?.isOnline == true ? Color.up : Color.secondary.opacity(0.5)).frame(width: 9, height: 9)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.monitor?.isOnline == true ? "Monitor on your PC is running" : model.monitor == nil ? "Monitor not set up yet" : "Monitor on your PC is offline")
                        .font(.subheadline.weight(.semibold))
                    Text(model.monitor.map { "Last check-in \(DropText.ago($0.seenAt))" } ?? "Set it up from the website's Drops page on your computer.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let e = model.error { Text(e).font(.footnote).foregroundStyle(Color.down) }
        }
    }

    private var addSection: some View {
        Section {
            HStack {
                TextField("Product link", text: $url)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if url.isEmpty {
                    Button("Paste") { url = UIPasteboard.general.url?.absoluteString ?? UIPasteboard.general.string ?? "" }
                        .font(.subheadline.weight(.semibold))
                }
            }
            TextField("Name (optional)", text: $name)
            HStack {
                TextField("Max price (optional)", text: $maxPrice).keyboardType(.decimalPad)
                Spacer()
                Button {
                    Task { await add() }
                } label: {
                    if adding { ProgressView() } else { Text("Watch").bold() }
                }
                .disabled(!validURL || adding)
            }
            if validURL && DropText.store(of: url) == "target" {
                Text("Target doesn't put stock on its product pages, so the monitor can't tell when Target items are in stock yet.")
                    .font(.footnote).foregroundStyle(.orange)
            }
        } header: {
            Text("Watch a product")
        } footer: {
            Text("Your PC checks it about every 30 seconds and alerts you the moment it can be bought.")
        }
    }

    private var watchSection: some View {
        Section("Watching") {
            if model.drops.watch.isEmpty {
                Text(model.loaded ? "Nothing watched yet." : "Loading…").foregroundStyle(.secondary)
            }
            ForEach(model.drops.watch) { w in
                Button { if let u = URL(string: w.url) { openURL(u) } } label: { WatchRow(watch: w, status: model.monitor?.status[w.id]) }
                    .tint(.primary)
                    .swipeActions {
                        Button(role: .destructive) { Task { await model.remove(w.id) } } label: { Label("Stop", systemImage: "trash") }
                    }
            }
        }
    }

    private func eventsSection(_ events: [DropEvent]) -> some View {
        Section("Recent drops") {
            ForEach(events.prefix(15)) { e in
                Button { if let u = URL(string: e.url) { openURL(u) } } label: {
                    HStack(spacing: 10) {
                        StatePill(state: e.state)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(e.title ?? e.url).font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text("\(DropText.storeName(e.store)) · \(Date(millis: e.at).formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(Fmt.money(e.price)).font(.subheadline.weight(.semibold).monospacedDigit())
                    }
                }
                .tint(.primary)
            }
        }
    }

    private var alertsSection: some View {
        Section {
            let phones = model.drops.devices.count
            Label(phones == 0 ? "No phones get alerts yet" : "\(phones) device\(phones == 1 ? "" : "s") get alerts", systemImage: "bell.badge")
            Button {
                UIPasteboard.general.string = sync.token
                copied = true
            } label: { Label(copied ? "Key copied" : "1. Copy your sync key", systemImage: copied ? "checkmark" : "doc.on.doc") }
            Button {
                openURL(HostedData.current.url("drops"))
            } label: { Label("2. Open Comps in Safari", systemImage: "safari") }
        } header: {
            Text("Alerts on this iPhone")
        } footer: {
            Text("iPhone only allows instant alerts for apps installed outside the App Store through Home Screen web apps. In Safari tap Share → Add to Home Screen, open Comps from your Home Screen, paste the key, then Drops → Turn on alerts. Your PC sends the alerts directly.")
        }
    }

    private var upcomingSection: some View {
        Section("Upcoming releases") {
            ForEach(upcoming) { s in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.name).font(.subheadline.weight(.semibold))
                        Text("\(s.series) · \(s.released ?? "")").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(daysUntil(s.released)).font(.caption.weight(.semibold)).foregroundStyle(.tint)
                        .padding(.horizontal, 8).padding(.vertical, 3).background(Color.accentColor.opacity(0.12), in: Capsule())
                }
            }
        }
    }

    // MARK: Actions

    private func add() async {
        adding = true
        defer { adding = false }
        let price = Double(maxPrice.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: ""))
        let n = name.trimmingCharacters(in: .whitespaces)
        await model.add(url: url.trimmingCharacters(in: .whitespaces), name: n.isEmpty ? nil : n, maxPrice: price)
        if model.error == nil {
            url = ""
            name = ""
            maxPrice = ""
        }
    }

    private func loadUpcoming() async {
        await Catalog.shared.ensureLoaded()
        let today = Fmt.day()
        upcoming = await Catalog.shared.setOptions()
            .filter { ($0.released ?? "") > today }
            .sorted { ($0.released ?? "") < ($1.released ?? "") }
            .prefix(6).map { $0 }
    }

    private func daysUntil(_ day: String?) -> String {
        guard let day, let d = Fmt.date(fromDay: day) else { return "" }
        let n = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: .now), to: d).day ?? 0
        return n <= 0 ? "Today" : n == 1 ? "Tomorrow" : "\(n) days"
    }
}

private struct StatePill: View {
    let state: String?

    var body: some View {
        let buyable = DropText.buyable(state)
        let trouble = state == "blocked" || state == "error"
        Text(state.flatMap { DropText.states[$0] } ?? "Waiting")
            .font(.caption2.weight(.bold))
            .foregroundStyle(buyable ? Color.up : trouble ? Color.orange : Color.secondary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background((buyable ? Color.up : trouble ? Color.orange : Color.secondary).opacity(0.14), in: Capsule())
            .fixedSize()
    }
}

private struct WatchRow: View {
    let watch: DropWatch
    let status: WatchStatus?

    var body: some View {
        HStack(spacing: 10) {
            StatePill(state: status?.state)
            VStack(alignment: .leading, spacing: 2) {
                Text(watch.name ?? status?.title ?? watch.url).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 6)
            Text(Fmt.money(status?.price)).font(.subheadline.weight(.semibold).monospacedDigit())
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        var parts = [DropText.storeName(status?.store ?? DropText.store(of: watch.url))]
        if let m = watch.maxPrice { parts.append("alert at \(Fmt.money(m)) or less") }
        parts.append(status?.checkedAt.map { "checked \(DropText.ago($0))" } ?? "not checked yet")
        if let note = status?.note, !DropText.buyable(status?.state) { parts.append(note) }
        return parts.joined(separator: " · ")
    }
}
