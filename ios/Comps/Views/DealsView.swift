import SwiftUI

@MainActor
struct DealsView: View {
    @AppStorage(Pref.serverURL) private var serverURL = ""
    @State private var tab: Pane = .undervalued
    @State private var kind: String? = nil
    @State private var sort = "profit"
    @State private var deals: [Deal] = []
    @State private var spreads: [Spread] = []
    @State private var loading = false
    @State private var error: String?
    @State private var showSettings = false

    enum Pane: String, CaseIterable { case undervalued = "Undervalued", grading = "Raw → Graded" }

    private let kinds: [(String?, String)] = [(nil, "All"), ("listing", "Listings"), ("dip", "Dips"), ("ask", "Low asks"), ("momentum", "Momentum"), ("xmarket", "Cross-market")]

    var body: some View {
        NavigationStack {
            Group {
                if serverURL.isEmpty {
                    ContentUnavailableView {
                        Label("Connect your server", systemImage: "server.rack")
                    } description: {
                        Text("Deals come from the Comps server, which watches the whole market and live listings. Run it on your computer, then connect here.")
                    } actions: {
                        Button("Connect") { showSettings = true }.buttonStyle(.borderedProminent)
                    }
                } else {
                    content
                }
            }
            .navigationTitle("Deals")
            .navigationDestination(for: CardSummary.self) { c in CardDetailView(cardID: c.id, preview: c) }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }

    private var content: some View {
        List {
            Section {
                Picker("View", selection: $tab) { ForEach(Pane.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
                    .listRowSeparator(.hidden)
                if tab == .undervalued {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(kinds, id: \.1) { k in
                                Button {
                                    withAnimation(.snappy) { kind = k.0 }
                                } label: {
                                    Text(k.1)
                                        .font(.subheadline.weight(.medium))
                                        .padding(.horizontal, 12).padding(.vertical, 6)
                                        .foregroundStyle(kind == k.0 ? Color(.systemBackground) : .primary)
                                        .background(kind == k.0 ? Color.primary : Color(.tertiarySystemFill), in: Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                } else {
                    Picker("Sort", selection: $sort) {
                        Text("Profit").tag("profit")
                        Text("ROI").tag("roi")
                        Text("Multiple").tag("multiple")
                        Text("Break-even").tag("breakEven")
                    }
                    .pickerStyle(.segmented)
                    .listRowSeparator(.hidden)
                }
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.footnote)
            }

            Section {
                if tab == .undervalued {
                    ForEach(deals) { d in
                        NavigationLink(value: d.card) { DealRow(deal: d) }
                    }
                } else {
                    ForEach(spreads) { s in
                        NavigationLink(value: s.card) { SpreadRow(spread: s) }
                    }
                }
                if !loading && (tab == .undervalued ? deals.isEmpty : spreads.isEmpty) && error == nil {
                    Text(tab == .undervalued ? "Nothing under value right now." : "No profitable spreads yet. Graded prices need PriceCharting on the server.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.plain)
        .overlay { if loading && deals.isEmpty && spreads.isEmpty { ProgressView() } }
        .refreshable { await load() }
        .task(id: "\(tab.rawValue)|\(kind ?? "")|\(sort)|\(serverURL)") { await load() }
    }

    private func load() async {
        guard let api = APIClient.current else { return }
        loading = true
        defer { loading = false }
        do {
            if tab == .undervalued {
                let d = try await api.deals(kind: kind)
                withAnimation(.snappy) { deals = d }
            } else {
                let s = try await api.spreads(sort: sort)
                withAnimation(.snappy) { spreads = s }
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct DealRow: View {
    let deal: Deal
    var body: some View {
        HStack(spacing: 12) {
            CardImage(url: deal.card.imageURL, name: deal.card.name, game: deal.card.gameKind).frame(width: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(deal.card.name).font(.body.weight(.semibold)).lineLimit(1)
                Text(deal.reason).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                HStack(spacing: 6) {
                    Text(deal.kindLabel).font(.caption2.weight(.semibold)).foregroundStyle(.tint)
                    if let g = deal.data.grader, let gr = deal.data.grade { GradeBadge(grader: g, grade: gr) }
                }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 3) {
                Text(Fmt.money(deal.price)).font(.body.weight(.semibold).monospacedDigit())
                Text("−\(Fmt.percent(deal.discount, signed: false))").font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(Color.up)
                Text("worth \(Fmt.money(deal.value))").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct SpreadRow: View {
    let spread: Spread
    var body: some View {
        HStack(spacing: 12) {
            CardImage(url: spread.card.imageURL, name: spread.card.name, game: spread.card.gameKind).frame(width: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(spread.card.name).font(.body.weight(.semibold)).lineLimit(1)
                Text(spread.card.subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                Text("\(Fmt.money(spread.raw)) → 10: \(Fmt.money(spread.psa10))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 3) {
                Text(Fmt.signedMoney(spread.profit)).font(.body.weight(.semibold).monospacedDigit()).foregroundStyle(spread.profit >= 0 ? Color.up : Color.down)
                Text(Fmt.multiple(spread.multiple)).font(.caption.weight(.semibold))
                Text(spread.breakEven.map { $0 <= 0.005 ? "no 10 needed" : "needs \(Int(($0 * 100).rounded()))% 10s" } ?? "never profitable")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
