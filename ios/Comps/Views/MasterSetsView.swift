import SwiftUI
import SwiftData

/// Every set with your progress toward the master set.
@MainActor
struct MasterSetsView: View {
    @Query(filter: #Predicate<Holding> { $0.isTombstoned == false }) private var holdings: [Holding]
    @AppStorage("masterSetMode") private var modeRaw = MSMode.master.rawValue
    @State private var sets: [MSSetInfo] = []
    @State private var loaded = false
    @State private var query = ""

    private var mode: MSMode { MSMode(rawValue: modeRaw) ?? .master }

    var body: some View {
        NavigationStack {
            let owned = MasterSet.ownedMap(holdings)
            let rows = filtered.map { ($0, MasterSet.progress($0.slots, owned, mode)) }
            let started = rows.filter { $0.1.owned > 0 }.sorted { $0.1.fraction != $1.1.fraction ? $0.1.fraction > $1.1.fraction : $0.1.value > $1.1.value }
            List {
                Section {
                    Picker("Count", selection: $modeRaw) {
                        ForEach(MSMode.allCases) { Text($0.rawValue).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    Text("Every card in every printing (normal, reverse holo, Poké Ball, Master Ball, Energy Symbol and more). Prices are raw market prices.")
                }

                if !loaded {
                    Section { HStack { Spacer(); ProgressView(); Spacer() } }
                } else if sets.isEmpty {
                    Section { Text("Connect your price site in Settings to load the card list.").foregroundStyle(.secondary) }
                } else {
                    Section("Your sets") {
                        if started.isEmpty {
                            Label("Open a set and tap cards to mark the printings you have. Cards you scan or add show up here too.", systemImage: "checklist")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        ForEach(started, id: \.0.id) { row in
                            NavigationLink(value: row.0) { MasterSetRow(set: row.0, progress: row.1, mode: mode, showProgress: true) }
                        }
                    }
                    ForEach(seriesGroups(rows), id: \.0) { group in
                        Section(group.0) {
                            ForEach(group.1, id: \.0.id) { row in
                                NavigationLink(value: row.0) { MasterSetRow(set: row.0, progress: row.1, mode: mode, showProgress: false) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Master Sets")
            .searchable(text: $query, prompt: "Find a set")
            .navigationDestination(for: MSSetInfo.self) { MasterSetDetailView(set: $0) }
            .task { await load() }
            .refreshable { await load(force: true) }
        }
    }

    private var filtered: [MSSetInfo] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return sets }
        return sets.filter { s in
            let hay = "\(s.name) \(s.code ?? "") \(s.series)".lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    private func seriesGroups(_ rows: [(MSSetInfo, MSProgress)]) -> [(String, [(MSSetInfo, MSProgress)])] {
        var order: [String] = []
        var groups: [String: [(MSSetInfo, MSProgress)]] = [:]
        for r in rows {
            if groups[r.0.series] == nil { order.append(r.0.series) }
            groups[r.0.series, default: []].append(r)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }

    private func load(force: Bool = false) async {
        await Catalog.shared.ensureLoaded(force: force)
        sets = await Catalog.shared.masterSets()
        loaded = true
    }
}

struct MasterSetRow: View {
    let set: MSSetInfo
    let progress: MSProgress
    let mode: MSMode
    let showProgress: Bool

    var body: some View {
        HStack(spacing: 12) {
            CardImage(url: set.art, name: set.name, game: .pokemon, corner: 3)
                .frame(width: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(set.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                if showProgress {
                    Text("\(progress.owned) of \(progress.total) · \(progress.percentText)")
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    ProgressView(value: progress.fraction)
                        .tint(progress.isComplete ? Color.up : Color.accentColor)
                    Text(progress.isComplete ? "Complete" : "\(Fmt.money(progress.toComplete)) to complete")
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                } else {
                    Text([set.released.map { String($0.prefix(4)) }, "\(progress.total) \(mode == .master ? "printings" : "cards")",
                          progress.owned > 0 ? "\(progress.percentText) done" : nil].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            Spacer(minLength: 8)
            Text(Fmt.money(showProgress ? progress.value : progress.full))
                .font(.subheadline.weight(.semibold)).monospacedDigit()
        }
        .padding(.vertical, 2)
    }
}

/// One set: what you have, what it's worth, what's left, card by card.
@MainActor
struct MasterSetDetailView: View {
    let set: MSSetInfo
    @Query(filter: #Predicate<Holding> { $0.isTombstoned == false }) private var holdings: [Holding]
    @AppStorage("masterSetMode") private var modeRaw = MSMode.master.rawValue
    @State private var filter: Filter = .all
    @State private var byPrice = false
    @State private var selected: MSSlot?

    enum Filter: String, CaseIterable { case all = "All", missing = "Missing", have = "Have" }
    private var mode: MSMode { MSMode(rawValue: modeRaw) ?? .master }

    var body: some View {
        let owned = MasterSet.ownedMap(holdings)
        let p = MasterSet.progress(set.slots, owned, mode)
        let shown = visible(owned)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text([set.series, set.released.map { String($0.prefix(4)) }, "\(set.slots.count) cards · \(set.printingCount) printings"].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(.secondary)

                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    StatTile(title: mode == .master ? "Printings collected" : "Cards collected", value: "\(p.owned) / \(p.total)",
                             note: p.isComplete ? "Complete" : "\(p.percentText) · \(p.total - p.owned) to go", progress: p.fraction)
                    StatTile(title: "Your set's value", value: Fmt.money(p.value), note: "One of each you have, raw")
                    StatTile(title: "Cost to complete", value: p.isComplete ? "—" : Fmt.money(p.toComplete),
                             note: p.unpriced > 0 ? "\(p.unpriced) without a price yet" : mode == .master ? "Every missing printing" : "Cheapest printing of each")
                    StatTile(title: mode == .master ? "Full master set" : "Full set", value: Fmt.money(p.full), note: "At today's raw prices")
                }

                Picker("Count", selection: $modeRaw) { ForEach(MSMode.allCases) { Text($0.rawValue).tag($0.rawValue) } }
                    .pickerStyle(.segmented)
                HStack {
                    Picker("Show", selection: $filter) { ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                        .pickerStyle(.segmented)
                    Menu {
                        Picker("Sort", selection: $byPrice) {
                            Text("Card number").tag(false)
                            Text("Most to buy").tag(true)
                        }
                    } label: { Image(systemName: "arrow.up.arrow.down.circle").font(.title3) }
                    .accessibilityLabel("Sort")
                }

                if shown.isEmpty {
                    Text(filter == .missing ? "You have every card here." : "Tap a card to mark the printings you have.")
                        .font(.subheadline).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 12)], spacing: 16) {
                    ForEach(shown) { s in
                        Button { selected = s } label: { SlotTile(slot: s, owned: owned, mode: mode) }
                            .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .navigationTitle(set.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $selected) { s in
            SlotSheet(slot: s, setName: set.name)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    private func visible(_ owned: [String: Int]) -> [MSSlot] {
        var xs = set.slots
        switch filter {
        case .all: break
        case .missing: xs = xs.filter { !MasterSet.isDone($0, owned, mode) }
        case .have: xs = xs.filter { s in s.printings.contains { MasterSet.have($0, owned) > 0 } }
        }
        if byPrice {
            xs.sort { MasterSet.missingCost($0, owned, mode) > MasterSet.missingCost($1, owned, mode) }
        }
        return xs
    }
}

struct StatTile: View {
    let title: String
    let value: String
    let note: String
    var progress: Double? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.bold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            if let progress {
                ProgressView(value: progress).tint(progress >= 1 ? Color.up : Color.accentColor)
            }
            Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct SlotTile: View {
    let slot: MSSlot
    let owned: [String: Int]
    let mode: MSMode

    var body: some View {
        let any = slot.printings.contains { MasterSet.have($0, owned) > 0 }
        let done = MasterSet.isDone(slot, owned, mode)
        VStack(alignment: .leading, spacing: 5) {
            CardImage(url: slot.image, name: slot.name, game: .pokemon, corner: 5)
                .opacity(any ? 1 : 0.45)
                .saturation(any ? 1 : 0.2)
                .overlay(alignment: .topTrailing) {
                    if done {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(Color.white, Color.up)
                            .padding(5)
                    }
                }
            Text(slot.name).font(.caption.weight(.semibold)).lineLimit(1)
            HStack {
                Text("#\(slot.number)").foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if done { Text("Have").foregroundStyle(Color.up) } else { Text(Fmt.money(MasterSet.missingCost(slot, owned, mode))) }
            }
            .font(.caption2.weight(.medium)).monospacedDigit()
            FlowChips(printings: slot.printings, owned: owned)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(slot.name), number \(slot.number), \(slot.printings.filter { MasterSet.have($0, owned) > 0 }.count) of \(slot.printings.count) printings")
    }
}

/// Small printing badges (N, RH, PB, MB…), filled for the ones you have.
struct FlowChips: View {
    let printings: [MSPrinting]
    let owned: [String: Int]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(printings) { p in
                PrintingChip(text: p.short, have: MasterSet.have(p, owned) > 0)
            }
        }
        .lineLimit(1)
    }
}

struct PrintingChip: View {
    let text: String
    let have: Bool
    var large = false

    var body: some View {
        Text(text)
            .font(.system(size: large ? 12 : 9.5, weight: .semibold))
            .padding(.horizontal, large ? 6 : 4)
            .frame(minWidth: large ? 32 : 20, minHeight: large ? 24 : 16)
            .foregroundStyle(have ? Color.accentColor : Color.secondary)
            .background(have ? Color.accentColor.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(have ? Color.clear : Color.secondary.opacity(0.35), lineWidth: 1))
    }
}

/// A card's printings: mark the ones you have (adds them to your collection) or take copies away.
@MainActor
struct SlotSheet: View {
    let slot: MSSlot
    let setName: String
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query(filter: #Predicate<Holding> { $0.isTombstoned == false }) private var holdings: [Holding]
    @State private var confirmGraded: Holding?

    var body: some View {
        let owned = MasterSet.ownedMap(holdings)
        NavigationStack {
            List {
                Section {
                    HStack(alignment: .top, spacing: 14) {
                        CardImage(url: slot.imageLarge ?? slot.image, name: slot.name, game: .pokemon, corner: 6)
                            .frame(width: 92)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(slot.name).font(.headline)
                            Text(["#\(slot.number)", slot.rarity].compactMap { $0 }.joined(separator: " · "))
                                .font(.subheadline).foregroundStyle(.secondary)
                            let have = slot.printings.filter { MasterSet.have($0, owned) > 0 }.count
                            Text("\(have) of \(slot.printings.count) printings").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }
                Section {
                    ForEach(slot.printings) { p in
                        let n = MasterSet.have(p, owned)
                        HStack(spacing: 12) {
                            PrintingChip(text: p.short, have: n > 0, large: true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.label).font(.body.weight(.semibold))
                                Text(p.price.map { Fmt.money($0) } ?? "No price yet").font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                            }
                            Spacer()
                            if n > 0 {
                                HStack(spacing: 10) {
                                    Button { remove(p) } label: { Image(systemName: "minus.circle.fill").font(.title2) }
                                        .accessibilityLabel("Remove one \(p.label)")
                                    Text("\(n)").font(.body.weight(.semibold)).monospacedDigit().frame(minWidth: 18)
                                    Button { add(p) } label: { Image(systemName: "plus.circle.fill").font(.title2) }
                                        .accessibilityLabel("Add one \(p.label)")
                                }
                                .buttonStyle(.borderless)
                                .symbolRenderingMode(.hierarchical)
                            } else {
                                Button { add(p) } label: { Label("Have it", systemImage: "plus") }
                                    .buttonStyle(.borderedProminent)
                                    .buttonBorderShape(.capsule)
                                    .controlSize(.small)
                            }
                        }
                    }
                } footer: {
                    Text("Marking a printing adds a near-mint copy to your collection; edit it there for condition, grade or cost.")
                }
            }
            .navigationTitle("#\(slot.number)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Remove a graded copy?", isPresented: Binding(get: { confirmGraded != nil }, set: { if !$0 { confirmGraded = nil } }), titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    if let h = confirmGraded { take(h) }
                    confirmGraded = nil
                }
            } message: {
                if let h = confirmGraded { Text("Your \(h.grader ?? "") \(h.grade ?? "") copy leaves your collection.") }
            }
        }
    }

    private func add(_ p: MSPrinting) {
        let h = Holding(cardID: p.cardID, game: "pokemon", name: p.productName, setName: setName, number: slot.number,
                        imageURL: p.image, variant: p.variant, condition: "NM", quantity: 1, unitValue: p.price)
        h.rawPrice = p.price
        h.priceBasis = "raw"
        h.priceUpdatedAt = .now
        context.insert(h)
        saved()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// Takes one copy away: raw copies first (newest first); a graded copy only after asking.
    private func remove(_ p: MSPrinting) {
        let copies = holdings.filter { h in
            h.cardID == p.cardID && (h.variant == p.variant || (h.variant == nil && p.isRegular))
        }
        .sorted { a, b in a.isGraded != b.isGraded ? !a.isGraded : a.createdAt > b.createdAt }
        guard let h = copies.first else { return }
        if h.isGraded { confirmGraded = h } else { take(h) }
    }

    private func take(_ h: Holding) {
        if h.quantity > 1 {
            h.quantity -= 1
            h.touch()
            saved()
        } else {
            Portfolio.remove(h, context: context)
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func saved() {
        try? context.save()
        Portfolio.snapshot(context: context)
        CollectionSync.shared.syncSoon(context)
    }
}
