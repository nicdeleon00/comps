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
    var name: String?
    var endpoint: String
}

struct DropsFile {
    var watch: [DropWatch] = []
    var devices: [DropDevice] = []
}

struct WatchStatus: Codable, Hashable {
    var watchId: String
    var state: String
    var price: Double?
    var title: String?
    var store: String?
    var note: String?
    var checkedAt: Double?
}

struct DropEvent: Codable, Identifiable, Hashable {
    var id: String
    var watchId: String?
    var at: Double
    var state: String
    var price: Double?
    var title: String?
    var url: String
    var store: String?
}

struct MonitorFile {
    var seenAt: Double
    var status: [String: WatchStatus]
    var events: [DropEvent]

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
    var drops = DropsFile()
    var monitor: MonitorFile?
    var loaded = false
    var error: String?

    private struct MonitorRow: Decodable { var seenAt: Double? }

    private var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    func load() async {
        guard Account.shared.isSignedIn else { return }
        do {
            async let watch = Account.shared.rest("watch_items?select=id,url,name,max_price,added_at&order=added_at.desc")
            async let devices = Account.shared.rest("push_devices?select=id,name,endpoint")
            async let status = Account.shared.rest("drop_status?select=watch_id,state,price,title,store,note,checked_at")
            async let events = Account.shared.rest("drop_events?select=*&order=at.desc&limit=30")
            async let state = Account.shared.rest("monitor_state?select=seen_at")
            let d = decoder
            let (w, dv, st, ev, ms) = (try await watch, try await devices, try await status, try await events, try await state)
            drops = DropsFile(watch: try d.decode([DropWatch].self, from: w), devices: try d.decode([DropDevice].self, from: dv))
            let statuses = try d.decode([WatchStatus].self, from: st)
            let recent = (try? d.decode([DropEvent].self, from: ev)) ?? []
            if let seen = try d.decode([MonitorRow].self, from: ms).first?.seenAt {
                monitor = MonitorFile(seenAt: seen, status: Dictionary(statuses.map { ($0.watchId, $0) }, uniquingKeysWith: { a, _ in a }), events: recent)
            } else {
                monitor = nil
            }
            error = nil
            loaded = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    func add(url: String, name: String?, maxPrice: Double?) async {
        do {
            let row: [String: Any] = ["url": url, "name": name.map { $0 as Any } ?? NSNull(), "max_price": maxPrice.map { $0 as Any } ?? NSNull()]
            _ = try await Account.shared.rest("watch_items", method: "POST", json: row, prefer: "return=minimal")
            error = nil
            await load()
        } catch Account.Failure.server(409, _) {
            error = "You're already watching that link."
        } catch {
            self.error = error.localizedDescription
        }
    }

    func remove(_ id: String) async {
        do {
            _ = try await Account.shared.rest("watch_items?id=eq.\(id)", method: "DELETE")
            withAnimation(.snappy) { drops.watch.removeAll { $0.id == id } }
        } catch {
            self.error = error.localizedDescription
        }
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
    @State private var signingIn = false
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
                        Label("Watch product links and get an alert the moment one can be bought.", systemImage: "bolt.horizontal.circle")
                        if Account.shared.isEnabled {
                            Button("Sign in or create account") { signingIn = true }.bold()
                        } else {
                            Text("Accounts aren't switched on for this site yet.").font(.footnote).foregroundStyle(.secondary)
                        }
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
            .sheet(isPresented: $signingIn) { SignInSheet() }
        }
    }

    // MARK: Sections

    private var monitorSection: some View {
        Section {
            HStack(spacing: 12) {
                Circle().fill(model.monitor?.isOnline == true ? Color.up : Color.secondary.opacity(0.5)).frame(width: 9, height: 9)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.monitor?.isOnline == true ? "Drop monitor is running" : model.monitor == nil ? "Drop monitor hasn't started yet" : "Drop monitor is offline")
                        .font(.subheadline.weight(.semibold))
                    Text(model.monitor.map { "Last check-in \(DropText.ago($0.seenAt))" } ?? "Your links are saved and checked once it runs.")
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
            Text("Checked about every 30 seconds while the drop monitor runs; you're alerted the moment it can be bought. Up to 20 links.")
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
                openURL(HostedData.current.url("drops"))
            } label: { Label("Set up alerts in Safari", systemImage: "safari") }
        } header: {
            Text("Alerts on this iPhone")
        } footer: {
            Text("iPhone only allows instant alerts for apps installed outside the App Store through Home Screen web apps. In Safari tap Share → Add to Home Screen, open Comps from your Home Screen, sign in with this account, then Drops → Turn on alerts.")
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
