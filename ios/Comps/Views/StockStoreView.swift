import SwiftUI
import Charts

/// One store's history: when it restocks, how much, how long it lasts, a chart per product and every
/// change. The same as the website's store page.
struct StockStoreView: View {
    let store: StockDoc.Store
    let chainName: String
    let exact: Bool
    let names: [String: String]
    @State private var history: StockHistoryDoc?
    @State private var loaded = false
    @State private var days = 30
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(store.name).font(.title2.bold())
                    Text([chainName, store.number.map { "#\($0)" }, store.city.map { c in store.state.map { "\(c), \($0)" } ?? c }].compactMap { $0 }.joined(separator: " · "))
                        .font(.subheadline).foregroundStyle(.secondary)
                    if store.suspect != nil {
                        Text("Counts often wrong here").font(.caption.weight(.semibold)).foregroundStyle(.orange)
                    }
                }
                Button { openMaps() } label: {
                    Label("\(Stock.miles(store.distance).map { "\($0) · " } ?? "")Directions", systemImage: "mappin.and.ellipse")
                }
            }

            Section {
                Picker("Period", selection: $days) {
                    Text("7 days").tag(7)
                    Text("30 days").tag(30)
                    Text("90 days").tag(90)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } footer: {
                if let history { Text("Tracking since \(Date(timeIntervalSince1970: history.start / 1000).formatted(date: .abbreviated, time: .omitted)). Checked every 15 minutes.") }
            }

            if !loaded {
                Section { HStack { Spacer(); ProgressView(); Spacer() } }
            } else if let history {
                let now = Date().timeIntervalSince1970 * 1000
                let h = StockHistory.store(history, store.id, now: now, days: days)
                if h.products.isEmpty {
                    Section { Text("No history here yet. Changes are recorded every 15 minutes; check back after its next delivery.").foregroundStyle(.secondary) }
                } else {
                    content(h, history: history, now: now)
                }
            } else {
                Section { Text("Couldn't load the history. Check your connection.").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(store.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            history = await StockHistory.load()
            loaded = true
        }
        .refreshable { history = await StockHistory.load() }
    }

    @ViewBuilder
    private func content(_ h: StoreHistory, history: StockHistoryDoc, now: Double) -> some View {
        Section {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                StatTile(title: "Restocks", value: "\(h.restocks.count)", note: "in the last \(days) days")
                StatTile(title: "Usually restocks", value: h.usualDay.map { StockHistory.weekdays[$0] } ?? "—",
                         note: h.usualHours.map { "\(StockHistory.hour($0.0)) – \(StockHistory.hour($0.1))" } ?? "Needs a few more deliveries")
                StatTile(title: "Each restock", value: h.avgAdded.map { "+\(Int($0.rounded()))" } ?? "—", note: exact ? "on average" : "in stock / out only")
                StatTile(title: "Lasts on the shelf", value: h.avgShelf.map(StockHistory.duration) ?? "—", note: h.avgShelf == nil ? "Nothing has sold out yet" : "restock to sold out")
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }

        if !h.restocks.isEmpty {
            Section {
                Chart {
                    ForEach(0..<7, id: \.self) { i in
                        BarMark(x: .value("Day", StockHistory.weekdays[i]), y: .value("Restocks", h.weekdays[i]))
                            .foregroundStyle(i == h.usualDay ? Color.accentColor : Color.accentColor.opacity(0.4))
                            .cornerRadius(4)
                    }
                }
                .chartYAxis(.hidden)
                .frame(height: 120)
            } header: {
                HStack {
                    Text("When it restocks")
                    Spacer()
                    if let last = h.lastRestock { Text("Last \(Stock.when(last.t))").textCase(nil) }
                }
            }
        }

        Section("Products") {
            ForEach(h.products) { p in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top) {
                        Text(names[p.product] ?? history.names?[p.product] ?? "A product no longer listed")
                            .font(.subheadline.weight(.semibold))
                        Spacer(minLength: 8)
                        Text(p.now > 0 ? (exact ? "\(p.now) on hand" : "In stock") : "Sold out")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(p.now > 0 ? Color.up : Color.secondary)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background((p.now > 0 ? Color.up : Color.secondary).opacity(0.13), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                    ProductChart(p: p, from: max(now - Double(days) * 86_400_000, history.start), to: now)
                    let recent = p.restocks.filter { $0.t >= now - Double(days) * 86_400_000 }.count
                    Text([
                        "\(recent) restock\(recent == 1 ? "" : "s")",
                        p.lastRestock.map { "last \(Stock.when($0.t)) (+\($0.to - $0.from))" },
                        p.avgShelf.map { "lasts ~\(StockHistory.duration($0))" },
                    ].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
        }

        Section("Every change") {
            if h.events.isEmpty { Text("Nothing changed in this period.").foregroundStyle(.secondary) }
            ForEach(h.events.prefix(200)) { e in
                HStack(spacing: 10) {
                    Circle().fill(e.kind == .restock ? Color.up : e.kind == .soldout ? Color.down : Color.secondary.opacity(0.5)).frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(names[e.product] ?? history.names?[e.product] ?? "A product no longer listed").font(.subheadline).lineLimit(1)
                        Text(Stock.when(e.t)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 6)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(e.kind == .restock ? "+\(e.to - e.from)" : "−\(e.from - e.to)")
                            .font(.subheadline.weight(.semibold)).monospacedDigit()
                            .foregroundStyle(e.kind == .restock ? Color.up : Color.primary)
                        Text("\(e.from) → \(e.to)\(e.kind == .soldout ? " · sold out" : "")").font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            }
        }
    }

    private func openMaps() {
        let place = [chainName, store.address, store.city, store.state, store.zip].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        var parts = URLComponents(string: "https://maps.apple.com/")
        parts?.queryItems = [URLQueryItem(name: "q", value: place)]
        if let url = parts?.url { openURL(url) }
    }
}

/// How many over time: a step line with the restocks marked.
private struct ProductChart: View {
    let p: ProductHistory
    let from: Double
    let to: Double

    var body: some View {
        // The level when the period starts, each change in it, and flat to now.
        let start = p.points.last { $0.t <= from }?.n ?? 0
        let inside = p.points.filter { $0.t > from }
        let series = [(t: from, n: start)] + inside + [(t: to, n: inside.last?.n ?? start)]
        Chart {
            ForEach(Array(series.enumerated()), id: \.offset) { _, pt in
                LineMark(x: .value("Time", Date(timeIntervalSince1970: pt.t / 1000)), y: .value("On hand", pt.n))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(Color.up)
                AreaMark(x: .value("Time", Date(timeIntervalSince1970: pt.t / 1000)), y: .value("On hand", pt.n))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(Color.up.opacity(0.14))
            }
            ForEach(p.restocks.filter { $0.t >= from }) { e in
                PointMark(x: .value("Time", Date(timeIntervalSince1970: e.t / 1000)), y: .value("On hand", e.to))
                    .foregroundStyle(Color.up)
                    .symbolSize(28)
            }
        }
        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: .dateTime.month(.abbreviated).day()) } }
        .chartYAxis { AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) }
        .frame(height: 100)
    }
}
