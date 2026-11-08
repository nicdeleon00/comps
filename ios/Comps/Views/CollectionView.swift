import SwiftUI
import SwiftData
import Charts

@MainActor
struct CollectionView: View {
    @Environment(\.modelContext) private var context
    @Query(filter: #Predicate<Holding> { $0.isTombstoned == false }, sort: \Holding.updatedAt, order: .reverse) private var holdings: [Holding]
    @Query(sort: \ValueSnapshot.day) private var snapshots: [ValueSnapshot]

    @State private var filter: Filter = .all
    @State private var sort: Sort = .value
    @State private var range: Span = .threeMonths
    @State private var selected: Date?
    @State private var refreshing = false
    @State private var editing: Holding?
    @State private var showSettings = false
    @State private var query = ""
    @AppStorage("collection.layout") private var layoutRaw = Layout.list.rawValue
    var onScan: () -> Void

    enum Filter: String, CaseIterable { case all = "All", raw = "Raw", graded = "Graded" }
    enum Sort: String, CaseIterable { case value = "Value", gain = "Gain", recent = "Recent", name = "Name", number = "Set & number" }
    enum Layout: String { case list, grid }
    enum Span: String, CaseIterable {
        case month = "1M", threeMonths = "3M", sixMonths = "6M", year = "1Y"
        var days: Int {
            switch self {
            case .month: return 30
            case .threeMonths: return 90
            case .sixMonths: return 180
            case .year: return 365
            }
        }
    }

    private var layout: Layout { Layout(rawValue: layoutRaw) ?? .list }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
    private var total: Double { holdings.reduce(0) { $0 + ($1.totalValue ?? 0) } }
    private var cost: Double { holdings.reduce(0) { $0 + ($1.totalCost ?? 0) } }
    private var costedValue: Double { holdings.filter { $0.costBasis != nil }.reduce(0) { $0 + ($1.totalValue ?? 0) } }
    private var cardCount: Int { holdings.reduce(0) { $0 + $1.quantity } }
    private var week: Double {
        holdings.reduce(0) { sum, h in
            guard let v = h.totalValue, let c = h.change7d else { return sum }
            return sum + (v - v / (1 + c))
        }
    }

    private var series: [(date: Date, value: Double)] {
        let cutoff = Calendar.current.date(byAdding: .day, value: -range.days, to: .now) ?? .distantPast
        let raw: [(Date, Double)] = snapshots.map { ($0.date, $0.value) }
        return raw.filter { $0.0 >= cutoff }.map { (date: $0.0, value: $0.1) }
    }

    /// Every word has to appear in the card's name, set, number, grade or printing.
    private func matches(_ h: Holding, _ words: [String]) -> Bool {
        let number = (h.number ?? "").lowercased()
        let hay = [h.name, h.setName ?? "", number, "#\(number)", String(number.drop { $0 == "0" }),
                   h.grader.map { "\($0) \(h.grade ?? "")" } ?? "raw \(h.condition)", h.variant.map(VariantName.label) ?? ""]
            .joined(separator: " ").lowercased()
        return words.allSatisfy { hay.contains($0) }
    }

    private var visible: [Holding] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        let list = holdings.filter { (filter == .all || (filter == .graded) == $0.isGraded) && (words.isEmpty || matches($0, words)) }
        switch sort {
        case .value: return list.sorted { ($0.totalValue ?? 0) > ($1.totalValue ?? 0) }
        case .gain: return list.sorted { ($0.gain ?? -.infinity) > ($1.gain ?? -.infinity) }
        case .recent: return list.sorted { $0.createdAt > $1.createdAt }
        case .name: return list.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        case .number:
            return list.sorted {
                ($0.setName ?? "") != ($1.setName ?? "")
                    ? ($0.setName ?? "").localizedCompare($1.setName ?? "") == .orderedAscending
                    : MasterSet.numberLess($0.number ?? "", $1.number ?? "")
            }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if holdings.isEmpty {
                    ContentUnavailableView {
                        Label("No cards yet", systemImage: "square.stack.3d.up")
                    } description: {
                        Text("Scan a stack of cards and watch your collection's value add up.")
                    } actions: {
                        Button("Scan cards", action: onScan).buttonStyle(.borderedProminent)
                    }
                } else if layout == .grid {
                    grid
                } else {
                    list
                }
            }
            .navigationTitle("Collection")
            .searchable(text: $query, prompt: "Search your cards")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        withAnimation(.snappy) { layoutRaw = layout == .list ? Layout.grid.rawValue : Layout.list.rawValue }
                    } label: {
                        Image(systemName: layout == .list ? "square.grid.2x2" : "list.bullet")
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .accessibilityLabel(layout == .list ? "Show as a grid" : "Show as a list")
                    Menu {
                        Picker("Sort", selection: $sort) { ForEach(Sort.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                    } label: { Image(systemName: "arrow.up.arrow.down") }
                    .accessibilityLabel("Sort")
                }
            }
            .navigationDestination(for: Holding.self) { h in CardDetailView(cardID: h.cardID, holding: h) }
            .refreshable { await refresh() }
            .task { await refresh() }
            .sheet(item: $editing) { h in HoldingEditor(holding: h) }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }

    // MARK: Layouts

    private var list: some View {
        let shown = visible
        return List {
            Section {
                topBlock(shown)
                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 12, trailing: 20))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(shown) { h in
                    NavigationLink(value: h) { HoldingRow(holding: h) }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { withAnimation { Portfolio.remove(h, context: context) } } label: { Label("Delete", systemImage: "trash") }
                            Button { editing = h } label: { Label("Edit", systemImage: "pencil") }.tint(.indigo)
                        }
                        .contextMenu { menu(h) }
                }
                if shown.isEmpty { noMatches.listRowSeparator(.hidden) }
            } header: {
                filterBar.textCase(nil).padding(.bottom, 6)
            }
        }
        .listStyle(.plain)
        .animation(.snappy, value: filter)
        .animation(.snappy, value: sort)
    }

    private var grid: some View {
        let shown = visible
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                topBlock(shown)
                filterBar
                if shown.isEmpty { noMatches }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 12)], spacing: 18) {
                    ForEach(shown) { h in
                        NavigationLink(value: h) { HoldingTile(holding: h) }
                            .buttonStyle(.plain)
                            .contextMenu { menu(h) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
            .animation(.snappy, value: shown.map(\.id))
        }
    }

    @ViewBuilder private func menu(_ h: Holding) -> some View {
        Button { editing = h } label: { Label("Edit", systemImage: "pencil") }
        Button(role: .destructive) { withAnimation { Portfolio.remove(h, context: context) } } label: { Label("Delete", systemImage: "trash") }
    }

    private var filterBar: some View {
        Picker("Filter", selection: $filter) { ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
            .pickerStyle(.segmented)
    }

    private var noMatches: some View {
        ContentUnavailableView.search(text: query)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
    }

    /// The value header, or a one-line summary of what the search found.
    @ViewBuilder private func topBlock(_ shown: [Holding]) -> some View {
        if searching {
            let value = shown.reduce(0) { $0 + ($1.totalValue ?? 0) }
            let count = shown.reduce(0) { $0 + $1.quantity }
            HStack(alignment: .firstTextBaseline) {
                Text("\(count) card\(count == 1 ? "" : "s") found").font(.subheadline.weight(.semibold))
                Spacer()
                Text(Fmt.money(value)).font(.title3.weight(.bold)).monospacedDigit().contentTransition(.numericText(value: value))
            }
            .animation(.snappy, value: value)
        } else {
            header
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            let shown = selected.flatMap { d in series.min(by: { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) }) }
            Text(shown.map { $0.date.formatted(date: .abbreviated, time: .omitted) } ?? "Collection value")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(Fmt.money(shown?.value ?? total))
                .font(.system(size: 42, weight: .bold, design: .rounded))
                .contentTransition(.numericText(value: shown?.value ?? total))
                .animation(.snappy, value: shown?.value ?? total)
            HStack(spacing: 8) {
                if week != 0 {
                    Text(Fmt.signedMoney(week))
                        .font(.footnote.weight(.semibold).monospacedDigit())
                        .foregroundStyle(week >= 0 ? Color.up : Color.down)
                    Text("this week").font(.footnote).foregroundStyle(.secondary)
                }
                if cost > 0 {
                    let gain = costedValue - cost
                    Text("·").foregroundStyle(.tertiary)
                    Text("\(Fmt.signedMoney(gain)) (\(Fmt.percent(gain / cost)))")
                        .font(.footnote.weight(.semibold).monospacedDigit())
                        .foregroundStyle(gain >= 0 ? Color.up : Color.down)
                    Text("all time").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if series.count > 1 {
                chart.frame(height: 160).padding(.top, 10)
                Picker("Range", selection: $range) { ForEach(Span.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
                    .padding(.top, 4)
            }
            HStack(spacing: 10) {
                StatTile(title: "Cards", value: cardCount.formatted())
                StatTile(title: "Unique", value: holdings.count.formatted())
                StatTile(title: "Graded", value: holdings.filter(\.isGraded).reduce(0) { $0 + $1.quantity }.formatted())
            }
            .padding(.top, 10)
        }
    }

    private var chart: some View {
        let up = (series.last?.value ?? 0) >= (series.first?.value ?? 0)
        let tint = up ? Color.up : Color.down
        let lo = series.map(\.value).min() ?? 0
        let hi = series.map(\.value).max() ?? 1
        let pad = max((hi - lo) * 0.15, 1)
        return Chart {
            ForEach(series, id: \.date) { p in
                AreaMark(x: .value("Day", p.date), yStart: .value("Low", lo - pad), yEnd: .value("Value", p.value))
                    .foregroundStyle(LinearGradient(colors: [tint.opacity(0.22), tint.opacity(0.0)], startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Day", p.date), y: .value("Value", p.value))
                    .foregroundStyle(tint)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.monotone)
            }
            if let selected {
                RuleMark(x: .value("Selected", selected)).foregroundStyle(.secondary.opacity(0.5)).lineStyle(StrokeStyle(lineWidth: 1))
            }
        }
        .chartYScale(domain: (lo - pad)...(hi + pad))
        .chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { v in
                AxisGridLine().foregroundStyle(.quaternary)
                AxisValueLabel { if let d = v.as(Double.self) { Text(Fmt.money(d)).font(.caption2) } }
            }
        }
        .chartXSelection(value: $selected)
        .sensoryFeedback(.selection, trigger: selected)
    }

    private func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        await Portfolio.refreshPrices(context: context)
    }
}

struct HoldingRow: View {
    let holding: Holding

    var body: some View {
        HStack(spacing: 12) {
            CardImage(url: URL(string: holding.imageURL ?? ""), name: holding.name, game: holding.gameKind)
                .frame(width: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(holding.name).font(.body.weight(.semibold)).lineLimit(1)
                    if holding.quantity > 1 {
                        Text("×\(holding.quantity)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                Text(holding.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                GradeBadge(grader: holding.grader, grade: holding.grade, condition: holding.condition)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                Text(Fmt.money(holding.totalValue))
                    .font(.body.weight(.semibold).monospacedDigit())
                    .contentTransition(.numericText(value: holding.totalValue ?? 0))
                if let gain = holding.gain {
                    Text(Fmt.signedMoney(gain)).font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(gain >= 0 ? Color.up : Color.down)
                } else {
                    DeltaLabel(value: holding.change7d)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// A card in the collection grid: the art, how many, and what it's worth.
struct HoldingTile: View {
    let holding: Holding

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            CardImage(url: URL(string: holding.imageURL ?? ""), name: holding.name, game: holding.gameKind, corner: 5)
                .cardShadow()
                .overlay(alignment: .topTrailing) {
                    if holding.quantity > 1 {
                        Text("×\(holding.quantity)")
                            .font(.caption2.weight(.heavy)).monospacedDigit()
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 3)
                            .background(.black.opacity(0.65), in: Capsule())
                            .padding(5)
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    if holding.isGraded { GradeBadge(grader: holding.grader, grade: holding.grade).background(.background, in: RoundedRectangle(cornerRadius: 5)).padding(5) }
                }
            Text(holding.name).font(.caption.weight(.semibold)).lineLimit(1)
            HStack(spacing: 4) {
                Text(Fmt.money(holding.totalValue)).font(.caption.weight(.bold)).monospacedDigit()
                Spacer(minLength: 2)
                DeltaLabel(value: holding.change7d).font(.caption2)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
