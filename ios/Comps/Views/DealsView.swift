import SwiftUI

@MainActor
struct DealsView: View {
    @State private var tab: Pane = .undervalued
    @State private var kind: String? = nil
    @State private var sort = "profit"
    @State private var allDeals: [Deal] = []
    @State private var allSpreads: [Spread] = []
    @State private var loading = false
    @State private var error: String?

    enum Pane: String, CaseIterable { case undervalued = "Undervalued", grading = "Raw → Graded" }

    private let kinds: [(String?, String)] = [(nil, "All"), ("listing", "Listings"), ("dip", "Dips"), ("ask", "Low asks"), ("momentum", "Momentum"), ("xmarket", "Cross-market")]

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Deals")
                .navigationDestination(for: CardSummary.self) { c in CardDetailView(cardID: c.id, preview: c) }
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
                    ForEach(shownDeals.prefix(150)) { d in
                        NavigationLink(value: d.card) { DealRow(deal: d) }
                    }
                } else {
                    ForEach(shownSpreads.prefix(150)) { s in
                        NavigationLink(value: s.card) { SpreadRow(spread: s) }
                    }
                }
                if !loading && (tab == .undervalued ? shownDeals.isEmpty : shownSpreads.isEmpty) && error == nil {
                    Text(tab == .undervalued ? "Nothing under value right now." : "No profitable spreads yet. Graded prices need a PriceCharting token (see the website's Settings).")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.plain)
        .overlay { if loading && allDeals.isEmpty && allSpreads.isEmpty { ProgressView() } }
        .refreshable { await load() }
        .task(id: tab.rawValue) { await load() }
    }

    private var shownDeals: [Deal] {
        guard let kind else { return allDeals }
        return allDeals.filter { $0.kind == kind }
    }

    private var shownSpreads: [Spread] {
        let xs = allSpreads.filter { $0.profit > 0 }
        switch sort {
        case "roi": return xs.sorted { $0.roi > $1.roi }
        case "multiple": return xs.sorted { $0.multiple > $1.multiple }
        case "breakEven": return xs.sorted { ($0.breakEven ?? 9) < ($1.breakEven ?? 9) }
        default: return xs.sorted { $0.profit > $1.profit }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            if tab == .undervalued {
                let d = try await HostedData.current.deals()
                withAnimation(.snappy) { allDeals = d }
            } else {
                let s = try await HostedData.current.spreads()
                withAnimation(.snappy) { allSpreads = s }
            }
            error = nil
        } catch {
            self.error = "Couldn't load deals: \(error.localizedDescription)"
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
